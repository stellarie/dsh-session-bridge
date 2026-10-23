import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeEndpoint } from '../src/discovery.ts'
import { createBridgeClient, createMcpServer, messagesFromRecords } from '../src/mcp.ts'
import { closeServer, listen } from './support.ts'

const TOKEN = 'mcp-test-token-abcdef'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/session-page.json', import.meta.url), 'utf8')) as {
  records: unknown[]
  hasMore: boolean
}

interface Seen {
  readonly path: string
  readonly body: unknown
  readonly authorization: string | undefined
}

type Reply = unknown | ((seen: Seen) => unknown)

let directory: string
let endpointPath: string
let fake: Server | undefined
let client: Client | undefined

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-session-bridge-mcp-'))
  endpointPath = join(directory, 'endpoint.json')
})

afterEach(async () => {
  await client?.close()
  client = undefined
  if (fake !== undefined) await closeServer(fake)
  fake = undefined
  rmSync(directory, { recursive: true, force: true })
})

/** Fake bridge: replies by path, in order, and records every request. */
async function startFakeBridge(replies: Record<string, Reply[]>): Promise<Seen[]> {
  const seen: Seen[] = []
  const queues = new Map(Object.entries(replies).map(([path, list]) => [path, [...list]]))
  fake = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const entry: Seen = {
        path: req.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        authorization: req.headers.authorization,
      }
      seen.push(entry)
      const queue = queues.get(entry.path)
      const next = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0]
      const reply = typeof next === 'function' ? (next as (s: Seen) => unknown)(entry) : next
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply ?? { ok: false, error: { code: 'fake/unscripted', message: entry.path } }))
    })
  })
  await listen(fake)
  const port = (fake.address() as AddressInfo).port
  writeEndpoint(endpointPath, { url: `http://127.0.0.1:${String(port)}`, token: TOKEN, pid: 777, startedAt: 1 })
  return seen
}

async function connect(): Promise<Client> {
  const server = createMcpServer(createBridgeClient({ endpointPath }))
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientSide)
  return client
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const connected = client ?? await connect()
  return await connected.callTool({ name, arguments: args }) as CallToolResult
}

function textOf(result: CallToolResult): string {
  const first = result.content[0]
  if (first?.type !== 'text') throw new Error('expected text content')
  return first.text
}

function jsonOf(result: CallToolResult): unknown {
  expect(result.isError).not.toBe(true)
  return JSON.parse(textOf(result))
}

const ok = (value: unknown) => ({ ok: true, value })
const rpc = (method: string) => `/session-bridge/rpc/${method}`
const workspaceCreate = '/session-bridge/rpc/workspace/create'

/** Catalog reply whose default model offers these efforts, or none. */
const catalog = (efforts: readonly string[] | null = ['high', 'max']) => ok({
  default: { provider: 'prov', model: 'mod', reasoningEffort: 'max' },
  routableProviders: ['prov'],
  groups: [{
    id: 'prov',
    name: 'Provider',
    models: [{
      id: 'mod',
      name: 'Model',
      ...efforts === null ? {} : { reasoning: { efforts: efforts.map(id => ({ id, name: id })), defaultEffort: 'max' } },
    }],
  }],
  failures: [],
})
const placed = (workspaceId = 'ws-1') => ok({ workspace: { workspaceId, path: 'C:/repo', title: 'repo', sessionIds: [] }, created: false })
const pathsOf = (seen: Seen[]) => seen.map(entry => entry.path)

describe('MCP tools (AT7)', () => {
  it('lists the six tools', async () => {
    await startFakeBridge({})
    const connected = await connect()
    const { tools } = await connected.listTools()
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'dsh_cancel', 'dsh_list_sessions', 'dsh_open_session', 'dsh_read', 'dsh_send', 'dsh_wait',
    ])
  })

  it('dsh_list_sessions sends list and maps title, preset, cwd, and running from the rows', async () => {
    const seen = await startFakeBridge({
      [rpc('list')]: [ok({ items: [
        { sessionId: 's1', updatedAt: 1, running: true, blank: false, agentAvailable: true, cwd: 'C:/work',
          projections: { kind: 'sequenced', asOfSeq: 3, values: { title: 'Fix bug', agentPreset: 'yuu' } } },
        { sessionId: 's2', updatedAt: 2, running: false, blank: true, agentAvailable: false,
          projections: { kind: 'cached', asOfSeq: 0, values: { workingDirectory: 'C:/other', title: null, agentPreset: null } } },
        { sessionId: 's3', updatedAt: 3, running: false, blank: true, agentAvailable: false },
      ] })],
    })
    const result = jsonOf(await call('dsh_list_sessions'))
    expect(seen.map(entry => [entry.path, entry.body])).toEqual([[rpc('list'), { args: { _request: {} } }]])
    expect(result).toEqual({ sessions: [
      { sessionId: 's1', title: 'Fix bug', agentPreset: 'yuu', cwd: 'C:/work', running: true },
      { sessionId: 's2', title: null, agentPreset: null, cwd: 'C:/other', running: false },
      { sessionId: 's3', title: null, agentPreset: null, cwd: null, running: false },
    ] })
  })

  it('dsh_list_sessions retries with the plain parameter name after an argument error', async () => {
    const seen = await startFakeBridge({
      [rpc('list')]: [
        { ok: false, error: { code: 'gateway/arguments-invalid', message: 'unexpected field' } },
        ok({ items: [] }),
      ],
    })
    expect(jsonOf(await call('dsh_list_sessions'))).toEqual({ sessions: [] })
    expect(seen.map(entry => entry.body)).toEqual([{ args: { _request: {} } }, { args: { request: {} } }])
  })

  it('dsh_open_session creates a yuu Session in the Workspace of cwd at high effort by default', async () => {
    const seen = await startFakeBridge({
      [rpc('modelCatalog')]: [catalog()],
      [workspaceCreate]: [placed()],
      [rpc('create')]: [ok({ sessionId: 'new-1', agentPreset: 'yuu' })],
      [rpc('selectModel')]: [ok({ selected: {} })],
    })
    expect(jsonOf(await call('dsh_open_session', { cwd: 'C:/repo', reuse: false })))
      .toEqual({ sessionId: 'new-1', reused: false, workspaceId: 'ws-1', effort: 'high' })
    expect(pathsOf(seen)).toEqual([rpc('modelCatalog'), workspaceCreate, rpc('create'), rpc('selectModel')])
    expect(seen[1]?.body).toEqual({ args: { request: { path: 'C:/repo' } } })
    expect(seen[2]?.body).toEqual({ args: { request: { workspaceId: 'ws-1', agentPreset: 'yuu' } } })
    expect(seen[3]?.body).toEqual({
      args: { request: { sessionId: 'new-1', provider: 'prov', model: 'mod', reasoningEffort: 'high' } },
    })
  })

  it('dsh_open_session passes a custom preset and effort through', async () => {
    const seen = await startFakeBridge({
      [rpc('modelCatalog')]: [catalog()],
      [workspaceCreate]: [placed('ws-9')],
      [rpc('create')]: [ok({ sessionId: 'new-3' })],
      [rpc('selectModel')]: [ok({ selected: {} })],
    })
    const result = jsonOf(await call('dsh_open_session', { cwd: 'C:/repo', preset: 'other', effort: 'max', reuse: false }))
    expect(result).toEqual({ sessionId: 'new-3', reused: false, workspaceId: 'ws-9', effort: 'max' })
    expect(seen[2]?.body).toEqual({ args: { request: { workspaceId: 'ws-9', agentPreset: 'other' } } })
    expect((seen[3]?.body as { args: { request: Record<string, unknown> } }).args.request['reasoningEffort']).toBe('max')
  })

  it('dsh_open_session never sends cwd and workspaceId together', async () => {
    const seen = await startFakeBridge({
      [rpc('modelCatalog')]: [catalog()],
      [workspaceCreate]: [placed()],
      [rpc('create')]: [ok({ sessionId: 'new-4' })],
      [rpc('selectModel')]: [ok({ selected: {} })],
    })
    await call('dsh_open_session', { cwd: 'C:/repo', reuse: false })
    const create = (seen.find(entry => entry.path === rpc('create'))?.body as { args: { request: Record<string, unknown> } }).args.request
    expect(Object.keys(create).sort()).toEqual(['agentPreset', 'workspaceId'])
  })

  it('dsh_open_session rejects an unknown effort before it creates a Workspace or Session', async () => {
    const seen = await startFakeBridge({ [rpc('modelCatalog')]: [catalog(['high', 'max'])] })
    const result = await call('dsh_open_session', { cwd: 'C:/repo', effort: 'turbo', reuse: false })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('bridge/effort-unsupported')
    expect(textOf(result)).toContain('high, max')
    expect(pathsOf(seen)).toEqual([rpc('modelCatalog')])
  })

  it('dsh_open_session skips effort when the default model has no efforts', async () => {
    const seen = await startFakeBridge({
      [rpc('modelCatalog')]: [catalog(null)],
      [workspaceCreate]: [placed()],
      [rpc('create')]: [ok({ sessionId: 'new-5' })],
    })
    expect(jsonOf(await call('dsh_open_session', { cwd: 'C:/repo', reuse: false })))
      .toEqual({ sessionId: 'new-5', reused: false, workspaceId: 'ws-1', effort: null })
    expect(pathsOf(seen)).toEqual([rpc('modelCatalog'), workspaceCreate, rpc('create')])
  })

  it('dsh_open_session names the opened Session when setting effort fails', async () => {
    await startFakeBridge({
      [rpc('modelCatalog')]: [catalog()],
      [workspaceCreate]: [placed()],
      [rpc('create')]: [ok({ sessionId: 'new-6' })],
      [rpc('selectModel')]: [{ ok: false, error: { code: 'session/model-unavailable', message: 'gone' } }],
    })
    const result = await call('dsh_open_session', { cwd: 'C:/repo', reuse: false })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('bridge/effort-failed')
    expect(textOf(result)).toContain('new-6')
    expect(textOf(result)).toContain('session/model-unavailable')
  })

  it('dsh_open_session reports a Workspace failure without creating a Session', async () => {
    const seen = await startFakeBridge({
      [rpc('modelCatalog')]: [catalog()],
      [workspaceCreate]: [{ ok: false, error: { code: 'workspace/invalid-path', message: 'no such directory' } }],
      [rpc('create')]: [ok({ sessionId: 'never' })],
    })
    const result = await call('dsh_open_session', { cwd: 'C:/missing', reuse: false })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('workspace/invalid-path')
    expect(pathsOf(seen)).toEqual([rpc('modelCatalog'), workspaceCreate])
  })

  it('dsh_open_session reuses the newest idle Session with the same preset and cwd', async () => {
    const row = (sessionId: string, updatedAt: number, agentPreset: string, cwd: string, running = false) =>
      ({ sessionId, updatedAt, running, cwd, projections: { kind: 'sequenced', asOfSeq: 1, values: { agentPreset } } })
    const seen = await startFakeBridge({
      [rpc('list')]: [ok({ items: [
        row('old', 1, 'yuu', 'C:/Repo/'),
        row('busy', 9, 'yuu', 'C:/repo', true),
        row('other-preset', 8, 'standard', 'C:/repo'),
        row('other-cwd', 7, 'yuu', 'C:/elsewhere'),
        row('newest', 5, 'yuu', 'C:\\repo'),
      ] })],
    })
    expect(jsonOf(await call('dsh_open_session', { cwd: 'c:/repo' }))).toEqual({ sessionId: 'newest', reused: true })
    expect(seen.map(entry => entry.path)).toEqual([rpc('list')])
  })

  it('dsh_open_session creates a Session when none can be reused', async () => {
    const seen = await startFakeBridge({
      [rpc('list')]: [ok({ items: [
        { sessionId: 'busy', updatedAt: 1, running: true, cwd: 'C:/repo', projections: { kind: 'sequenced', asOfSeq: 1, values: { agentPreset: 'yuu' } } },
      ] })],
      [rpc('modelCatalog')]: [catalog()],
      [workspaceCreate]: [placed()],
      [rpc('create')]: [ok({ sessionId: 'new-2' })],
      [rpc('selectModel')]: [ok({ selected: {} })],
    })
    expect(jsonOf(await call('dsh_open_session', { cwd: 'C:/repo' })))
      .toEqual({ sessionId: 'new-2', reused: false, workspaceId: 'ws-1', effort: 'high' })
    expect(pathsOf(seen)).toEqual([rpc('list'), rpc('modelCatalog'), workspaceCreate, rpc('create'), rpc('selectModel')])
  })

  it('dsh_send reads asOfSeq first, then prompts with a fresh requestId, and returns afterSeq', async () => {
    const seen = await startFakeBridge({
      [rpc('projections')]: [ok({ kind: 'sequenced', asOfSeq: 41, values: {} })],
      [rpc('prompt')]: [ok({ accepted: true })],
    })
    const result = jsonOf(await call('dsh_send', { sessionId: 's1', text: 'What is 6*7? Use a shell tool.' }))
    expect(result).toEqual({ accepted: true, afterSeq: 41 })
    expect(seen.map(entry => entry.path)).toEqual([rpc('projections'), rpc('prompt')])
    expect(seen[0]?.body).toEqual({ args: { request: { sessionId: 's1' } } })
    const prompt = (seen[1]?.body as { args: { request: Record<string, unknown> } }).args.request
    expect(prompt).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      sessionId: 's1',
      mode: 'queue',
      content: [{ type: 'text', text: 'What is 6*7? Use a shell tool.' }],
    })
    await call('dsh_send', { sessionId: 's1', text: 'again', mode: 'steer' })
    const second = (seen[3]?.body as { args: { request: Record<string, unknown> } }).args.request
    expect(second['mode']).toBe('steer')
    expect(second['requestId']).not.toBe(prompt['requestId'])
  })

  it('dsh_send reports an unknown Session without prompting', async () => {
    const seen = await startFakeBridge({ [rpc('projections')]: [ok(null)], [rpc('prompt')]: [ok({ accepted: true })] })
    const result = await call('dsh_send', { sessionId: 'ghost', text: 'hi' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('ghost')
    expect(seen.map(entry => entry.path)).toEqual([rpc('projections')])
  })

  it('dsh_wait posts the wait request in milliseconds and maps ended and timedOut', async () => {
    const seen = await startFakeBridge({
      '/session-bridge/wait': [
        ok({ ended: true, lastSeq: 17 }),
        ok({ ended: false, timedOut: true, lastSeq: 12 }),
      ],
    })
    expect(jsonOf(await call('dsh_wait', { sessionId: 's1', afterSeq: 5, timeoutSec: 30 }))).toEqual({ ended: true, timedOut: false, lastSeq: 17 })
    expect(seen[0]?.body).toEqual({ sessionId: 's1', afterSeq: 5, timeoutMs: 30_000 })
    expect(jsonOf(await call('dsh_wait', { sessionId: 's1', afterSeq: 5, timeoutSec: 0 }))).toEqual({ ended: false, timedOut: true, lastSeq: 12 })
    expect(seen[1]?.body).toEqual({ sessionId: 's1', afterSeq: 5, timeoutMs: 0 })
  })

  it('dsh_wait defaults to 600 seconds and splits the wait into requests below the client timeout', async () => {
    const seen = await startFakeBridge({ '/session-bridge/wait': [ok({ ended: true, lastSeq: 1 })] })
    await call('dsh_wait', { sessionId: 's1', afterSeq: 0 })
    const body = seen[0]?.body as { timeoutMs: number }
    expect(body.timeoutMs).toBeGreaterThan(0)
    expect(body.timeoutMs).toBeLessThanOrEqual(240_000)
  })

  it('dsh_read maps user and assistant text after afterSeq and skips unknown events and reasoning-only turns', async () => {
    const seen = await startFakeBridge({
      [rpc('projections')]: [ok({ kind: 'sequenced', asOfSeq: 17, values: {} })],
      [rpc('page')]: [ok(fixture)],
    })
    const result = jsonOf(await call('dsh_read', { sessionId: 's1', afterSeq: 5 }))
    expect(result).toEqual({
      messages: [
        { seq: 7, role: 'user', text: 'What is 6*7? Use a shell tool.' },
        { seq: 14, role: 'assistant', text: '6*7 = 42' },
      ],
      lastSeq: 17,
      hasMore: false,
    })
    expect(seen[1]?.body).toEqual({
      args: { request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: 17, maxMessages: 50 } },
    })
  })

  it('dsh_cancel sends cancel and maps accepted', async () => {
    const seen = await startFakeBridge({ [rpc('cancel')]: [ok({ accepted: true })] })
    expect(jsonOf(await call('dsh_cancel', { sessionId: 's1' }))).toEqual({ accepted: true })
    expect(seen[0]?.body).toEqual({ args: { request: { sessionId: 's1' } } })
  })

  it('sends the bearer token from the endpoint file and re-reads the file on every call', async () => {
    const seen = await startFakeBridge({ [rpc('cancel')]: [ok({ accepted: true })] })
    await call('dsh_cancel', { sessionId: 's1' })
    expect(seen[0]?.authorization).toBe(`Bearer ${TOKEN}`)
    const port = (fake?.address() as AddressInfo).port
    writeEndpoint(endpointPath, { url: `http://127.0.0.1:${String(port)}`, token: 'rotated-token', pid: 778, startedAt: 2 })
    await call('dsh_cancel', { sessionId: 's1' })
    expect(seen[1]?.authorization).toBe('Bearer rotated-token')
  })

  it('maps a bridge error to a tool error with the bridge code and message', async () => {
    await startFakeBridge({
      [rpc('prompt')]: [{ ok: false, error: { code: 'session/agent-busy', message: 'The agent is busy.' } }],
      [rpc('projections')]: [ok({ kind: 'sequenced', asOfSeq: 1, values: {} })],
    })
    const result = await call('dsh_send', { sessionId: 's1', text: 'hi' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('session/agent-busy: The agent is busy.')
  })

  it('returns a clear tool error when the endpoint file is missing', async () => {
    const result = await call('dsh_list_sessions')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('endpoint file not found')
    expect(textOf(result)).toContain(endpointPath)
  })

  it('reports the url and pid of a stale endpoint file when the connection fails, without the token', async () => {
    await startFakeBridge({})
    await closeServer(fake!)
    fake = undefined
    const result = await call('dsh_list_sessions')
    expect(result.isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('bridge/unreachable')
    expect(text).toContain('pid 777')
    expect(text).toContain('127.0.0.1')
    expect(text).not.toContain(TOKEN)
  })

  it('reports a non-JSON bridge reply as a tool error', async () => {
    fake = createServer((_req, res) => { res.writeHead(502).end('<html>bad gateway</html>') })
    await listen(fake)
    const port = (fake.address() as AddressInfo).port
    writeEndpoint(endpointPath, { url: `http://127.0.0.1:${String(port)}`, token: TOKEN, pid: 1, startedAt: 1 })
    const result = await call('dsh_cancel', { sessionId: 's1' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('bridge/bad-reply')
  })
})

describe('message mapping', () => {
  const userMessage = (seq: number, text: string, source?: unknown) => ({
    type: 'event',
    event: {
      type: 'user/message',
      seq,
      time: 0,
      surfaceOp: 'append',
      data: { id: `m${String(seq)}`, role: 'user', content: [{ type: 'text', text }], ...source === undefined ? {} : { source } },
    },
  })

  it('keeps a caller prompt and drops the user message the app injected', () => {
    const records = [
      userMessage(1, 'Hello again. Real task this time.', { kind: 'user', rpcId: '9bd11e66-7fa1-46fd-81a1-44b2dc48e979' }),
      userMessage(2, 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.', { kind: 'runtime-context' }),
    ]
    expect(messagesFromRecords(records, 0)).toEqual([
      { seq: 1, role: 'user', text: 'Hello again. Real task this time.' },
    ])
  })

  it('keeps a user message that carries no source marker', () => {
    expect(messagesFromRecords([userMessage(1, 'Hello')], 0)).toEqual([{ seq: 1, role: 'user', text: 'Hello' }])
  })

  it('keeps only append-surface text of user and assistant events after the cut', () => {
    const event = (seq: number, type: string, data: unknown, surfaceOp?: string) => ({
      type: 'event', event: { type, seq, time: 0, data, ...surfaceOp === undefined ? {} : { surfaceOp } },
    })
    const content = (text: string) => [{ type: 'text', text }]
    const records = [
      event(1, 'user/message', { content: content('old') }, 'append'),
      event(2, 'user/message', { content: content('rewritten') }, 'replace'),
      event(3, 'assistant/message', { message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }, 'append'),
      event(4, 'assistant/message', { message: { content: [{ type: 'image' }] } }, 'append'),
      event(5, 'something/else', { content: content('ignored') }),
      { type: 'not-an-event' },
      event(6, 'assistant/message', 'garbage', 'append'),
    ]
    expect(messagesFromRecords(records, 1)).toEqual([{ seq: 3, role: 'assistant', text: 'a\nb' }])
    expect(messagesFromRecords(undefined, 0)).toEqual([])
  })
})
