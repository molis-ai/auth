import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webcrypto } from 'node:crypto'
import { AuthClient, AuthError } from '../src/index.ts'
import type { BrowserEnvironment } from '../src/index.ts'

const issuer = 'https://auth.example.test', redirectUri = 'https://product.example.test/callback?view=home'
const secret = (char: string) => char.repeat(43)
const tokenBody = (access = 'A', refresh = 'R', expires = 900) => ({ access_token: secret(access), refresh_token: secret(refresh), token_type: 'Bearer', expires_in: expires, scope: 'account' })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const envelope = (data: unknown) => json({ data, requestId: '8d11bfe2-461f-40a8-8310-1857410e2776' })
const errorCode = (code: string) => (error: unknown) => error instanceof AuthError && error.code === code
test('binding is Auth-origin only and rejects a changed account before starting', async () => {
  const h = harness(); await h.login()
  await assert.rejects(h.client.bindProvider('google'), errorCode('AUTH_ORIGIN_REQUIRED'))
  h.setUrl(issuer + '/console'); const count = h.requests.length
  await assert.rejects(h.client.bindProvider('google', 'different-user'), errorCode('ACCOUNT_CHANGED'))
  assert.equal(h.requests.length, count + 1); assert.equal(h.client.authenticated, true)
})
test('binding uses old access only in memory and accepts a same-origin cookie response', async () => {
  const h = harness(); await h.login(); h.setUrl(issuer + '/console')
  h.respond(async url => url.endsWith('/bind')
    ? envelope({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque' })
    : envelope({ transaction: secret('T'), loginUrl: issuer + '/login#transaction=' + secret('T') }))
  await h.client.bindProvider('google')
  const request = h.requests.at(-1)!
  assert.equal(request.init.credentials, 'same-origin')
  assert.equal(new Headers(request.init.headers).get('Authorization'), 'Bearer ' + secret('A'))
  assert.equal(new Headers(request.init.headers).get('X-Auth-Transaction'), secret('T'))
  assert.equal(h.client.authenticated, false); assert.ok(!JSON.stringify([...h.storage]).includes(secret('A')))
  assert.equal(h.navigations.at(-1), 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque')
})
test('binding rejects foreign destinations and does not retry a lost response', async () => {
  for (const lost of [false, true]) {
    const h = harness(); await h.login(); h.setUrl(issuer + '/console'); let calls = 0
    h.respond(async url => {
      if (!url.endsWith('/bind')) return envelope({ transaction: secret('T'), loginUrl: issuer + '/login#transaction=' + secret('T') })
      calls++; if (lost) throw Error('lost')
      return envelope({ authorizationUrl: 'https://attacker.example.test/' })
    })
    const before = h.navigations.length
    await assert.rejects(h.client.bindProvider('apple'), errorCode(lost ? 'RESULT_UNKNOWN' : 'INVALID_RESPONSE'))
    assert.equal(calls, 1); assert.equal(h.navigations.length, before)
  }
})
test('provider selection uses a fresh forced-login Auth bridge and the original product PKCE callback', async () => {
  for (const provider of ['google', 'apple'] as const) {
    const h = harness(); await h.client.signInWithProvider(provider)
    assert.equal(h.requests.length, 1)
    assert.equal(JSON.parse(h.requests[0].init.body as string).forceLogin, true)
    assert.equal(h.navigations[0], issuer + '/provider#transaction=' + secret('T') + '&provider=' + provider)
    const pending = h.pending(); h.callback()
    const reloaded = new AuthClient(h.options); assert.equal(await reloaded.handleRedirect(), true)
    const exchange = new URLSearchParams(h.requests[1].init.body as string)
    assert.equal(exchange.get('code_verifier'), pending.verifier)
    assert.equal(exchange.get('redirect_uri'), redirectUri)
    assert.equal(h.storage.size, 0); assert.equal(await reloaded.getAccessToken(), secret('A'))
  }
})
test('invalid provider is rejected before network or changing the current login flow', async () => {
  const h = harness(); await h.client.beginLogin(); const pending = [...h.storage.entries()]
  for (const provider of ['other', 'Google', 'google&redirect=evil', null])
    await assert.rejects(h.client.signInWithProvider(provider as any), errorCode('INVALID_PROVIDER'))
  assert.equal(h.requests.length, 1); assert.equal(h.navigations.length, 0)
  assert.deepEqual([...h.storage.entries()], pending)
})
test('superseded provider begin never navigates after logout or a newer flow', async () => {
  for (const replacement of ['logout', 'login']) {
    const h = harness(), response = deferred<Response>(), started = deferred<void>()
    h.respond(async () => { started.resolve(); return response.promise })
    const first = h.client.signInWithProvider('apple'), rejected = assert.rejects(first, errorCode('FLOW_SUPERSEDED'))
    await started.promise; h.respond(undefined)
    if (replacement === 'logout') await h.client.logout(); else await h.client.signInWithProvider('google')
    const navigations = [...h.navigations], pending = [...h.storage.entries()]
    response.resolve(envelope({ transaction: secret('T'), loginUrl: issuer + '/login#transaction=' + secret('T') }))
    await rejected; assert.deepEqual(h.navigations, navigations); assert.deepEqual([...h.storage.entries()], pending)
  }
})
test('lost provider begin response is not retried and never navigates', async () => {
  const h = harness(); h.respond(async () => { throw Error('private transport error') })
  await assert.rejects(h.client.signInWithProvider('google'), errorCode('RESULT_UNKNOWN'))
  assert.equal(h.requests.length, 1); assert.equal(h.navigations.length, 0); assert.equal(h.client.authenticated, false)
})
test('local-only logout makes no HTTP request and pauses automatic restore without claiming server revocation', async () => {
  const h = harness(); await h.login(); const count = h.requests.length
  assert.deepEqual(await h.client.logout({ localOnly: true }), { serverRevoked: false, restorePaused: true })
  assert.equal(h.requests.length, count); assert.equal(h.client.authenticated, false)
  await assert.rejects(h.client.getAccessToken(), errorCode('LOGIN_REQUIRED'))
  assert.equal(await h.client.restore(), false)
  assert.equal(h.requests.length, count); assert.equal(h.navigations.length, 0)
})
test('local-only logout prevents an in-flight refresh from restoring tokens', async () => {
  const h = harness(); await h.login(); h.advance(880000)
  const response = deferred<Response>(); h.respond(async () => response.promise)
  const refresh = h.client.getAccessToken(); const rejected = assert.rejects(refresh, errorCode('FLOW_SUPERSEDED'))
  await h.client.logout({ localOnly: true }); response.resolve(json(tokenBody('B', 'S')))
  await rejected; assert.equal(h.client.authenticated, false)
})
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function harness() {
  const storage = new Map<string, string>(), requests: { url: string; init: RequestInit }[] = [], navigations: string[] = []
  let now = 1_800_000_000_000, url = 'https://product.example.test/', handler: ((url: string, init: RequestInit) => Promise<Response>) | undefined
  const env: BrowserEnvironment = {
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } },
    crypto: webcrypto as unknown as Crypto, now: () => now, currentUrl: () => url,
    navigate: target => { navigations.push(target) }, replaceUrl: target => { url = target },
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const target = String(input); requests.push({ url: target, init })
      if (handler) return handler(target, init)
      if (target.endsWith('/api/v1/auth/transactions')) return envelope({ transaction: secret('T'), loginUrl: issuer + '/login#transaction=' + secret('T') })
      if (target.endsWith('/password')) return envelope({ continueUrl: issuer + '/complete#transaction=' + secret('T') })
      if (target.endsWith('/oauth2/token')) return json(tokenBody())
      if (target.endsWith('/users/me')) return envelope({ userId: 'fixture-user', emails: ['person@example.test'], scopes: ['account'] })
      if (target.endsWith('/logout') || target.endsWith('/logout-all')) return envelope({ loggedOut: true })
      throw Error('Unexpected test endpoint')
    }) as typeof fetch,
  }
  const options = { issuer, clientId: 'product-web', redirectUri, environment: env }
  const client = new AuthClient(options)
  function pending() { return JSON.parse([...storage.entries()].find(([key]) => key.endsWith(':pending'))![1]) }
  function callback(state = pending().state) { url = redirectUri + '&code=' + secret('C') + '&state=' + state }
  async function login() { await client.beginLogin(); callback(); assert.equal(await client.handleRedirect(), true) }
  return { client, env, options, storage, requests, navigations, pending, callback, login,
    setUrl: (next: string) => { url = next }, getUrl: () => url,
    advance: (ms: number) => { now += ms }, respond: (next: typeof handler) => { handler = next } }
}

test('PKCE is S256; only pending verifier/state survive navigation, never session tokens', async () => {
  const h = harness(); await h.client.signIn()
  const pending = h.pending(), body = JSON.parse(h.requests[0].init.body as string)
  const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(pending.verifier))).toString('base64url')
  assert.equal(body.codeChallenge, digest); assert.equal(body.state, pending.state); assert.equal(body.codeChallengeMethod, 'S256')
  assert.deepEqual(Object.keys(pending).sort(), ['createdAt', 'state', 'verifier'])
  assert.equal(h.navigations[0], issuer + '/login#transaction=' + secret('T'))
  h.callback(); const reloaded = new AuthClient(h.options)
  assert.equal(await reloaded.handleRedirect(), true); assert.equal(h.getUrl(), redirectUri)
  assert.equal(await reloaded.getAccessToken(), secret('A')); assert.equal(h.storage.size, 0)
  assert.equal(JSON.stringify(reloaded), '{}'); assert.equal(new AuthClient(h.options).authenticated, false)
  const exchange = new URLSearchParams(h.requests[1].init.body as URLSearchParams)
  assert.equal(exchange.get('code_verifier'), pending.verifier); assert.equal(exchange.get('redirect_uri'), redirectUri)
  for (const { url, init } of h.requests) {
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
    assert.ok(!url.includes(pending.verifier)); assert.ok(!url.includes(secret('A')))
  }
})

test('custom password page posts directly to Auth and uses an exact transaction handoff', async () => {
  const h = harness(); await h.client.signInWithPassword('person@example.test', 'long fixture password')
  const request = h.requests[1]; assert.equal(request.url, issuer + '/api/v1/auth/transactions/password')
  assert.equal(new Headers(request.init.headers).get('X-Auth-Transaction'), secret('T'))
  assert.equal(JSON.parse(request.init.body as string).email, 'person@example.test')
  assert.equal(h.navigations[0], issuer + '/complete#transaction=' + secret('T'))
  assert.ok(!JSON.stringify([...h.storage]).includes('long fixture password'))
})

test('callback state/duplicates/redirect/age are checked before code exchange and URL is cleared', async () => {
  for (const variant of ['state', 'duplicate', 'query', 'hash', 'expired', 'future', 'code-error']) {
    const h = harness(); await h.client.beginLogin(); h.callback()
    if (variant === 'state') h.callback(secret('X'))
    if (variant === 'duplicate') h.setUrl(h.getUrl() + '&code=' + secret('C'))
    if (variant === 'query') h.setUrl(h.getUrl() + '&unexpected=1')
    if (variant === 'hash') h.setUrl(h.getUrl() + '#unexpected')
    if (variant === 'expired') h.advance(600000)
    if (variant === 'future') h.advance(-1)
    if (variant === 'code-error') h.setUrl(h.getUrl() + '&error=access_denied')
    await assert.rejects(h.client.handleRedirect(), errorCode('INVALID_CALLBACK'), variant)
    assert.equal(h.requests.length, 1); assert.equal(h.getUrl(), redirectUri)
  }
  const h = harness(); assert.equal(await h.client.handleRedirect(), false); assert.equal(h.requests.length, 0)
})

test('lost authorization-code response is consumed once and is never retried', async () => {
  const h = harness(); await h.client.beginLogin(); h.callback(); const callback = h.getUrl()
  h.respond(async () => { throw new Error('sensitive upstream detail') })
  await assert.rejects(h.client.handleRedirect(), errorCode('RESULT_UNKNOWN'))
  h.setUrl(callback); await assert.rejects(h.client.handleRedirect(), errorCode('INVALID_CALLBACK'))
  assert.equal(h.requests.length, 2); assert.equal(h.client.authenticated, false); assert.equal(h.storage.size, 0)
})

test('simultaneous refresh callers share one request and rotate to the new refresh token', async () => {
  const h = harness(); await h.login(); h.advance(880000)
  const response = deferred<Response>(); h.respond(async () => response.promise)
  const first = h.client.getAccessToken(), second = h.client.getAccessToken()
  assert.equal(h.requests.length, 3); response.resolve(json(tokenBody('B', 'S')))
  assert.deepEqual(await Promise.all([first, second]), [secret('B'), secret('B')])
  h.advance(880000); h.respond(async (_url, init) => {
    assert.equal(new URLSearchParams(init.body as URLSearchParams).get('refresh_token'), secret('S'))
    return json(tokenBody('D', 'U'))
  })
  assert.equal(await h.client.getAccessToken(), secret('D')); assert.equal(h.storage.size, 0)
})

test('lost refresh response clears tokens; the old refresh token is not retried', async () => {
  const h = harness(); await h.login(); h.advance(880000)
  h.respond(async () => { throw Error('transport lost') })
  const results = await Promise.allSettled([h.client.getAccessToken(), h.client.getAccessToken()])
  assert.ok(results.every(result => result.status === 'rejected' && errorCode('RESULT_UNKNOWN')(result.reason)))
  await assert.rejects(h.client.getAccessToken(), errorCode('LOGIN_REQUIRED'))
  assert.equal(h.requests.length, 3); assert.equal(h.client.authenticated, false)
})

test('expiry uses request start, not delayed response receipt', async () => {
  const h = harness(); await h.client.beginLogin(); h.callback()
  h.respond(async () => { h.advance(40000); return json(tokenBody('A', 'R', 60)) })
  await h.client.handleRedirect()
  h.respond(async () => json(tokenBody('B', 'S')))
  assert.equal(await h.client.getAccessToken(), secret('B')); assert.equal(h.requests.length, 3)
})

test('current/all logout use distinct endpoints and pause startup restore until explicit login', async () => {
  for (const all of [false, true]) {
    const h = harness(); await h.login()
    assert.deepEqual(await h.client.logout({ all }), { serverRevoked: true, restorePaused: true })
    const last = h.requests.at(-1)!
    assert.equal(last.url, issuer + '/api/v1/sessions/' + (all ? 'logout-all' : 'current/logout'))
    assert.equal(new Headers(last.init.headers).get('Authorization'), 'Bearer ' + secret('A'))
    assert.equal(last.init.body, '{}'); assert.equal(h.client.authenticated, false)
    const reloaded = new AuthClient(h.options); assert.equal(await reloaded.restore(), false)
    assert.equal(h.requests.length, 3)
    await reloaded.signIn(); assert.equal(reloaded.restorePaused, false)
  }
})

test('logout waits for in-flight refresh and cannot hand its late token to waiting consumers', async () => {
  const h = harness(); await h.login(); h.advance(880000)
  const response = deferred<Response>(), started = deferred<void>()
  h.respond(async (url, init) => {
    if (url.endsWith('/oauth2/token')) { started.resolve(); return response.promise }
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer ' + secret('B'))
    return envelope({ loggedOut: true })
  })
  const refresh = h.client.getAccessToken(); const rejected = assert.rejects(refresh, errorCode('FLOW_SUPERSEDED'))
  await started.promise; const logout = h.client.logout()
  await assert.rejects(h.client.handleRedirect(), errorCode('LOGOUT_IN_PROGRESS'))
  await assert.rejects(h.client.beginLogin(), errorCode('LOGOUT_IN_PROGRESS'))
  response.resolve(json(tokenBody('B', 'S')))
  await rejected; assert.deepEqual(await logout, { serverRevoked: true, restorePaused: true })
  assert.equal(h.client.authenticated, false); assert.equal(h.requests.length, 4)
})

test('unconfirmed logout still clears local tokens, never claims server revocation', async () => {
  for (const response of ['network', 'malformed', 'denied']) {
    const h = harness(); await h.login(); h.respond(async () => {
      if (response === 'network') throw Error('lost')
      return response === 'malformed' ? envelope({ loggedOut: false }) : json({ error: { code: 'UNAUTHENTICATED' } }, 401)
    })
    assert.deepEqual(await h.client.logout(), { serverRevoked: false, restorePaused: true })
    assert.equal(h.client.authenticated, false); assert.equal(await new AuthClient(h.options).restore(), false)
    assert.equal(h.requests.length, 3)
  }
})

test('storage failure cannot masquerade as durable logout suppression', async () => {
  const h = harness(); await h.login(); h.env.storage.setItem = () => { throw Error('blocked') }
  assert.deepEqual(await h.client.logout(), { serverRevoked: true, restorePaused: false })
  assert.equal(h.client.restorePaused, true)
  await assert.rejects(h.client.beginLogin(), errorCode('STORAGE_UNAVAILABLE'))
  assert.equal(h.requests.length, 3)
})

test('logout during a code exchange cannot resurrect local tokens', async () => {
  const h = harness(); await h.client.beginLogin(); h.callback()
  const response = deferred<Response>(); h.respond(async () => response.promise)
  const exchange = h.client.handleRedirect(), rejected = assert.rejects(exchange, errorCode('FLOW_SUPERSEDED'))
  assert.deepEqual(await h.client.logout(), { serverRevoked: false, restorePaused: true })
  response.resolve(json(tokenBody())); await rejected
  assert.equal(h.client.authenticated, false); assert.equal(h.storage.size, 1)
})

test('superseded async PKCE generation cannot overwrite a newer transaction or logout pause', async () => {
  for (const superseding of ['login', 'logout']) {
    const h = harness(), digest = deferred<ArrayBuffer>(); let first = true
    h.env.crypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), subtle: {
      digest: (...args: Parameters<SubtleCrypto['digest']>) => { if (first) { first = false; return digest.promise } return webcrypto.subtle.digest(...args) },
    } } as Crypto
    const old = h.client.beginLogin(), rejected = assert.rejects(old, errorCode('FLOW_SUPERSEDED'))
    if (superseding === 'login') await h.client.beginLogin(); else await h.client.logout()
    const state = [...h.storage.entries()]
    digest.resolve(new ArrayBuffer(32)); await rejected
    assert.deepEqual([...h.storage.entries()], state); assert.equal(h.requests.length, superseding === 'login' ? 1 : 0)
  }
})

test('stale refresh cannot clear or replace a new login identity', async () => {
  const h = harness(); await h.login(); h.advance(880000)
  const response = deferred<Response>(); h.respond(async () => response.promise)
  const old = h.client.getAccessToken(), rejected = assert.rejects(old, errorCode('FLOW_SUPERSEDED'))
  h.respond(undefined); await h.client.beginLogin(); h.callback()
  h.respond(async () => json(tokenBody('N', 'Z'))); await h.client.handleRedirect()
  response.resolve(json(tokenBody('B', 'S'))); await rejected
  assert.equal(await h.client.getAccessToken(), secret('N')); assert.equal(h.client.authenticated, true)
})

test('invalid token types/lifetimes/scope escalation are rejected', async () => {
  for (const body of [null, { ...tokenBody(), token_type: 4 }, { ...tokenBody(), expires_in: 901 }, { ...tokenBody(), scope: 'admin' }, { ...tokenBody(), access_token: 'short' }]) {
    const h = harness(); await h.client.beginLogin(); h.callback(); h.respond(async () => json(body))
    await assert.rejects(h.client.handleRedirect(), errorCode('INVALID_RESPONSE'))
    assert.equal(h.client.authenticated, false)
  }
})

test('callback and handoff URLs cannot send credentials to a different origin', async () => {
  const h = harness()
  h.respond(async () => envelope({ transaction: secret('T'), loginUrl: 'https://attacker.example/login#transaction=' + secret('T') }))
  await assert.rejects(h.client.signIn(), errorCode('INVALID_RESPONSE')); assert.equal(h.navigations.length, 0)
  h.respond(undefined); await h.client.beginLogin()
  h.respond(async () => envelope({ continueUrl: 'https://attacker.example/complete' }))
  await assert.rejects(h.client.signInWithPassword('email', 'password'), errorCode('INVALID_RESPONSE'))
  assert.equal(h.navigations.length, 0)
})

test('unsafe deployment URLs/configurations fail before any network request', () => {
  const h = harness()
  for (const override of [{ issuer: 'http://public.example' }, { issuer: issuer + '/path' }, { redirectUri: 'https://user:password@example.test/' }, { redirectUri: redirectUri + '#secret' }, { redirectUri: redirectUri + '&state=preselected' }, { scopes: ['admin'] }]) {
    assert.throws(() => new AuthClient({ ...h.options, ...override }), errorCode('INVALID_CONFIGURATION'))
  }
  assert.equal(h.requests.length, 0)
})

test('identity call carries only user access bearer; safe server errors omit raw messages', async () => {
  const h = harness(); await h.login(); assert.equal((await h.client.currentUser()).userId, 'fixture-user')
  assert.equal(new Headers(h.requests.at(-1)!.init.headers).get('Authorization'), 'Bearer ' + secret('A'))
  h.respond(async () => json({ error: { code: 'ACCOUNT_SCOPE_REQUIRED', message: secret('R') }, requestId: '8d11bfe2-461f-40a8-8310-1857410e2776' }, 403))
  await assert.rejects(h.client.currentUser(), (error: AuthError) => {
    assert.equal(error.code, 'ACCOUNT_SCOPE_REQUIRED'); assert.equal(error.status, 403)
    assert.ok(!JSON.stringify(error).includes(secret('R'))); return true
  })
})
