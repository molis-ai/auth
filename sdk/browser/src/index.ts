export interface StorageAdapter { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface BrowserEnvironment {
  storage: StorageAdapter; crypto: Crypto; fetch: typeof fetch; now(): number
  currentUrl(): string; navigate(url: string): void; replaceUrl(url: string): void
}
export interface AuthOptions { issuer: string; clientId: string; redirectUri: string; scopes?: string[]; timeoutMs?: number; environment?: BrowserEnvironment }
export interface CurrentUser { userId: string; displayName: string; emails: string[]; applicationId: string; clientId: string; sessionId: string; scopes: string[]; avatarUrl?: string | null }
export interface LogoutResult { serverRevoked: boolean; restorePaused: boolean }
export type AuthProvider = 'google' | 'apple'
interface Pending { verifier: string; state: string; createdAt: number }
interface Tokens { access: string; refresh: string; expiresAt: number; scopes: string[] }
const SECRET = /^[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f-]{36}$/

export class AuthError extends Error {
  readonly code: string; readonly status: number; readonly requestId: string
  constructor(code: string, status = 0, requestId = '') {
    super(code); this.name = 'AuthError'; this.code = code; this.status = status; this.requestId = requestId
  }
}

function defaultEnvironment(): BrowserEnvironment {
  if (typeof window === 'undefined') throw new AuthError('BROWSER_REQUIRED')
  // Access to sessionStorage may itself throw; no in-memory fallback can survive top-level navigation.
  let storage: Storage
  try { storage = window.sessionStorage } catch { throw new AuthError('STORAGE_UNAVAILABLE') }
  return { storage, crypto: window.crypto, fetch: window.fetch.bind(window), now: () => Date.now(),
    currentUrl: () => window.location.href, navigate: url => window.location.assign(url), replaceUrl: url => window.history.replaceState(null, '', url) }
}
function safeUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new AuthError('INVALID_CONFIGURATION') }
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new AuthError('INVALID_CONFIGURATION')
  return url
}
function encoded(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }

/** Browser-only user session client. No framework dependencies, background refresh timer or token persistence. */
export class AuthClient {
  #env: BrowserEnvironment; #issuer: string; #client: string; #redirect: string; #scopes: string[]; #timeout: number
  #key: string; #tokens?: Tokens; #transaction?: string
  #refreshFlight?: Promise<Tokens>; #generation = 0; #closing = false; #paused = false
  constructor(options: AuthOptions) {
    const issuer = safeUrl(options.issuer), redirect = safeUrl(options.redirectUri)
    if (issuer.pathname !== '/' || issuer.search || !options.clientId || options.clientId.length > 100
      || ['code', 'state', 'error'].some(key => redirect.searchParams.has(key))) throw new AuthError('INVALID_CONFIGURATION')
    const scopes = [...new Set(options.scopes ?? ['account'])]
    if (!scopes.length || scopes.some(scope => !['account', 'profile'].includes(scope))) throw new AuthError('INVALID_CONFIGURATION')
    if (options.timeoutMs !== undefined && !Number.isFinite(options.timeoutMs)) throw new AuthError('INVALID_CONFIGURATION')
    this.#env = options.environment ?? defaultEnvironment(); this.#issuer = issuer.origin; this.#client = options.clientId
    this.#redirect = options.redirectUri; this.#scopes = scopes; this.#timeout = Math.min(30000, Math.max(1000, options.timeoutMs ?? 12000))
    this.#key = 'molis.auth:' + encodeURIComponent(JSON.stringify([this.#issuer, this.#client, this.#redirect]))
    try { this.#paused = this.#env.storage.getItem(this.#key + ':paused') === '1' } catch { this.#paused = true }
  }
  get authenticated(): boolean { return !!this.#tokens && !this.#closing }
  get restorePaused(): boolean { return this.#paused }

  /** User-initiated sign-in clears the explicit logout pause; use restore() for automatic startup restoration. */
  async signIn(options: { forceLogin?: boolean } = {}): Promise<void> {
    const starting = this.beginLogin(options), generation = this.#generation
    const started = await starting
    if (generation !== this.#generation || this.#closing) throw new AuthError('FLOW_SUPERSEDED')
    this.#env.navigate(started.loginUrl)
  }
  async restore(): Promise<boolean> {
    if (this.#paused || this.#closing) return false
    await this.signIn(); return true
  }
  /** Custom product page -> top-level Auth bridge. Provider credentials/cookies never belong to the product. */
  async signInWithProvider(provider: AuthProvider): Promise<void> {
    if (!['google', 'apple'].includes(provider)) throw new AuthError('INVALID_PROVIDER')
    const starting = this.beginLogin({ forceLogin: true }), generation = this.#generation
    await starting
    if (generation !== this.#generation || this.#closing || !this.#transaction) throw new AuthError('FLOW_SUPERSEDED')
    this.#env.navigate(this.#issuer + '/provider#transaction=' + this.#transaction + '&provider=' + provider)
  }
  /** Auth-origin account management only: recent existing authentication + independent provider proof. */
  async bindProvider(provider: AuthProvider, expectedUserId?: string): Promise<void> {
    if (!['google', 'apple'].includes(provider)) throw new AuthError('INVALID_PROVIDER')
    if (new URL(this.#env.currentUrl()).origin !== this.#issuer || !this.#issuer.startsWith('https:')) throw new AuthError('AUTH_ORIGIN_REQUIRED')
    const original = this.#generation, access = await this.getAccessToken()
    if (expectedUserId !== undefined) {
      const user = await this.#api<CurrentUser>('/api/v1/users/me', undefined, access)
      if (user?.userId !== expectedUserId) throw new AuthError('ACCOUNT_CHANGED')
    }
    if (original !== this.#generation || this.#closing) throw new AuthError('FLOW_SUPERSEDED')
    const starting = this.beginLogin({ forceLogin: true }), generation = this.#generation
    await starting
    if (generation !== this.#generation || this.#closing || !this.#transaction) throw new AuthError('FLOW_SUPERSEDED')
    const result = await this.#api<{ authorizationUrl: string }>('/api/v1/auth/providers/' + provider + '/bind', {}, access, this.#transaction)
    if (generation !== this.#generation || this.#closing) throw new AuthError('FLOW_SUPERSEDED')
    let destination: URL
    try { destination = new URL(result.authorizationUrl) } catch { throw new AuthError('INVALID_RESPONSE') }
    const allowed = provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://appleid.apple.com/auth/authorize'
    if (destination.origin + destination.pathname !== allowed || destination.username || destination.password || destination.hash) throw new AuthError('INVALID_RESPONSE')
    this.#env.navigate(destination.href)
  }
  /** A custom first-party page may collect email/password and then call signInWithPassword(). */
  async beginLogin(options: { forceLogin?: boolean } = {}): Promise<{ loginUrl: string }> {
    if (this.#closing) throw new AuthError('LOGOUT_IN_PROGRESS')
    const generation = ++this.#generation
    this.#tokens = undefined; this.#transaction = undefined; this.#refreshFlight = undefined
    const verifier = encoded(this.#env.crypto.getRandomValues(new Uint8Array(32)))
    const state = encoded(this.#env.crypto.getRandomValues(new Uint8Array(32)))
    const challenge = encoded(new Uint8Array(await this.#env.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    if (generation !== this.#generation || this.#closing) throw new AuthError('FLOW_SUPERSEDED')
    const pending = { verifier, state, createdAt: this.#env.now() }
    try { this.#env.storage.setItem(this.#key + ':pending', JSON.stringify(pending)); this.#env.storage.removeItem(this.#key + ':paused') }
    catch { throw new AuthError('STORAGE_UNAVAILABLE') }
    this.#paused = false
    const result = await this.#api<{ transaction: string; loginUrl: string }>('/api/v1/auth/transactions', {
      clientId: this.#client, redirectUri: this.#redirect, codeChallenge: challenge, codeChallengeMethod: 'S256', state,
      scopes: this.#scopes, forceLogin: options.forceLogin ?? false,
    })
    if (generation !== this.#generation || this.#closing) throw new AuthError('FLOW_SUPERSEDED')
    if (!result || !SECRET.test(result.transaction) || result.loginUrl !== this.#issuer + '/login#transaction=' + result.transaction) throw new AuthError('INVALID_RESPONSE')
    this.#transaction = result.transaction
    return { loginUrl: result.loginUrl }
  }
  async signInWithPassword(email: string, password: string): Promise<void> {
    if (this.#closing) throw new AuthError('LOGOUT_IN_PROGRESS')
    if (!this.#transaction) await this.beginLogin()
    const generation = this.#generation, transaction = this.#transaction!
    const result = await this.#api<{ continueUrl: string }>('/api/v1/auth/transactions/password', { email, password }, undefined, transaction)
    if (generation !== this.#generation || this.#closing) throw new AuthError('FLOW_SUPERSEDED')
    if (!result || result.continueUrl !== this.#issuer + '/complete#transaction=' + transaction) throw new AuthError('INVALID_RESPONSE')
    this.#env.navigate(result.continueUrl)
  }

  /** Call once at startup. Returns false when the current page is not an OAuth callback. */
  async handleRedirect(): Promise<boolean> {
    if (this.#closing) throw new AuthError('LOGOUT_IN_PROGRESS')
    const current = new URL(this.#env.currentUrl()), registered = new URL(this.#redirect)
    if (current.origin !== registered.origin || current.pathname !== registered.pathname || !['code', 'error'].some(key => current.searchParams.has(key))) return false
    this.#env.replaceUrl(this.#redirect) // Clear credentials from the address before asynchronous work.
    const pending = this.#readPending()
    const code = current.searchParams.get('code'), state = current.searchParams.get('state')
    if (!pending || state !== pending.state || current.searchParams.getAll('state').length !== 1 || current.hash) throw new AuthError('INVALID_CALLBACK')
    const originalQuery = new URL(current)
    for (const key of ['code', 'state', 'error', 'error_description', 'error_uri']) originalQuery.searchParams.delete(key)
    if (originalQuery.searchParams.toString() !== registered.searchParams.toString()) throw new AuthError('INVALID_CALLBACK')
    if (current.searchParams.has('error')) {
      if (code !== null || current.searchParams.getAll('error').length !== 1) throw new AuthError('INVALID_CALLBACK')
      this.#consumePending(); throw new AuthError('AUTHORIZATION_DENIED')
    }
    if (!code || !SECRET.test(code) || current.searchParams.getAll('code').length !== 1) throw new AuthError('INVALID_CALLBACK')
    this.#consumePending() // Never retry a code if the token response is lost.
    const generation = ++this.#generation
    this.#tokens = undefined; this.#refreshFlight = undefined
    const tokens = await this.#token({ grant_type: 'authorization_code', client_id: this.#client, redirect_uri: this.#redirect, code, code_verifier: pending.verifier }, this.#scopes)
    if (generation !== this.#generation || this.#closing) throw new AuthError('FLOW_SUPERSEDED')
    this.#tokens = tokens; return true
  }
  async getAccessToken(): Promise<string> {
    if (this.#closing || !this.#tokens) throw new AuthError('LOGIN_REQUIRED')
    if (this.#tokens.expiresAt - this.#env.now() > 30000) return this.#tokens.access
    const generation = this.#generation, tokens = await this.#refresh()
    if (this.#closing || generation !== this.#generation) throw new AuthError('FLOW_SUPERSEDED')
    return tokens.access
  }
  async currentUser(): Promise<CurrentUser> {
    const access = await this.getAccessToken()
    return this.#api<CurrentUser>('/api/v1/users/me', undefined, access)
  }
  /** localOnly is for externally confirmed revocation; it never claims to revoke server state. */
  async logout(options: { all?: boolean; localOnly?: false } | { localOnly: true; all?: never } = {}): Promise<LogoutResult> {
    if (options.localOnly && options.all) throw new AuthError('INVALID_REQUEST')
    if (this.#closing) throw new AuthError('LOGOUT_IN_PROGRESS')
    this.#closing = true; this.#paused = true
    let restorePaused = true, serverRevoked = false
    try { this.#env.storage.setItem(this.#key + ':paused', '1') } catch { restorePaused = false }
    try {
      if (this.#tokens && !options.localOnly) {
        // A started refresh must settle before revocation; do not let it resurrect local state afterward.
        const token = this.#refreshFlight ? await this.#refreshFlight : this.#tokens.expiresAt > this.#env.now() ? this.#tokens : await this.#refresh()
        const result = await this.#api<{ loggedOut: boolean }>('/api/v1/sessions/' + (options.all ? 'logout-all' : 'current/logout'), {}, token.access)
        if (result?.loggedOut !== true) throw new AuthError('INVALID_RESPONSE')
        serverRevoked = true
      }
    } catch { /* Unconfirmed revocation is returned, never disguised as success. */ }
    finally {
      ++this.#generation; this.#tokens = undefined; this.#transaction = undefined; this.#refreshFlight = undefined; this.#closing = false
      try { this.#env.storage.removeItem(this.#key + ':pending') } catch { restorePaused = false }
    }
    return { serverRevoked, restorePaused }
  }

  #refresh(): Promise<Tokens> {
    if (this.#refreshFlight) return this.#refreshFlight
    const previous = this.#tokens, generation = this.#generation
    if (!previous) return Promise.reject(new AuthError('LOGIN_REQUIRED'))
    const flight = this.#token({ grant_type: 'refresh_token', client_id: this.#client, refresh_token: previous.refresh }, previous.scopes)
      .then(tokens => { if (generation !== this.#generation) throw new AuthError('FLOW_SUPERSEDED'); this.#tokens = tokens; return tokens })
      .catch(error => { if (generation === this.#generation) this.#tokens = undefined; throw error })
      .finally(() => { if (this.#refreshFlight === flight) this.#refreshFlight = undefined })
    this.#refreshFlight = flight; return flight
  }
  #readPending(): Pending | undefined {
    try {
      const value = JSON.parse(this.#env.storage.getItem(this.#key + ':pending') ?? 'null')
      if (!value || !SECRET.test(value.verifier) || !SECRET.test(value.state) || !Number.isFinite(value.createdAt)
        || this.#env.now() < value.createdAt || this.#env.now() - value.createdAt >= 600000) return undefined
      return value
    } catch { throw new AuthError('STORAGE_UNAVAILABLE') }
  }
  #consumePending() {
    try { this.#env.storage.removeItem(this.#key + ':pending') } catch { throw new AuthError('STORAGE_UNAVAILABLE') }
    this.#transaction = undefined
  }
  async #token(body: Record<string,string>, allowedScopes: string[]): Promise<Tokens> {
    const startedAt = this.#env.now()
    const result = await this.#request('/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
    if (!result || typeof result !== 'object') throw new AuthError('INVALID_RESPONSE')
    const scopes = typeof result.scope === 'string' ? result.scope.split(' ').filter(Boolean) : allowedScopes
    if (typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string'
      || !SECRET.test(result.access_token) || !SECRET.test(result.refresh_token) || typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer'
      || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 900 || scopes.some((scope: string) => !allowedScopes.includes(scope))) throw new AuthError('INVALID_RESPONSE')
    return { access: result.access_token, refresh: result.refresh_token, expiresAt: startedAt + result.expires_in * 1000, scopes }
  }
  async #api<T>(path: string, body?: unknown, access?: string, transaction?: string): Promise<T> {
    const result = await this.#request(path, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(access ? { Authorization: 'Bearer ' + access } : {}),
      ...(transaction ? { 'X-Auth-Transaction': transaction } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) })
    if (!result || !Object.hasOwn(result, 'data')) throw new AuthError('INVALID_RESPONSE')
    return result.data as T
  }
  async #request(path: string, init: RequestInit): Promise<any> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#timeout)
    try {
      // Only the Auth-origin binding entry must receive its independent HttpOnly provider cookie.
      const credentials = /^\/api\/v1\/auth\/providers\/(google|apple)\/bind$/.test(path) ? 'same-origin' : 'omit'
      const response = await this.#env.fetch(this.#issuer + path, { ...init, signal: controller.signal, credentials, cache: 'no-store', redirect: 'error' })
      const body = await response.json()
      if (!response.ok) {
        const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(body?.error?.code ?? '') ? body.error.code : path === '/oauth2/token' ? 'TOKEN_REJECTED' : 'AUTH_UNAVAILABLE'
        throw new AuthError(code, response.status, UUID.test(body?.requestId ?? '') ? body.requestId : '')
      }
      return body
    } catch (error) { if (error instanceof AuthError) throw error; throw new AuthError('RESULT_UNKNOWN') }
    finally { clearTimeout(timer) }
  }
}
