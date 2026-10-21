import { afterEach, describe, expect, it } from 'vitest'
import { ALLOWED_METHODS, MAX_BODY_BYTES } from '../src/bridge.ts'
import { raw, startBridge, TOKEN, waitFor } from './support.ts'
import type { RunningBridge } from './support.ts'

let bridge: RunningBridge | undefined
afterEach(async () => {
  await bridge?.close()
  bridge = undefined
})

const okArgs = { args: { request: { sessionId: 's1' } } }

describe('bridge admission (AT3)', () => {
  it('serves a request that passes every check, as the positive control', async () => {
    bridge = await startBridge({ cancel: () => ({ accepted: true }) })
    const reply = await bridge.post('/session-bridge/rpc/cancel', okArgs)
    expect(reply).toEqual({ status: 200, body: { ok: true, value: { accepted: true } } })
    expect(bridge.gateway.calls).toHaveLength(1)
    expect(bridge.gateway.calls[0]).toMatchObject({ namespace: 'session', method: 'cancel', args: okArgs.args })
  })

  it.each([
    ['a missing token', { authorization: undefined }, 401],
    ['a wrong token', { authorization: 'Bearer not-the-token' }, 401],
    ['a token of a different length', { authorization: `Bearer ${TOKEN}x` }, 401],
    ['a non-bearer scheme', { authorization: `Basic ${TOKEN}` }, 401],
    ['an unrelated Host', { host: 'evil.example' }, 403],
    ['a loopback Host on another port', { host: '127.0.0.1:1' }, 403],
    ['a LAN Host', { host: '192.168.1.5:80' }, 403],
    ['a browser Origin', { origin: 'http://localhost:3080' }, 403],
    ['a null Origin', { origin: 'null' }, 403],
    ['an Origin with a valid token and Host', { origin: 'https://example.com' }, 403],
  ])('refuses %s without calling the gateway', async (_label, headers, status) => {
    bridge = await startBridge({ cancel: () => ({ accepted: true }) })
    const reply = await bridge.post('/session-bridge/rpc/cancel', okArgs, headers)
    expect(reply.status).toBe(status)
    expect(reply.body).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^bridge\//) } })
    expect(bridge.gateway.calls).toHaveLength(0)
  })

  it('accepts the localhost and bracketed IPv6 Host spellings on the server port', async () => {
    bridge = await startBridge({ cancel: () => ({ accepted: true }) })
    for (const host of [`localhost:${String(bridge.port)}`, `[::1]:${String(bridge.port)}`, `LOCALHOST:${String(bridge.port)}`]) {
      const reply = await bridge.post('/session-bridge/rpc/cancel', okArgs, { host })
      expect(reply.status).toBe(200)
    }
    expect(bridge.gateway.calls).toHaveLength(3)
  })

  it('refuses a non-POST method, a wrong content type, and a malformed body before the gateway', async () => {
    bridge = await startBridge({ cancel: () => ({ accepted: true }) })
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
    expect((await raw(bridge.port, '/session-bridge/rpc/cancel', { method: 'GET', headers })).status).toBe(405)
    const text = await raw(bridge.port, '/session-bridge/rpc/cancel', {
      headers: { ...headers, 'content-type': 'text/plain' }, body: JSON.stringify(okArgs),
    })
    expect(text.status).toBe(415)
    const broken = await raw(bridge.port, '/session-bridge/rpc/cancel', { headers, body: '{not json' })
    expect(broken.status).toBe(400)
    const noArgs = await bridge.post('/session-bridge/rpc/cancel', { request: {} })
    expect(noArgs.status).toBe(400)
    expect(bridge.gateway.calls).toHaveLength(0)
  })

  it('refuses a body above the cap without calling the gateway', async () => {
    bridge = await startBridge({ cancel: () => ({ accepted: true }) })
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
    const big = JSON.stringify({ args: { pad: 'x'.repeat(MAX_BODY_BYTES) } })
    // The server may reset the socket while the client still writes the body.
    const reply = await raw(bridge.port, '/session-bridge/rpc/cancel', { headers, body: big }).catch(() => ({ status: 413 }))
    expect(reply.status).toBe(413)
    expect(bridge.gateway.calls).toHaveLength(0)
  })
})

describe('bridge allowlist (AT4)', () => {
  it.each([
    'delete', 'fork', 'uploadFile', 'rename', 'search', 'follow', 'inspect', 'setPermission', 'Create', '__proto__', 'constructor',
  ])('answers 404 for method %s without calling the gateway', async (method) => {
    bridge = await startBridge({ [method]: () => 'reached' })
    const reply = await bridge.post(`/session-bridge/rpc/${method}`, okArgs)
    expect(reply.status).toBe(404)
    expect(bridge.gateway.calls).toHaveLength(0)
  })

  it.each([
    '/session-bridge', '/session-bridge/', '/session-bridge/rpc', '/session-bridge/rpc/', '/session-bridge/rpc/create/extra',
    '/session-bridge/rpc/create%2Fx', '/session-bridge/other', '/session-bridge/wait/extra',
  ])('answers 404 for path %s', async (path) => {
    bridge = await startBridge({ create: () => 'reached' })
    const reply = await bridge.post(path, okArgs)
    expect(reply.status).toBe(404)
    expect(bridge.gateway.calls).toHaveLength(0)
  })

  it('forwards exactly the six allowlisted methods in the session namespace with the owner peer', async () => {
    expect([...ALLOWED_METHODS].sort()).toEqual(['cancel', 'create', 'list', 'page', 'projections', 'prompt'])
    bridge = await startBridge(Object.fromEntries([...ALLOWED_METHODS].map(method => [method, () => ({ method })])))
    for (const method of ALLOWED_METHODS) {
      const reply = await bridge.post(`/session-bridge/rpc/${method}`, { args: { request: { tag: method } } })
      expect(reply.body).toEqual({ ok: true, value: { method } })
    }
    expect(bridge.gateway.calls.map(call => [call.namespace, call.method])).toEqual(
      [...ALLOWED_METHODS].map(method => ['session', method]),
    )
    expect(bridge.gateway.calls.every(call => call.peer.principal.kind === 'owner')).toBe(true)
  })

  it('maps a gateway error to an ok:false reply with its code and message', async () => {
    bridge = await startBridge({
      prompt: () => { throw Object.assign(new Error('busy now'), { code: 'session/agent-busy' }) },
    })
    const reply = await bridge.post('/session-bridge/rpc/prompt', okArgs)
    expect(reply).toEqual({ status: 200, body: { ok: false, error: { code: 'session/agent-busy', message: 'busy now' } } })
  })
})

describe('bridge wait (AT5)', () => {
  const waitBody = { sessionId: 's1', afterSeq: 5, timeoutMs: 3000 }
  const event = (seq: number, type: string) => ({ type: 'event', event: { type, seq, time: 0, data: {} } })

  function script(state: { asOfSeq: number; events: ReturnType<typeof event>[] }) {
    return {
      projections: () => ({ kind: 'sequenced', asOfSeq: state.asOfSeq, values: {} }),
      page: () => ({ records: state.events, hasMore: false }),
    }
  }

  it('returns ended when a turn/end with a larger seq appears while polling', async () => {
    const state = { asOfSeq: 7, events: [event(6, 'turn/start'), event(7, 'user/message')] }
    bridge = await startBridge(script(state), { pollIntervalMs: 10 })
    setTimeout(() => { state.asOfSeq = 9; state.events.push(event(8, 'assistant/message'), event(9, 'turn/end')) }, 60)
    const started = Date.now()
    const reply = await bridge.post('/session-bridge/wait', waitBody)
    expect(reply).toEqual({ status: 200, body: { ok: true, value: { ended: true, lastSeq: 9 } } })
    expect(Date.now() - started).toBeLessThan(2500)
    const pages = bridge.gateway.calls.filter(call => call.method === 'page')
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.at(-1)?.args).toEqual({ request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: 9 } })
  })

  it('ignores a turn/end at or below afterSeq and reports timedOut at the deadline', async () => {
    const state = { asOfSeq: 5, events: [event(4, 'turn/start'), event(5, 'turn/end')] }
    bridge = await startBridge(script(state), { pollIntervalMs: 10 })
    const started = Date.now()
    const reply = await bridge.post('/session-bridge/wait', { ...waitBody, timeoutMs: 150 })
    expect(reply).toEqual({ status: 200, body: { ok: true, value: { ended: false, timedOut: true, lastSeq: 5 } } })
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
  })

  it('polls once and times out at once when timeoutMs is zero', async () => {
    const state = { asOfSeq: 5, events: [] as ReturnType<typeof event>[] }
    bridge = await startBridge(script(state), { pollIntervalMs: 10 })
    const reply = await bridge.post('/session-bridge/wait', { ...waitBody, timeoutMs: 0 })
    expect(reply.body).toEqual({ ok: true, value: { ended: false, timedOut: true, lastSeq: 5 } })
    expect(bridge.gateway.calls.map(call => call.method)).toEqual(['projections', 'page'])
  })

  it('reports an unknown session as a bridge failure', async () => {
    bridge = await startBridge({ projections: () => null, page: () => ({ records: [], hasMore: false }) })
    const reply = await bridge.post('/session-bridge/wait', waitBody)
    expect(reply.body).toMatchObject({ ok: false, error: { code: 'bridge/session-unavailable' } })
  })

  it.each([
    [{ sessionId: '', afterSeq: 1, timeoutMs: 1 }],
    [{ sessionId: 's1', afterSeq: 'x', timeoutMs: 1 }],
    [{ sessionId: 's1', afterSeq: 1, timeoutMs: -1 }],
    [{ sessionId: 's1', afterSeq: 1 }],
  ])('refuses the malformed wait body %j', async (body) => {
    bridge = await startBridge({})
    const reply = await bridge.post('/session-bridge/wait', body)
    expect(reply.status).toBe(400)
    expect(bridge.gateway.calls).toHaveLength(0)
  })

  it('stops polling when the client closes the request', async () => {
    let signal: AbortSignal | undefined
    bridge = await startBridge({
      projections: (_args, call) => { signal = call.signal; return { kind: 'sequenced', asOfSeq: 1, values: {} } },
      page: () => ({ records: [], hasMore: false }),
    }, { pollIntervalMs: 20 })
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${String(bridge.port)}/session-bridge/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...waitBody, timeoutMs: 60_000 }),
      signal: controller.signal,
    }).catch(() => undefined)
    await waitFor(() => bridge!.gateway.calls.length >= 4)
    controller.abort()
    await pending
    await waitFor(() => signal?.aborted === true)
    await new Promise(resolve => setTimeout(resolve, 100))
    const settled = bridge.gateway.calls.length
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(bridge.gateway.calls.length).toBe(settled)
  })
})
