// Invoked by BrowserSdkRedisIT with fresh, disposable fixtures via stdin. Never logs protocol secrets.
import { AuthClient, AuthError } from '../dist/index.js'
import { webcrypto } from 'node:crypto'

const input = []
for await (const chunk of process.stdin) input.push(chunk)
const config = JSON.parse(Buffer.concat(input).toString('utf8'))
const base = new URL(config.base), issuer = new URL(config.issuer), redirect = new URL(config.redirectUri)
const local = url => ['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:' && Number(url.port) >= 1024
if (![base, issuer, redirect].every(local) || config.fixture !== 'auth-disposable-sdk-test' || !config.email.endsWith('@example.test')) throw Error('Disposable loopback fixture required')
function check(condition, message) { if (!condition) throw Error(message) }
const storage = new Map(); let now = Date.now(), url = redirect.origin + '/', navigation, cookie = '', tokenRequests = 0
const env = {
  storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  crypto: webcrypto, now: () => now, currentUrl: () => url, navigate: target => { navigation = target }, replaceUrl: target => { url = target },
  fetch: async (target, init) => {
    const parsed = new URL(target)
    check(parsed.origin === issuer.origin, 'SDK sent a request outside Auth')
    check(init.credentials === 'omit' && init.redirect === 'error' && init.cache === 'no-store', 'SDK request boundary changed')
    if (parsed.pathname === '/oauth2/token') tokenRequests++
    const headers = new Headers(init.headers); headers.set('Origin', redirect.origin)
    // Test server binds a random port; logical issuer stays stable in its Spring test configuration.
    const response = await fetch(base.origin + parsed.pathname, { ...init, headers })
    check(response.headers.get('access-control-allow-origin') === redirect.origin, 'Product CORS origin missing')
    return response
  },
}
const options = { issuer: issuer.origin, clientId: config.clientId, redirectUri: config.redirectUri, environment: env }
let auth = new AuthClient(options)

const authCookies = new Map()
async function authPost(path, transaction, body = {}) {
  const response = await fetch(base.origin + '/api/v1/auth/transactions/' + path, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Origin: issuer.origin, 'X-Auth-Transaction': transaction, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) })
  for (const set of response.headers.getSetCookie()) {
    const pair = set.split(';', 1)[0], name = pair.split('=', 1)[0]
    if (/Max-Age=0(?:;|$)/i.test(set)) authCookies.delete(name); else authCookies.set(name, pair)
  }
  cookie = [...authCookies.values()].join('; ')
  return response
}
function navigationTransaction(path) {
  check(typeof navigation === 'string', 'SDK did not request navigation')
  const next = new URL(navigation)
  check(next.origin === issuer.origin && next.pathname === path, 'Incorrect SDK handoff target')
  const transaction = new URLSearchParams(next.hash.slice(1)).get('transaction')
  check(/^[A-Za-z0-9_-]{43}$/.test(transaction ?? ''), 'Invalid handoff transaction')
  return transaction
}
async function complete(transaction) {
  const preview = await authPost('confirmation', transaction)
  check(preview.status === 200, 'Auth confirmation preview failed')
  const prepared = (await preview.json()).data
  check(prepared.account.userId === config.userId, 'Confirmation identity mismatch')
  const response = await authPost('complete', transaction, { confirmation: prepared.confirmation, confirmed: true })
  check(response.status === 200, 'Auth completion failed')
  const body = await response.json(); url = body.data.redirectTo
  check(await auth.handleRedirect(), 'SDK did not handle actual code callback')
  check(url === config.redirectUri, 'Callback URL was not cleared')
  const user = await auth.currentUser(); check(user.userId === config.userId, 'Returned identity does not match fixture')
  check(user.emails.includes(config.email), 'Verified fixture email missing')
  check([...storage.keys()].every(key => !key.endsWith(':pending')), 'Pending verifier not consumed')
}

try {
  // Password goes through actual Redis authentication transaction + MySQL password verification.
  await auth.signInWithPassword(config.email, config.password)
  await complete(navigationTransaction('/complete'))
  const firstAccess = await auth.getAccessToken()
  // Advance only the SDK clock to trigger refresh; backend still enforces its own real timestamps.
  now += 880000; const before = tokenRequests
  const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()])
  check(a === b && a !== firstAccess && tokenRequests === before + 1, 'Actual refresh did not rotate once')
  check((await auth.currentUser()).userId === config.userId, 'Refreshed identity rejected')
  const current = await auth.logout()
  check(current.serverRevoked && current.restorePaused && !auth.authenticated, 'Current logout was not confirmed')
  const rejected = await env.fetch(issuer.origin + '/api/v1/users/me', { method: 'GET', headers: { Authorization: 'Bearer ' + a }, credentials: 'omit', cache: 'no-store', redirect: 'error' })
  check(rejected.status === 401, 'Revoked Access Token still accepted')

  auth = new AuthClient(options)
  check(!await auth.restore(), 'Logout pause did not survive new SDK instance')
  await auth.signIn(); const restored = navigationTransaction('/login')
  check((await authPost('restore', restored)).status === 200, 'Current logout unexpectedly destroyed Auth root')
  await complete(restored)
  const all = await auth.logout({ all: true })
  check(all.serverRevoked && all.restorePaused, 'All logout was not confirmed')
  await auth.signIn(); const afterAll = navigationTransaction('/login')
  check((await authPost('restore', afterAll)).status === 401, 'All logout left Auth root usable')
  try { await auth.getAccessToken(); throw Error('SDK retained tokens after logout') }
  catch (error) { check(error instanceof AuthError && error.code === 'LOGIN_REQUIRED', 'Unexpected post-logout SDK state') }
  process.stdout.write('SDK_LIVE_OK: password, callback, identity, single-flight refresh, current logout, restore pause, root restore, all logout\n')
} catch (error) {
  // Never serialize raw HTTP bodies, fixture config, request arguments or assertion token values.
  process.stderr.write(error instanceof AuthError ? 'SDK_LIVE_FAILURE: ' + error.code + '\n' : 'SDK_LIVE_FAILURE: protocol invariant failed\n')
  process.exitCode = 1
}
