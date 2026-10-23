#!/usr/bin/env node
/**
 * Stdio MCP server that drives Sessions of a running DeepSeek Harness app
 * through the session bridge. It reads the endpoint file on every call, so
 * an app restart needs no MCP restart.
 *
 * @module @stellarie/dsh-session-bridge/mcp
 */

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { EndpointError, readEndpoint, resolveEndpointPath } from './discovery.ts'

/** Longest single wait request. The HTTP client gives up on silent requests after five minutes. */
const WAIT_CHUNK_MS = 240_000
const DEFAULT_WAIT_SECONDS = 600
const DEFAULT_EFFORT = 'high'

/** A bridge or transport failure that a tool reports as an MCP tool error. */
export class BridgeToolError extends Error {
  override readonly name = 'BridgeToolError'
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Calls bridge routes with the current endpoint file. */
export interface BridgeClient {
  /**
   * POST a JSON body to a bridge path.
   * @param path - path below the server origin.
   * @param body - JSON request body.
   * @returns the `value` of an `ok` reply.
   * @throws {BridgeToolError} for a bridge failure, a missing endpoint file, or a connection failure.
   */
  post(path: string, body: unknown): Promise<unknown>
}

/** Options for {@link createBridgeClient}. */
export interface BridgeClientOptions {
  /** Endpoint file path (default from the environment and home directory). */
  readonly endpointPath?: string
  /** Fetch implementation; tests substitute a fake. */
  readonly fetch?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build a client that reads the endpoint file on every call.
 * @param options - endpoint path and fetch override.
 * @returns the bridge client.
 */
export function createBridgeClient(options: BridgeClientOptions = {}): BridgeClient {
  const doFetch = options.fetch ?? fetch
  return {
    async post(path, body) {
      let endpoint
      try {
        endpoint = readEndpoint(resolveEndpointPath(options.endpointPath))
      } catch (error) {
        if (error instanceof EndpointError) throw new BridgeToolError('bridge/no-endpoint', error.message)
        throw error
      }
      let response: Response
      try {
        response = await doFetch(`${endpoint.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
          body: JSON.stringify(body),
        })
      } catch (error) {
        const cause = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code ?? error.message : 'unknown error'
        throw new BridgeToolError(
          'bridge/unreachable',
          `Cannot reach the session bridge at ${endpoint.url} (${cause}). The endpoint file was written by pid ${String(endpoint.pid)} and may be stale; restart the app or check that it runs.`,
        )
      }
      let reply: unknown
      try {
        reply = await response.json()
      } catch {
        throw new BridgeToolError('bridge/bad-reply', `The session bridge answered HTTP ${String(response.status)} with a body that is not JSON.`)
      }
      if (isRecord(reply) && reply['ok'] === true) return reply['value']
      if (isRecord(reply) && isRecord(reply['error'])) {
        const { code, message } = reply['error']
        throw new BridgeToolError(typeof code === 'string' ? code : 'bridge/error', typeof message === 'string' ? message : 'Bridge call failed.')
      }
      throw new BridgeToolError('bridge/bad-reply', `The session bridge answered HTTP ${String(response.status)} with an unexpected body.`)
    },
  }
}

/** One message row returned by `dsh_read`. */
export interface ReadMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly text: string
}

function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
  }
  return parts.join('\n')
}

/** True when the app wrote this user message instead of a caller sending it. */
function isAppInjected(source: unknown): boolean {
  return isRecord(source) && typeof source['kind'] === 'string' && source['kind'] !== 'user'
}

/**
 * Map history records to readable messages. Unknown event types are skipped.
 * @param records - `session/page` records.
 * @param afterSeq - keep events with a larger seq.
 * @returns the caller prompts and assistant replies that carry text.
 */
export function messagesFromRecords(records: unknown, afterSeq: number): ReadMessage[] {
  if (!Array.isArray(records)) return []
  const messages: ReadMessage[] = []
  for (const record of records) {
    if (!isRecord(record) || !isRecord(record['event'])) continue
    const event = record['event']
    const seq = event['seq']
    if (typeof seq !== 'number' || seq <= afterSeq) continue
    // A replace or shadow op rewrites older surface nodes; it is not new conversation.
    if (event['surfaceOp'] !== undefined && event['surfaceOp'] !== 'append') continue
    const data = event['data']
    if (!isRecord(data)) continue
    if (event['type'] === 'user/message') {
      if (isAppInjected(data['source'])) continue
      const text = textOfBlocks(data['content'])
      if (text !== '') messages.push({ seq, role: 'user', text })
    } else if (event['type'] === 'assistant/message') {
      const message = data['message']
      const text = isRecord(message) ? textOfBlocks(message['content']) : ''
      if (text !== '') messages.push({ seq, role: 'assistant', text })
    }
  }
  return messages
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function rpc(client: BridgeClient, method: string, args: Record<string, unknown>): Promise<unknown> {
  return client.post(`/session-bridge/rpc/${method}`, { args })
}

function workspaceRpc(client: BridgeClient, method: string, args: Record<string, unknown>): Promise<unknown> {
  return client.post(`/session-bridge/rpc/workspace/${method}`, { args })
}

interface EffortPlan {
  readonly provider: string
  readonly model: string
  readonly effort: string
}

/**
 * Check an effort against the default model of the app catalog.
 * @param catalog - `modelCatalog` reply.
 * @param effort - requested reasoning effort.
 * @returns the selection to apply, or undefined when the default model has no efforts.
 * @throws {BridgeToolError} when the model offers efforts and the request is not one of them.
 */
export function planEffort(catalog: unknown, effort: string): EffortPlan | undefined {
  const fallback = isRecord(catalog) ? catalog['default'] : undefined
  const provider = isRecord(fallback) ? stringOf(fallback['provider']) : null
  const model = isRecord(fallback) ? stringOf(fallback['model']) : null
  if (provider === null || model === null) {
    throw new BridgeToolError('bridge/bad-reply', 'The model catalog has no default model.')
  }
  const groups = isRecord(catalog) && Array.isArray(catalog['groups']) ? catalog['groups'] as unknown[] : []
  const group = groups.find(item => isRecord(item) && item['id'] === provider)
  const models = isRecord(group) && Array.isArray(group['models']) ? group['models'] as unknown[] : []
  const entry = models.find(item => isRecord(item) && item['id'] === model)
  const reasoning = isRecord(entry) ? entry['reasoning'] : undefined
  const efforts = isRecord(reasoning) && Array.isArray(reasoning['efforts'])
    ? (reasoning['efforts'] as unknown[]).flatMap(item => isRecord(item) && typeof item['id'] === 'string' ? [item['id']] : [])
    : []
  if (efforts.length === 0) return undefined
  if (!efforts.includes(effort)) {
    throw new BridgeToolError(
      'bridge/effort-unsupported',
      `The default model ${provider}/${model} offers these efforts: ${efforts.join(', ')}. Got "${effort}".`,
    )
  }
  return { provider, model, effort }
}

async function asOfSeq(client: BridgeClient, sessionId: string): Promise<number> {
  const projections = await rpc(client, 'projections', { request: { sessionId } })
  const seq = isRecord(projections) ? numberOf(projections['asOfSeq']) : undefined
  if (seq === undefined) {
    throw new BridgeToolError('bridge/session-unavailable', isRecord(projections) ? 'Session projections need a migration first.' : `Session ${sessionId} was not found.`)
  }
  return seq
}

/** Gateway codes for a wrong argument shape. */
const ARGUMENT_CODES = new Set(['gateway/arguments-invalid', 'gateway/bad-request'])

interface SessionRow {
  sessionId: unknown
  title: string | null
  agentPreset: string | null
  cwd: string | null
  running: boolean
  updatedAt: number
}

async function listSessions(client: BridgeClient): Promise<SessionRow[]> {
  let value: unknown
  try {
    // The Remote method names its parameter `_request`, which is the wire field.
    value = await rpc(client, 'list', { _request: {} })
  } catch (error) {
    if (!(error instanceof BridgeToolError) || !ARGUMENT_CODES.has(error.code)) throw error
    value = await rpc(client, 'list', { request: {} })
  }
  const items = isRecord(value) && Array.isArray(value['items']) ? value['items'] as unknown[] : []
  return items.filter(isRecord).map((item) => {
    const projections = isRecord(item['projections']) ? item['projections'] : {}
    const values = isRecord(projections['values']) ? projections['values'] : {}
    return {
      sessionId: item['sessionId'],
      title: stringOf(values['title']),
      agentPreset: stringOf(values['agentPreset']),
      cwd: stringOf(item['cwd']) ?? stringOf(values['workingDirectory']),
      running: item['running'] === true,
      updatedAt: numberOf(item['updatedAt']) ?? 0,
    }
  })
}

function sameDirectory(left: string | null, right: string): boolean {
  if (left === null) return false
  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(left) === norm(right)
}

/** Pick the newest idle Session with this preset and cwd. */
export function reusableSession(sessions: SessionRow[], cwd: string, preset: string): string | undefined {
  const match = sessions
    .filter(row => !row.running && row.agentPreset === preset && sameDirectory(row.cwd, cwd))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return typeof match?.sessionId === 'string' ? match.sessionId : undefined
}

async function waitForTurn(client: BridgeClient, sessionId: string, afterSeq: number, timeoutSec: number) {
  const deadline = Date.now() + timeoutSec * 1000
  let lastSeq = afterSeq
  while (true) {
    const remaining = Math.max(0, deadline - Date.now())
    const value = await client.post('/session-bridge/wait', {
      sessionId,
      afterSeq,
      timeoutMs: Math.min(remaining, WAIT_CHUNK_MS),
    })
    const reply = isRecord(value) ? value : {}
    lastSeq = numberOf(reply['lastSeq']) ?? lastSeq
    if (reply['ended'] === true) return { ended: true, timedOut: false, lastSeq }
    if (reply['timedOut'] !== true) throw new BridgeToolError('bridge/bad-reply', 'The session bridge wait reply has neither ended nor timedOut.')
    if (deadline - Date.now() <= 0) return { ended: false, timedOut: true, lastSeq }
  }
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function errorResult(error: unknown): CallToolResult {
  const text = error instanceof BridgeToolError
    ? `${error.code}: ${error.message}`
    : `bridge/internal: ${error instanceof Error ? error.message : 'unknown error'}`
  return { isError: true, content: [{ type: 'text', text }] }
}

async function guarded(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await run())
  } catch (error) {
    return errorResult(error)
  }
}

/**
 * Build the MCP server with the six session tools.
 * @param client - bridge client.
 * @returns the unconnected server.
 */
export function createMcpServer(client: BridgeClient): McpServer {
  const server = new McpServer({ name: 'dsh-session-bridge', version: '0.1.0' })
  const sessionId = z.string().min(1).describe('Session id from dsh_open_session or dsh_list_sessions.')

  server.registerTool('dsh_list_sessions', {
    description: 'List Sessions of the running DeepSeek Harness app: id, title, agent preset, working directory, and whether a turn runs.',
    inputSchema: {},
  }, () => guarded(async () => ({
    sessions: (await listSessions(client)).map(({ updatedAt: _updatedAt, ...row }) => row),
  })))

  server.registerTool('dsh_open_session', {
    description: 'Open a Session in the Workspace of a directory. By default it reuses the newest idle Session with the same preset and cwd. Set reuse to false for a new Session. A new Session joins the Workspace of cwd, which the app creates when none exists. It starts at the requested effort, and the app also saves that effort as its default model selection.',
    inputSchema: {
      cwd: z.string().min(1).describe('Absolute path of the target Workspace directory. It must exist.'),
      preset: z.string().min(1).default('yuu').describe('Agent preset id.'),
      reuse: z.boolean().default(true).describe('Reuse an idle Session with the same preset and cwd. A reused Session keeps its effort.'),
      effort: z.string().min(1).default(DEFAULT_EFFORT).describe('Reasoning effort for a new Session, such as high or max.'),
    },
  }, ({ cwd, preset, reuse, effort }) => guarded(async () => {
    if (reuse) {
      const existing = reusableSession(await listSessions(client), cwd, preset)
      if (existing !== undefined) return { sessionId: existing, reused: true }
    }
    const plan = planEffort(await rpc(client, 'modelCatalog', {}), effort)
    const placed = await workspaceRpc(client, 'create', { request: { path: cwd } })
    const workspace = isRecord(placed) && isRecord(placed['workspace']) ? placed['workspace'] : undefined
    const workspaceId = workspace === undefined ? null : stringOf(workspace['workspaceId'])
    if (workspaceId === null) throw new BridgeToolError('bridge/bad-reply', `The app returned no Workspace for ${cwd}.`)
    const value = await rpc(client, 'create', { request: { workspaceId, agentPreset: preset } })
    const sessionId = isRecord(value) ? value['sessionId'] : undefined
    if (plan !== undefined) {
      try {
        await rpc(client, 'selectModel', { request: { sessionId, provider: plan.provider, model: plan.model, reasoningEffort: plan.effort } })
      } catch (error) {
        const detail = error instanceof BridgeToolError ? `${error.code}: ${error.message}` : String(error)
        throw new BridgeToolError('bridge/effort-failed', `Session ${String(sessionId)} was opened in Workspace ${workspaceId}, but its effort was not set. ${detail}`)
      }
    }
    return { sessionId, reused: false, workspaceId, effort: plan?.effort ?? null }
  }))

  server.registerTool('dsh_send', {
    description: 'Send a user message to a Session. Returns afterSeq: pass it to dsh_wait and dsh_read to see only the new work.',
    inputSchema: {
      sessionId,
      text: z.string().min(1).describe('Message text.'),
      mode: z.enum(['queue', 'steer']).default('queue').describe('queue runs after the current turn; steer joins the running turn.'),
    },
  }, ({ sessionId: id, text, mode }) => guarded(async () => {
    const afterSeq = await asOfSeq(client, id)
    const value = await rpc(client, 'prompt', {
      request: { requestId: randomUUID(), sessionId: id, mode, content: [{ type: 'text', text }] },
    })
    return { accepted: isRecord(value) && value['accepted'] === true, afterSeq }
  }))

  server.registerTool('dsh_wait', {
    description: 'Wait until the Session ends a turn after afterSeq, or until the timeout.',
    inputSchema: {
      sessionId,
      afterSeq: z.number().int().min(-1).describe('The afterSeq that dsh_send returned.'),
      timeoutSec: z.number().min(0).max(600).default(DEFAULT_WAIT_SECONDS).describe('Longest wait in seconds.'),
    },
  }, ({ sessionId: id, afterSeq, timeoutSec }) => guarded(() => waitForTurn(client, id, afterSeq, timeoutSec)))

  server.registerTool('dsh_read', {
    description: 'Read caller prompts and assistant text messages of a Session with seq greater than afterSeq. Messages the app injects, tool calls, and thinking are not included.',
    inputSchema: {
      sessionId,
      afterSeq: z.number().int().min(-1).describe('Return messages after this seq. Use -1 for the start.'),
      maxMessages: z.number().int().min(1).max(500).default(50).describe('Newest messages to consider.'),
    },
  }, ({ sessionId: id, afterSeq, maxMessages }) => guarded(async () => {
    const throughSeq = await asOfSeq(client, id)
    const page = await rpc(client, 'page', {
      request: { address: { kind: 'session', sessionId: id }, throughSeq, maxMessages },
    })
    const records = isRecord(page) ? page['records'] : undefined
    return {
      messages: messagesFromRecords(records, afterSeq),
      lastSeq: throughSeq,
      hasMore: isRecord(page) && page['hasMore'] === true,
    }
  }))

  server.registerTool('dsh_cancel', {
    description: 'Interrupt the running turn of a Session. Queued messages stay queued.',
    inputSchema: { sessionId },
  }, ({ sessionId: id }) => guarded(async () => {
    const value = await rpc(client, 'cancel', { request: { sessionId: id } })
    return { accepted: isRecord(value) && value['accepted'] === true }
  }))

  return server
}

/** Run the stdio server until the transport closes. */
export async function main(): Promise<void> {
  const server = createMcpServer(createBridgeClient())
  await server.connect(new StdioServerTransport())
}

function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    process.stderr.write(`dsh-session-bridge-mcp: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
