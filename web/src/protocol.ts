export interface Context {
  id: string; clientId: string; clientType: 'WEB' | 'MACOS' | 'CLI'; redirectUri: string
  challenge: string; state: string; scopes: string[]; forceLogin: boolean
}
export interface View { context: Context; status: string }
export type AuthProvider = 'google' | 'apple'
export interface Configuration { mailboxEnabled: boolean; authOrigin: string; providers?: AuthProvider[]; console?: { enabled: boolean; clientId: string | null; redirectUri: string | null } }

/** Only a clean first-party entry may start a new console flow. Never replace a broken application request. */
export function isDirectLoginEntry(address: Pick<Location, 'pathname' | 'search' | 'hash'>) {
  return ['/', '/login'].includes(address.pathname) && !address.search && !address.hash
}
export class ApiError extends Error {
  code: string; requestId: string; retryAfter: number
  constructor(code = 'NETWORK_ERROR', requestId = '', retryAfter = 0) {
    super(code); this.code = code; this.requestId = requestId; this.retryAfter = retryAfter
  }
}
export const secretPattern = /^[A-Za-z0-9_-]{43}$/

/** Read once into memory, then remove the fragment before any asynchronous work. */
export function readFragment(fragment: string, mode: string) {
  const p = new URLSearchParams(fragment.replace(/^#/, ''))
  if (mode === 'provider-mailbox') {
    const keys = ['transaction', 'continuation']
    if ([...p.keys()].length !== 2 || keys.some(k => p.getAll(k).length !== 1 || !secretPattern.test(p.get(k) ?? ''))) return null
    return { transaction: p.get('transaction')!, continuation: p.get('continuation')! }
  }
  if (mode === 'login' && p.has('provider-error')) {
    if ([...p.keys()].length !== 1 || !/^[A-Z_]{1,64}$/.test(p.get('provider-error') ?? '')) return null
    return { 'provider-error': p.get('provider-error')! }
  }
  if (mode === 'provider') {
    if ([...p.keys()].length !== 2 || p.getAll('transaction').length !== 1 || p.getAll('provider').length !== 1
      || !secretPattern.test(p.get('transaction') ?? '') || !['google', 'apple'].includes(p.get('provider') ?? '')) return null
    return { transaction: p.get('transaction')!, provider: p.get('provider')! }
  }
  const keys = mode === 'verify-email' ? ['challenge', 'token'] : ['transaction']
  if ([...p.keys()].some(k => !keys.includes(k)) || keys.some(k => p.getAll(k).length !== 1 || !secretPattern.test(p.get(k) ?? ''))) return null
  return Object.fromEntries(keys.map(k => [k, p.get(k)!]))
}

export function takeFragment(address: Pick<Location, 'hash' | 'pathname'>, history: Pick<History, 'replaceState'>, mode: string) {
  const result = readFragment(address.hash, mode)
  history.replaceState(null, '', address.pathname)
  return result
}

export async function api<T>(path: string, token?: string, body?: unknown, transport: typeof fetch = fetch): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await transport('/api/v1/auth' + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-Auth-Transaction': token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    })
    const result = await response.json()
    if (!response.ok) throw new ApiError(typeof result?.error?.code === 'string' ? result.error.code : 'AUTH_UNAVAILABLE',
      /^[0-9a-f-]{36}$/.test(result?.requestId ?? '') ? result.requestId : '', Math.min(3600, Math.max(0, Number(response.headers.get('Retry-After')) || 0)))
    if (!result || !Object.hasOwn(result, 'data')) throw new ApiError('INVALID_RESPONSE')
    return result.data as T
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError() }
  finally { clearTimeout(timer) }
}

export function checkedHandoff(value: string, transaction: string, origin: string): string {
  if (!secretPattern.test(transaction) || value !== origin + '/complete#transaction=' + transaction) throw new ApiError('INVALID_RESPONSE')
  return value
}

/** Match the immutable registered callback and state, never follow an arbitrary response URL. */
export function checkedCallback(value: string, context: Context): string {
  const url = new URL(value)
  const code = url.searchParams.get('code') ?? ''
  const expected = context.redirectUri + (context.redirectUri.includes('?') ? '&' : '?') + 'code=' + encodeURIComponent(code) + '&state=' + encodeURIComponent(context.state)
  if (!secretPattern.test(code) || value !== expected) throw new ApiError('INVALID_RESPONSE')
  return value
}

export function rememberEmail(storage: Pick<Storage, 'setItem' | 'removeItem'>, enabled: boolean, email: string) {
  try { if (enabled) storage.setItem('molis.auth.remembered-email', email); else storage.removeItem('molis.auth.remembered-email') } catch { /* Optional convenience only. */ }
}
