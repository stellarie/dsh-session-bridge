import { request as httpRequest, createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { InvokeRemoteRequest } from '@deepseek-ai/dsh-api-gateway'
import { createBridgeHandler } from '../src/bridge.ts'

export const TOKEN = 'test-token-0123456789'

export type GatewayHandler = (args: Record<string, unknown>, call: InvokeRemoteRequest) => unknown

/** Gateway double that records every invocation. */
export function fakeGateway(handlers: Record<string, GatewayHandler> = {}) {
  const calls: InvokeRemoteRequest[] = []
  return {
    calls,
    handlers,
    async invoke(request: InvokeRemoteRequest): Promise<unknown> {
      calls.push(request)
      const qualified = `${request.namespace}.${request.method}`
      const key = Object.hasOwn(handlers, qualified) ? qualified : request.method
      const handler = Object.hasOwn(handlers, key) ? handlers[key] : undefined
      if (handler === undefined) throw Object.assign(new Error(`no fake for ${request.method}`), { code: 'gateway/not-found' })
      return handler({ ...request.args }, request)
    },
  }
}

export const peer = { id: 'peer-1', principal: { kind: 'owner' } } as unknown as InvokeRemoteRequest['peer']

export interface RawResponse {
  readonly status: number
  readonly body: unknown
}

/** Send one HTTP request with exact control over headers, which fetch does not give. */
export function raw(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: options.method ?? 'POST',
      headers: options.headers ?? {},
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = text
        try { body = JSON.parse(text) } catch { /* keep text */ }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

export interface RunningBridge {
  readonly port: number
  readonly gateway: ReturnType<typeof fakeGateway>
  /** POST JSON with the right Host and token; headers override the defaults. */
  post(path: string, body: unknown, headers?: Record<string, string | undefined>): Promise<RawResponse>
  close(): Promise<void>
}

export function listen(server: Server): Promise<void> {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })
}

/** Poll until a condition holds. */
export async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Serve the bridge handler on a loopback port. */
export async function startBridge(
  handlers: Record<string, GatewayHandler> = {},
  options: { pollIntervalMs?: number } = {},
): Promise<RunningBridge> {
  const gateway = fakeGateway(handlers)
  let port = 0
  const handler = createBridgeHandler({
    token: TOKEN,
    gateway,
    peer,
    port: () => port,
    ...options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs },
  })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { void handler(req, res) })
  await listen(server)
  port = (server.address() as AddressInfo).port
  return {
    port,
    gateway,
    post(path, body, headers = {}) {
      const merged: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      }
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) delete merged[key]
        else merged[key] = value
      }
      return raw(port, path, { headers: merged, body: JSON.stringify(body) })
    },
    close: () => closeServer(server),
  }
}
