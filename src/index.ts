/**
 * Session bridge host plugin. It serves token-guarded loopback routes that
 * forward a fixed set of Session Remote methods, and publishes an endpoint
 * file so a local stdio MCP server can find the running app.
 *
 * @module @stellarie/dsh-session-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createBridgeHandler, ROUTE_PREFIX } from './bridge.ts'
import { mintToken, removeEndpoint, resolveEndpointPath, writeEndpoint } from './discovery.ts'

export { ALLOWED_METHODS, createBridgeHandler, isLoopbackHostHeader, ROUTE_PREFIX } from './bridge.ts'
export type { BridgeHandler, BridgeOptions } from './bridge.ts'
export { EndpointError, mintToken, readEndpoint, removeEndpoint, resolveEndpointPath, writeEndpoint } from './discovery.ts'
export type { Endpoint } from './discovery.ts'

export const name = 'session-bridge'
export const inject = ['webServer', 'connection', 'typertGateway']

/** Deployment-owned bridge settings. */
export interface Config {
  /** Endpoint file path (default `$DSH_HOME/session-bridge/endpoint.json`, else `~/.dsh/session-bridge/endpoint.json`). */
  endpointPath?: string
}

export const Config: z<Config> = z.object({
  endpointPath: z.string(),
})

/**
 * Register the bridge routes and publish the endpoint file.
 * @param ctx - context carrying `webServer`, `connection`, and `typertGateway`.
 * @param config - endpoint file location.
 */
export function apply(ctx: Context, config: Config): void {
  const endpointPath = resolveEndpointPath(config.endpointPath)
  ctx.effect(function* () {
    const token = mintToken()
    const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
    const handler = createBridgeHandler({
      token,
      gateway: ctx.typertGateway,
      peer,
      port: () => ctx.webServer.port,
    })
    yield ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
    // The origin is only known after the listener binds, so the file comes last.
    const url = ctx.webServer.getOrigin()
    writeEndpoint(endpointPath, { url, token, pid: process.pid, startedAt: Date.now() })
    yield () => { removeEndpoint(endpointPath, token) }
    ctx.logger.info(`session-bridge: serving ${url}${ROUTE_PREFIX}, endpoint file ${endpointPath}`)
  }, 'session-bridge: routes and endpoint file')
}
