/**
 * Endpoint file that tells the MCP server where the bridge listens. The host
 * plugin writes it on start and removes it on dispose. The file holds the
 * bearer token, so nothing here may log its content.
 *
 * @module @stellarie/dsh-session-bridge/discovery
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Environment variable that overrides the endpoint file location. */
export const ENDPOINT_ENV = 'DSH_SESSION_BRIDGE_ENDPOINT'

/** What the host plugin publishes for local clients. */
export interface Endpoint {
  /** Origin of the app web server, for example `http://127.0.0.1:3080`. */
  readonly url: string
  /** Bearer token for the bridge routes. */
  readonly token: string
  /** Process id of the app that wrote the file. */
  readonly pid: number
  /** Epoch milliseconds of the write. */
  readonly startedAt: number
}

/** The endpoint file is missing or unusable. The message never holds the token. */
export class EndpointError extends Error {
  override readonly name = 'EndpointError'
}

/**
 * Resolve the endpoint file path.
 * @param explicit - configured path, which has the highest precedence.
 * @param env - environment mapping used for `DSH_SESSION_BRIDGE_ENDPOINT` and `DSH_HOME`.
 * @returns the absolute endpoint file path.
 */
export function resolveEndpointPath(explicit?: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  const override = env[ENDPOINT_ENV]
  if (override !== undefined && override.trim() !== '') return override
  const home = env['DSH_HOME']
  const root = home !== undefined && home.trim() !== '' ? home : join(homedir(), '.dsh')
  return join(root, 'session-bridge', 'endpoint.json')
}

/**
 * Mint a bearer token.
 * @returns 32 random bytes as base64url text.
 */
export function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Write the endpoint file through a temporary file and a rename.
 * @param path - endpoint file path.
 * @param endpoint - content to publish.
 */
export function writeEndpoint(path: string, endpoint: Endpoint): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 })
    // The mode option is ignored when the file already exists.
    if (process.platform !== 'win32') chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Delete the endpoint file when it still belongs to the given token.
 * A newer instance that rewrote the file keeps its own file.
 * @param path - endpoint file path.
 * @param token - token of the instance that wrote the file.
 */
export function removeEndpoint(path: string, token: string): void {
  let current: string
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    return
  }
  try {
    const parsed: unknown = JSON.parse(current)
    const owner = typeof parsed === 'object' && parsed !== null ? (parsed as { token?: unknown }).token : undefined
    if (typeof owner === 'string' && owner !== token) return
  } catch {
    // An unreadable file is garbage; remove it.
  }
  rmSync(path, { force: true })
}

/**
 * Read and validate the endpoint file.
 * @param path - endpoint file path.
 * @returns the published endpoint.
 * @throws {EndpointError} when the file is missing or malformed.
 */
export function readEndpoint(path: string): Endpoint {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new EndpointError(
        `Session bridge endpoint file not found at ${path}. Start the DeepSeek Harness app with @stellarie/dsh-session-bridge enabled.`,
      )
    }
    throw new EndpointError(`Cannot read the session bridge endpoint file at ${path} (${code ?? 'unknown error'}).`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new EndpointError(`Session bridge endpoint file at ${path} is not valid JSON.`)
  }
  const value = parsed as Partial<Record<keyof Endpoint, unknown>> | null
  if (
    typeof value !== 'object' || value === null
    || typeof value.url !== 'string' || value.url === ''
    || typeof value.token !== 'string' || value.token === ''
    || typeof value.pid !== 'number'
    || typeof value.startedAt !== 'number'
  ) {
    throw new EndpointError(`Session bridge endpoint file at ${path} has missing or invalid fields.`)
  }
  return { url: value.url, token: value.token, pid: value.pid, startedAt: value.startedAt }
}
