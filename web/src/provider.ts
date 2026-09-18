import { ApiError, secretPattern, type AuthProvider, type Configuration, type Context } from './protocol.ts'

const KEY = 'molis.auth.provider-restart.v1'
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
export function enabledProviders(configuration: Configuration): AuthProvider[] {
  if (configuration.providers === undefined) return []
  if (!Array.isArray(configuration.providers) || configuration.providers.length > 2
    || configuration.providers.some(value => !['google', 'apple'].includes(value))
    || new Set(configuration.providers).size !== configuration.providers.length) throw new ApiError('INVALID_RESPONSE')
  return [...configuration.providers]
}

/** Exact provider endpoint and Auth callback, no response-supplied arbitrary navigation. */
export function checkedProviderUrl(value: string, provider: AuthProvider, origin: string): string {
  try {
    const url = new URL(value), google = provider === 'google'
    const endpoint = google ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://appleid.apple.com/auth/authorize'
    const expected = { response_type: 'code', redirect_uri: origin + '/oauth2/callback/' + provider,
      scope: google ? 'openid email profile' : 'openid email', response_mode: google ? 'query' : 'form_post',
      ...(google ? { access_type: 'online', code_challenge_method: 'S256' } : {}) }
    const keys = [...Object.keys(expected), 'client_id', 'state', 'nonce', ...(google ? ['code_challenge'] : [])]
    if (!['google', 'apple'].includes(provider) || url.origin + url.pathname !== endpoint || url.username || url.password || url.hash
      || [...url.searchParams.keys()].length !== keys.length || keys.some(key => url.searchParams.getAll(key).length !== 1)
      || Object.entries(expected).some(([key, expected]) => url.searchParams.get(key) !== expected)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(url.searchParams.get('client_id') ?? '')
      || !secretPattern.test(url.searchParams.get('state') ?? '') || !secretPattern.test(url.searchParams.get('nonce') ?? '')
      || (google && !secretPattern.test(url.searchParams.get('code_challenge') ?? ''))) throw new Error()
    return value
  } catch { throw new ApiError('INVALID_RESPONSE') }
}

function context(value: any): Context | undefined {
  if (!value || !/^[0-9a-f-]{36}$/.test(value.id ?? '') || typeof value.clientId !== 'string' || !value.clientId || value.clientId.length > 100
    || !['WEB', 'MACOS', 'CLI'].includes(value.clientType) || typeof value.redirectUri !== 'string' || !value.redirectUri || value.redirectUri.length > 1024
    || !secretPattern.test(value.challenge ?? '') || !/^[A-Za-z0-9_-]{22,128}$/.test(value.state ?? '')
    || !Array.isArray(value.scopes) || !value.scopes.length || value.scopes.length > 2 || value.scopes.some((scope: unknown) => !['account', 'profile'].includes(scope as string))) return undefined
  // Only allowlisted, non-session fields survive navigation. Server revalidates on explicit restart.
  return { id: value.id, clientId: value.clientId, clientType: value.clientType, redirectUri: value.redirectUri,
    challenge: value.challenge, state: value.state, scopes: [...value.scopes], forceLogin: true }
}
export function saveProviderAttempt(storage: Storage, value: Context, provider: AuthProvider, now = Date.now()) {
  const safe = context(value)
  if (!safe || !['google', 'apple'].includes(provider) || !Number.isFinite(now)) throw new ApiError('INVALID_RESPONSE')
  try { storage.setItem(KEY, JSON.stringify({ context: safe, provider, createdAt: now })) }
  catch { throw new ApiError('STORAGE_UNAVAILABLE') }
}
/** Consumed once. It is only a restart hint, not authorization or a reusable authenticated transaction. */
export function takeProviderAttempt(storage: Storage, now = Date.now()): Context | undefined {
  let raw: string | null
  try { raw = storage.getItem(KEY); storage.removeItem(KEY) } catch { throw new ApiError('STORAGE_UNAVAILABLE') }
  try {
    if (!raw || raw.length > 4096) return undefined
    const value = JSON.parse(raw)
    if (!Number.isFinite(now) || !Number.isFinite(value.createdAt) || now < value.createdAt || now - value.createdAt >= 600000
      || !['google', 'apple'].includes(value.provider)) return undefined
    return context(value.context)
  } catch { return undefined }
}
