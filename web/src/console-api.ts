import type { AuthClient } from '../../sdk/browser/src/index.ts'

export interface ConsoleConfiguration { authOrigin: string; console: { enabled: boolean; clientId: string | null; redirectUri: string | null } }
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface Application { id: string; name: string; status: 'ACTIVE' | 'DISABLED'; version: number; actions: string[] }
export interface LoginClient { id: string; clientId: string; applicationId: string; clientType: 'WEB' | 'MACOS' | 'CLI'; status: 'ACTIVE' | 'DISABLED'; version: number; scopes: string[]; redirects: string[] }
export interface ServiceClient { id: string; clientId: string; name: string; status: 'ACTIVE' | 'DISABLED'; activeCredentialId: string | null }
export interface User { id: string; displayName: string; status: 'ACTIVE' | 'DISABLED'; emails?: string[] }
export interface Audit { id: string; action: string; outcome: string; actorUserId: string | null; targetUserId: string | null; applicationId: string | null; occurredAt: string; requestId: string; changeSummary: string | null }
export class ConsoleError extends Error {
  readonly code: string; readonly requestId: string; readonly uncertain: boolean
  constructor(code: string, requestId = '', uncertain = false) { super(code); this.code = code; this.requestId = requestId; this.uncertain = uncertain }
}

/** Exact same-origin bearer requests. Never retry writes, send cookies, or include secrets in errors. */
export function platform<T>(client: Pick<AuthClient, 'getAccessToken'>, path: string, method = 'GET', body?: unknown, transport: typeof fetch = fetch): Promise<T> {
  return jsonApi<T>(client, '/api/v1/platform', path, method, body, transport)
}
export function spaceApi<T>(client: Pick<AuthClient, 'getAccessToken'>, path: string, method = 'GET', body?: unknown, transport: typeof fetch = fetch): Promise<T> {
  return jsonApi<T>(client, '/api/v1', path, method, body, transport)
}
async function jsonApi<T>(client: Pick<AuthClient, 'getAccessToken'>, prefix: string, path: string, method: string, body: unknown, transport: typeof fetch): Promise<T> {
  if (!/^\/[A-Za-z0-9/_?.=&%-]+$/.test(path) || path.includes('..') || !['GET', 'POST', 'PUT'].includes(method)) throw new ConsoleError('INVALID_REQUEST')
  const token = await client.getAccessToken()
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await transport(prefix + path, { method, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal })
    const result = await response.json()
    if (!response.ok) throw new ConsoleError(/^[A-Z_]{1,64}$/.test(result?.error?.code ?? '') ? result.error.code : 'AUTH_UNAVAILABLE',
      /^[0-9a-f-]{36}$/.test(result?.requestId ?? '') ? result.requestId : '', method !== 'GET' && response.status >= 500)
    if (!result || !Object.hasOwn(result, 'data')) throw new ConsoleError('INVALID_RESPONSE', '', method !== 'GET')
    return result.data as T
  } catch (failure) {
    if (failure instanceof ConsoleError) throw failure
    throw new ConsoleError('NETWORK_ERROR', '', method !== 'GET')
  } finally { clearTimeout(timer) }
}
export function listPath(path: string, cursor: string | null) { return path + '?limit=25' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '') }
export function callbackLines(value: string) {
  const values = value.split(/\r?\n/).map(v => v.trim()).filter(Boolean)
  if (!values.length || values.length > 20 || new Set(values).size !== values.length) throw new ConsoleError('INVALID_REQUEST')
  return values
}
export function checkedConsole(value: ConsoleConfiguration, origin: string) {
  if (value?.authOrigin !== origin || typeof value?.console?.enabled !== 'boolean') throw new ConsoleError('INVALID_CONFIGURATION')
  if (!value.console.enabled) return null
  if (!value.console.clientId || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.console.clientId) || value.console.redirectUri !== origin + '/console/callback') throw new ConsoleError('INVALID_CONFIGURATION')
  return { issuer: origin, clientId: value.console.clientId, redirectUri: value.console.redirectUri, scopes: ['account', 'profile'] }
}
/** Remove callback credentials synchronously, before fetching public UI configuration. */
export function takeConsoleArrival(address: Pick<Location, 'href' | 'pathname'>, history: Pick<History, 'replaceState'>) {
  const arrival = address.href
  if (address.pathname === '/console/callback') history.replaceState(null, '', '/console/callback')
  return arrival
}
