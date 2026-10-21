import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { EndpointError, mintToken, readEndpoint, removeEndpoint, resolveEndpointPath, writeEndpoint } from '../src/discovery.ts'
import { closeServer, fakeGateway, listen, peer, raw } from './support.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dsh-session-bridge-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('endpoint file', () => {
  const sample = { url: 'http://127.0.0.1:3080', token: 'secret-token-value', pid: 4242, startedAt: 1_700_000_000_000 }

  it('round-trips through write and read and leaves no temporary file', () => {
    const path = join(directory, 'nested', 'endpoint.json')
    writeEndpoint(path, sample)
    expect(readEndpoint(path)).toEqual(sample)
    expect(existsSync(`${path}.${String(process.pid)}.tmp`)).toBe(false)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('replaces an existing file in place', () => {
    const path = join(directory, 'endpoint.json')
    writeEndpoint(path, sample)
    writeEndpoint(path, { ...sample, token: 'second-token-value' })
    expect(readEndpoint(path).token).toBe('second-token-value')
  })

  it('removes only the file that holds its own token', () => {
    const path = join(directory, 'endpoint.json')
    writeEndpoint(path, sample)
    removeEndpoint(path, 'some-other-token')
    expect(existsSync(path)).toBe(true)
    removeEndpoint(path, sample.token)
    expect(existsSync(path)).toBe(false)
    expect(() => { removeEndpoint(path, sample.token) }).not.toThrow()
  })

  it('names the path when the file is missing and never prints a token', () => {
    const path = join(directory, 'missing.json')
    expect(() => readEndpoint(path)).toThrow(EndpointError)
    expect(() => readEndpoint(path)).toThrow(path)
  })

  it.each([
    ['not json', 'nope'],
    ['a missing field', JSON.stringify({ url: 'http://x', token: 't', pid: 1 })],
    ['an empty token', JSON.stringify({ url: 'http://x', token: '', pid: 1, startedAt: 1 })],
  ])('rejects %s', (_label, content) => {
    const path = join(directory, 'bad.json')
    writeFileSync(path, content)
    expect(() => readEndpoint(path)).toThrow(EndpointError)
  })

  it('resolves the path from explicit, environment, DSH_HOME, then the home directory', () => {
    expect(resolveEndpointPath('C:/explicit.json', { DSH_SESSION_BRIDGE_ENDPOINT: 'C:/env.json' })).toBe('C:/explicit.json')
    expect(resolveEndpointPath(undefined, { DSH_SESSION_BRIDGE_ENDPOINT: 'C:/env.json' })).toBe('C:/env.json')
    expect(resolveEndpointPath(undefined, { DSH_HOME: join(directory, 'home') })).toBe(join(directory, 'home', 'session-bridge', 'endpoint.json'))
    expect(resolveEndpointPath(undefined, { DSH_HOME: '  ' })).toMatch(/\.dsh[\\/]session-bridge[\\/]endpoint\.json$/)
  })

  it('mints distinct url-safe tokens of 32 bytes', () => {
    const a = mintToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(mintToken()).not.toBe(a)
  })
})

describe('host plugin lifecycle (AT6)', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server !== undefined) await closeServer(server)
    server = undefined
  })

  /** Host doubles: a real listener behind a web server double that records its routes. */
  async function hostDoubles() {
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
    const registered: string[] = []
    const gateway = fakeGateway({ cancel: () => ({ accepted: true }) })
    const createPeer = vi.fn(() => peer)
    server = createServer((req, res) => {
      const route = [...routes].find(([path]) => req.url === path || req.url?.startsWith(`${path}/`))
      if (route === undefined) { res.writeHead(404).end(); return }
      void route[1](req, res)
    })
    await listen(server)
    const port = (server.address() as AddressInfo).port
    const webServer = {
      get port() { return port },
      getOrigin: () => `http://127.0.0.1:${String(port)}`,
      register: vi.fn((route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => {
        registered.push(`${route.kind} ${route.path}`)
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      }),
    }
    return { webServer, createPeer, gateway, routes, registered, port }
  }

  async function boot(endpointPath: string) {
    const doubles = await hostDoubles()
    const ctx = new Context()
    const lines: Message[] = []
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { lines.push(message) } })
    ctx.provide('webServer', doubles.webServer as never)
    ctx.provide('connection', { createPeer: doubles.createPeer } as never)
    ctx.provide('typertGateway', doubles.gateway as never)
    const fiber = ctx.plugin(plugin, plugin.Config({ endpointPath }))
    await fiber.await()
    return { ...doubles, ctx, fiber, lines }
  }

  it('writes the endpoint file on start, serves authenticated calls, and deletes the file on dispose', async () => {
    const path = join(directory, 'session-bridge', 'endpoint.json')
    const host = await boot(path)
    expect(host.registered).toEqual(['prefix /session-bridge'])
    expect(host.createPeer).toHaveBeenCalledWith({ principal: { kind: 'owner' } })

    const endpoint = readEndpoint(path)
    expect(endpoint).toMatchObject({ url: `http://127.0.0.1:${String(host.port)}`, pid: process.pid })
    expect(endpoint.token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const reply = await raw(host.port, '/session-bridge/rpc/cancel', {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify({ args: { request: { sessionId: 's1' } } }),
    })
    expect(reply.body).toEqual({ ok: true, value: { accepted: true } })
    expect(host.gateway.calls[0]?.peer).toBe(peer)

    const unauthorized = await raw(host.port, '/session-bridge/rpc/cancel', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { request: { sessionId: 's1' } } }),
    })
    expect(unauthorized.status).toBe(401)
    expect(host.gateway.calls).toHaveLength(1)

    await host.fiber.dispose()
    expect(existsSync(path)).toBe(false)
    expect(host.routes.size).toBe(0)
    await host.ctx.fiber.dispose()
  })

  it('logs no line that contains the token or the file content', async () => {
    const path = join(directory, 'endpoint.json')
    const host = await boot(path)
    const { token } = readEndpoint(path)
    const fileText = readFileSync(path, 'utf8')
    await raw(host.port, '/session-bridge/rpc/cancel', {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ args: { request: { sessionId: 's1' } } }),
    })
    await raw(host.port, '/session-bridge/rpc/cancel', {
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{}',
    })
    await host.fiber.dispose()
    const logged = host.lines.map(line => JSON.stringify(line.args))
    expect(logged.length).toBeGreaterThan(0)
    expect(logged.some(line => line.includes('session-bridge'))).toBe(true)
    expect(logged.every(line => !line.includes(token) && !line.includes(fileText.trim()))).toBe(true)
    await host.ctx.fiber.dispose()
  })

  it('waits for all three services, then publishes the file at the DSH_HOME default path', async () => {
    vi.stubEnv('DSH_HOME', directory)
    const doubles = await hostDoubles()
    const ctx = new Context()
    const fiber = ctx.plugin(plugin)
    const path = join(directory, 'session-bridge', 'endpoint.json')
    ctx.provide('webServer', doubles.webServer as never)
    ctx.provide('connection', { createPeer: doubles.createPeer } as never)
    await fiber.await()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(existsSync(path)).toBe(false)
    expect(doubles.registered).toEqual([])
    ctx.provide('typertGateway', doubles.gateway as never)
    await vi.waitFor(() => { expect(existsSync(path)).toBe(true) })
    expect(doubles.registered).toEqual(['prefix /session-bridge'])
    await ctx.fiber.dispose()
    expect(existsSync(path)).toBe(false)
    vi.unstubAllEnvs()
  })

  it('keeps a newer instance file when an older instance disposes', async () => {
    const path = join(directory, 'endpoint.json')
    const first = await boot(path)
    const firstToken = readEndpoint(path).token
    const second = await boot(path)
    const secondToken = readEndpoint(path).token
    expect(secondToken).not.toBe(firstToken)
    await first.fiber.dispose()
    expect(readEndpoint(path).token).toBe(secondToken)
    await second.fiber.dispose()
    expect(existsSync(path)).toBe(false)
    await first.ctx.fiber.dispose()
    await second.ctx.fiber.dispose()
  })
})
