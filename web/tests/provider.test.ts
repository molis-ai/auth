import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, readFragment, type AuthProvider, type Context } from '../src/protocol.ts'
import { checkedProviderUrl, enabledProviders, saveProviderAttempt, takeProviderAttempt } from '../src/provider.ts'
import { copy } from '../src/copy.ts'

const secret = 't'.repeat(43), origin = 'https://auth.example.test'
const context: Context = { id: 'b15d5a19-e5b6-4a20-bd34-ab555edb1b52', clientId: 'product', clientType: 'WEB',
  redirectUri: 'https://product.example.test/callback', challenge: secret, state: 's'.repeat(43), scopes: ['account'], forceLogin: false }
const invalid = (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE'
function storage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
function authorization(provider: AuthProvider) {
  const google = provider === 'google'
  const url = new URL(google ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://appleid.apple.com/auth/authorize')
  url.search = new URLSearchParams({ response_type: 'code', redirect_uri: origin + '/oauth2/callback/' + provider,
    scope: google ? 'openid email profile' : 'openid email', response_mode: google ? 'query' : 'form_post',
    client_id: 'fixture-client', state: secret, nonce: secret,
    ...(google ? { access_type: 'online', code_challenge_method: 'S256', code_challenge: secret } : {}) }).toString()
  return url
}
test('provider capability is explicit, unique, allowlisted and default-off', () => {
  assert.deepEqual(enabledProviders({ authOrigin: origin, mailboxEnabled: false }), [])
  assert.deepEqual(enabledProviders({ authOrigin: origin, mailboxEnabled: false, providers: ['google', 'apple'] }), ['google', 'apple'])
  for (const providers of [null, 'google', ['google', 'google'], ['google', 'apple', 'google'], ['other']])
    assert.throws(() => enabledProviders({ authOrigin: origin, mailboxEnabled: false, providers } as any), invalid)
})
test('provider bridge and error fragments accept only exact fields without external error text', () => {
  for (const provider of ['google', 'apple']) assert.deepEqual(readFragment('#transaction=' + secret + '&provider=' + provider, 'provider'), { transaction: secret, provider })
  for (const fragment of ['transaction=' + secret, 'transaction=short&provider=google', 'transaction=' + secret + '&provider=other',
    'transaction=' + secret + '&provider=google&provider=apple', 'transaction=' + secret + '&provider=google&redirect=https://evil.test'])
    assert.equal(readFragment('#' + fragment, 'provider'), null)
  assert.deepEqual(readFragment('#provider-error=PROVIDER_CANCELLED', 'login'), { 'provider-error': 'PROVIDER_CANCELLED' })
  for (const fragment of ['provider-error=unsafe%20detail', 'provider-error=CANCELLED&provider-error=FAILED', 'provider-error=CANCELLED&transaction=' + secret])
    assert.equal(readFragment('#' + fragment, 'login'), null)
})
test('provider navigation binds exact official endpoint, response mode, scopes and Auth callback', () => {
  for (const provider of ['google', 'apple'] as const) {
    const valid = authorization(provider)
    assert.equal(checkedProviderUrl(valid.href, provider, origin), valid.href)
    const mutants = [new URL(valid), new URL(valid), new URL(valid), new URL(valid), new URL(valid)]
    mutants[0].hostname = 'evil.test'; mutants[1].username = 'attacker'; mutants[2].hash = 'secret'
    mutants[3].pathname += '/extra'; mutants[4].protocol = 'http:'
    for (const url of mutants) assert.throws(() => checkedProviderUrl(url.href, provider, origin), invalid)
    for (const [key, value] of [['redirect_uri', 'https://evil.test/callback'], ['response_type', 'token'], ['response_mode', 'fragment'],
      ['scope', 'openid email profile admin'], ['nonce', 'short'], ['state', 'short'], ['client_id', ''], ['extra', 'value']]) {
      const url = new URL(valid); url.searchParams.set(key, value)
      assert.throws(() => checkedProviderUrl(url.href, provider, origin), invalid)
    }
    const duplicate = new URL(valid); duplicate.searchParams.append('state', secret)
    assert.throws(() => checkedProviderUrl(duplicate.href, provider, origin), invalid)
  }
})
test('provider restart hint stores only allowlisted context and is consumed once with full login required', () => {
  const s = storage()
  saveProviderAttempt(s, { ...context, password: 'private-password', accessToken: 'private-token', transaction: secret, verifier: secret } as Context, 'google', 1000)
  const raw = [...s.values.values()][0]
  assert.ok(!raw.includes('private')); assert.ok(!raw.includes('transaction')); assert.ok(!raw.includes('verifier'))
  assert.deepEqual(takeProviderAttempt(s, 1001), { ...context, forceLogin: true })
  assert.equal(takeProviderAttempt(s, 1001), undefined); assert.equal(s.values.size, 0)
})
test('expired, future, malformed and oversized restart hints are discarded without becoming authority', () => {
  for (const now of [999, 601000, NaN]) {
    const s = storage(); saveProviderAttempt(s, context, 'apple', 1000)
    assert.equal(takeProviderAttempt(s, now), undefined); assert.equal(s.values.size, 0)
  }
  for (const raw of ['invalid-json', 'x'.repeat(4097), JSON.stringify({ createdAt: 1000, provider: 'other', context }),
    JSON.stringify({ createdAt: 1000, provider: 'google', context: { ...context, scopes: ['admin'] } })]) {
    const s = storage(); s.setItem('molis.auth.provider-restart.v1', raw)
    assert.equal(takeProviderAttempt(s, 1001), undefined); assert.equal(s.values.size, 0)
  }
})
test('required provider restart storage fails closed without fallback persistence', () => {
  const s = storage(); const denied = () => { throw new Error('private browser detail') }
  s.setItem = denied
  assert.throws(() => saveProviderAttempt(s, context, 'google'), (e: ApiError) => e.code === 'STORAGE_UNAVAILABLE')
  s.getItem = denied
  assert.throws(() => takeProviderAttempt(s), (e: ApiError) => e.code === 'STORAGE_UNAVAILABLE')
})
test('both locales include provider confirmation, cancellation and unfinished proof messages', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    for (const key of ['providerTitle', 'providerNotice', 'google', 'apple', 'otherMethod', 'orContinue'] as const) assert.ok(copy[locale][key])
    for (const key of ['PROVIDER_CANCELLED', 'PROVIDER_INTERRUPTED', 'PROVIDER_NOT_ENABLED', 'ACCOUNT_LINK_REQUIRED', 'MAILBOX_VERIFICATION_REQUIRED', 'STORAGE_UNAVAILABLE']) assert.ok(copy[locale].errors[key])
  }
})
