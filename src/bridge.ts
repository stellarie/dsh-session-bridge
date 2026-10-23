/**
 * Loopback HTTP bridge from local MCP clients to the Session Remote methods.
 * Every request needs a bearer token, a loopback `Host`, and no `Origin`.
 * Only an allowlist of Session methods, and Workspace `create`, reaches the Typert Gateway.
 *
 * @module @stellarie/dsh-session-bridge/bridge
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { InvokeRemoteRequest, TypertGateway } from '@deepseek-ai/dsh-api-gateway'

/** Route prefix registered on the app web server. */
export const ROUTE_PREFIX = '/session-bridge'
/** Session Remote methods the bridge forwards. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'create', 'prompt', 'page', 'projections', 'list', 'cancel', 'selectModel', 'modelCatalog',
])
/** Workspace Remote methods the bridge forwards, under `/rpc/workspace/`. */
export const ALLOWED_WORKSPACE_METHODS: ReadonlySet<string> = new Set(['create'])
/** Largest request body in bytes. */
export const MAX_BODY_BYTES = 1024 * 1024
/** Longest `wait` deadline in milliseconds. */
export const MAX_WAIT_MS = 600_000
/** Milliseconds between `wait` polls. */
export const POLL_INTERVAL_MS = 500

/** Failure body of every bridge response. */
export interface BridgeFailure {
  readonly code: string
  readonly message: string
}

/** Everything the handler needs from the host. */
export interface BridgeOptions {
  /** Bearer token that every request must present. */
  readonly token: string
  /** Typert Gateway; only `invoke` is used. */
  readonly gateway: Pick<TypertGateway, 'invoke'>
  /** Peer that speaks for every forwarded call. */
  readonly peer: InvokeRemoteRequest['peer']
  /** Port of the listening web server, used for the `Host` check. */
  readonly port: () => number | undefined
  /** Milliseconds between `wait` polls (default 500). */
  readonly pollIntervalMs?: number
}

/** A node:http request handler. */
export type BridgeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** Transport-level refusal answered with its own HTTP status. */
class BridgeHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/** Business-level failure answered with HTTP 200 and `ok: false`, like a gateway error. */
class BridgeCallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/**
 * Whether a `Host` header names a loopback authority on the server port.
 * @param host - raw `Host` header value.
 * @param port - listening port.
 * @returns true for `127.0.0.1`, `localhost`, or `[::1]` with that port.
 */
export function isLoopbackHostHeader(host: string | undefined, port: number | undefined): boolean {
  if (host === undefined || port === undefined) return false
  const authority = host.toLowerCase()
  const suffix = `:${String(port)}`
  return authority === `127.0.0.1${suffix}` || authority === `localhost${suffix}` || authority === `[::1]${suffix}`
}

function tokenMatches(presented: string, expected: string): boolean {
  // Digests have equal length, so the comparison leaks nothing about the token length.
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const match = /^Bearer (.+)$/.exec(header)
  return match?.[1]
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { ok: false, error: { code, message } satisfies BridgeFailure })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type']
  if (type === undefined || !/^application\/json\s*(;|$)/i.test(type)) {
    throw new BridgeHttpError(415, 'bridge/unsupported-media-type', 'Content-Type must be application/json.')
  }
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BridgeHttpError(413, 'bridge/too-large', 'Request body is too large.')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of req) {
    const part = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    length += part.byteLength
    if (length > MAX_BODY_BYTES) throw new BridgeHttpError(413, 'bridge/too-large', 'Request body is too large.')
    chunks.push(part)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BridgeHttpError(400, 'bridge/bad-request', 'Request body is not valid JSON.')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failureOf(error: unknown): BridgeFailure {
  if (isRecord(error) || error instanceof Error) {
    const record = error as { code?: unknown; message?: unknown }
    return {
      code: typeof record.code === 'string' ? record.code : 'bridge/internal',
      message: typeof record.message === 'string' ? record.message : 'Gateway call failed.',
    }
  }
  return { code: 'bridge/internal', message: 'Gateway call failed.' }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Build the request handler for the `/session-bridge` prefix route.
 * @param options - token, gateway, peer, and server port.
 * @returns the handler to register on the web server.
 */
export function createBridgeHandler(options: BridgeOptions): BridgeHandler {
  const pollMs = options.pollIntervalMs ?? POLL_INTERVAL_MS

  const call = (namespace: string, method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> =>
    options.gateway.invoke({ namespace, method, args, peer: options.peer, signal })

  const wait = async (body: unknown, signal: AbortSignal): Promise<{ ended: boolean; timedOut?: true; lastSeq: number }> => {
    if (!isRecord(body)) throw new BridgeHttpError(400, 'bridge/bad-request', 'Body must be an object.')
    const { sessionId, afterSeq, timeoutMs } = body
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new BridgeHttpError(400, 'bridge/bad-request', 'sessionId must be a non-empty string.')
    }
    if (typeof afterSeq !== 'number' || !Number.isSafeInteger(afterSeq) || afterSeq < -1) {
      throw new BridgeHttpError(400, 'bridge/bad-request', 'afterSeq must be an integer of at least -1.')
    }
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new BridgeHttpError(400, 'bridge/bad-request', 'timeoutMs must be a non-negative number.')
    }
    const deadline = Date.now() + Math.min(timeoutMs, MAX_WAIT_MS)
    let lastSeq = afterSeq
    while (true) {
      const projections = await call('session', 'projections', { request: { sessionId } }, signal)
      const asOfSeq = isRecord(projections) && typeof projections['asOfSeq'] === 'number' ? projections['asOfSeq'] : undefined
      if (asOfSeq === undefined) {
        throw new BridgeCallError(
          'bridge/session-unavailable',
          isRecord(projections) ? 'Session projections need a migration before they can be read.' : 'Session was not found.',
        )
      }
      lastSeq = asOfSeq
      const page = await call('session', 'page', { request: { address: { kind: 'session', sessionId }, throughSeq: asOfSeq } }, signal)
      const records = isRecord(page) && Array.isArray(page['records']) ? page['records'] as unknown[] : []
      const ended = records.some((record) => {
        if (!isRecord(record) || !isRecord(record['event'])) return false
        const event = record['event']
        return event['type'] === 'turn/end' && typeof event['seq'] === 'number' && event['seq'] > afterSeq
      })
      if (ended) return { ended: true, lastSeq }
      const remaining = deadline - Date.now()
      if (remaining <= 0 || signal.aborted) return { ended: false, timedOut: true, lastSeq }
      await sleep(Math.min(pollMs, remaining), signal)
      if (signal.aborted) return { ended: false, timedOut: true, lastSeq }
    }
  }

  return async (req, res) => {
    // Browser pages always send Origin on cross-site posts. Local tools send none.
    if (req.headers['origin'] !== undefined) {
      fail(res, 403, 'bridge/forbidden', 'Requests with an Origin header are refused.')
      return
    }
    if (!isLoopbackHostHeader(req.headers['host'], options.port())) {
      fail(res, 403, 'bridge/forbidden', 'Host must be a loopback authority on the server port.')
      return
    }
    const presented = bearerOf(req.headers['authorization'])
    if (presented === undefined || !tokenMatches(presented, options.token)) {
      fail(res, 401, 'bridge/unauthorized', 'A valid bearer token is required.')
      return
    }
    if (req.method !== 'POST') {
      fail(res, 405, 'bridge/method-not-allowed', 'Only POST is supported.')
      return
    }
    const path = (req.url ?? '').split('?')[0] ?? ''
    const rpc = /^\/session-bridge\/rpc\/(?:(workspace)\/)?([A-Za-z0-9_-]+)$/.exec(path)
    const namespace = rpc?.[1] ?? 'session'
    const method = rpc?.[2] ?? ''
    const allowed = namespace === 'workspace' ? ALLOWED_WORKSPACE_METHODS : ALLOWED_METHODS
    const isWait = path === `${ROUTE_PREFIX}/wait`
    if ((rpc === null || !allowed.has(method)) && !isWait) {
      fail(res, 404, 'bridge/not-found', 'Unknown bridge endpoint.')
      return
    }

    const abort = new AbortController()
    res.once('close', () => { if (!res.writableFinished) abort.abort() })
    try {
      const body = await readJson(req)
      if (isWait) {
        send(res, 200, { ok: true, value: await wait(body, abort.signal) })
        return
      }
      const args = isRecord(body) ? body['args'] : undefined
      if (!isRecord(args)) throw new BridgeHttpError(400, 'bridge/bad-request', 'Body must be an object with an args object.')
      const value = await call(namespace, method, args, abort.signal)
      send(res, 200, { ok: true, value })
    } catch (error) {
      if (error instanceof BridgeHttpError) {
        fail(res, error.status, error.code, error.message)
        return
      }
      const failure = failureOf(error)
      send(res, 200, { ok: false, error: failure })
    }
  }
}
