import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api, ApiError, checkedCallback, checkedHandoff, readFragment, takeFragment, rememberEmail, type Context } from '../src/protocol.ts'

const token = 't'.repeat(43)
const context: Context = { id: 'fixture', clientId: 'web', clientType: 'WEB', redirectUri: 'https://product.example/callback?locale=en', challenge: token, state: 's'.repeat(43), scopes: ['account'], forceLogin: false }
test('fragment secrets are removed even when a link is malformed', () => {
  const replacements: unknown[] = []
  const history = { replaceState: (...args: unknown[]) => { replacements.push(args) } }
  assert.deepEqual(takeFragment({ hash: '#transaction=' + token, pathname: '/login' }, history, 'login'), { transaction: token })
  assert.equal(takeFragment({ hash: '#token=invalid', pathname: '/verify-email' }, history, 'verify-email'), null)
  assert.deepEqual(replacements, [[null, '', '/login'], [null, '', '/verify-email']])
})
test('fragments require exact secret fields and reject duplicates/unknown fields', () => {
  assert.deepEqual(readFragment('#transaction=' + token, 'login'), { transaction: token })
  assert.equal(readFragment('#transaction=' + token + '&transaction=' + token, 'login'), null)
  assert.equal(readFragment('#transaction=' + token + '&redirect=https://evil.example', 'login'), null)
  assert.equal(readFragment('#transaction=short', 'login'), null)
  assert.deepEqual(readFragment('#challenge=' + token + '&token=' + token, 'verify-email'), { challenge: token, token })
})
test('handoff only navigates to the exact Auth origin and current transaction', () => {
  assert.equal(checkedHandoff('https://auth.example/complete#transaction=' + token, token, 'https://auth.example'), 'https://auth.example/complete#transaction=' + token)
  for (const url of ['https://evil.example/complete#transaction=' + token, 'javascript:alert(1)', 'https://auth.example/complete#transaction=' + 'x'.repeat(43)]) assert.throws(() => checkedHandoff(url, token, 'https://auth.example'))
})
test('callback must match immutable redirect, code and client state', () => {
  const url = context.redirectUri + '&code=' + token + '&state=' + context.state
  assert.equal(checkedCallback(url, context), url)
  for (const wrong of [url.replace('product.example', 'evil.example'), url + '&extra=value', url.replace(context.state, 'x'.repeat(43)), url.replace('/callback', '/other')]) assert.throws(() => checkedCallback(wrong, context))
})
test('requests use same-origin credentials and header secrets, not query parameters', async () => {
  await api('/transactions/password', token, { email: 'fixture@example.test', password: 'test-only password' }, async (url, init) => {
    assert.equal(url, '/api/v1/auth/transactions/password'); assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store')
    assert.equal((init?.headers as Record<string,string>)['X-Auth-Transaction'], token)
    assert.equal(init?.redirect, 'error')
    return Response.json({ data: { continueUrl: 'test-only' } })
  })
})
test('lost responses are not automatically retried or exposed as success', async () => {
  let calls = 0
  await assert.rejects(api('/transactions/complete', token, {}, async () => { calls++; throw new Error('private network detail') }), (error: ApiError) => error.code === 'NETWORK_ERROR' && !error.message.includes('private'))
  assert.equal(calls, 1)
})
test('API errors only expose safe codes/request IDs and bounded retry hints', async () => {
  await assert.rejects(api('/transactions/mailbox', token, {}, async () => Response.json({ error: { code: 'RATE_LIMITED' }, requestId: 'not-an-id', detail: 'secret' }, { status: 429, headers: { 'Retry-After': '999999' } })), (error: ApiError) => error.code === 'RATE_LIMITED' && error.requestId === '' && error.retryAfter === 3600)
})
test('remembering an account stores only its display email and is optional', () => {
  const values = new Map<string,string>()
  const storage = { setItem: (k:string,v:string) => { values.set(k,v) }, removeItem: (k:string) => { values.delete(k) } }
  rememberEmail(storage, true, 'fixture@example.test'); assert.deepEqual([...values], [['molis.auth.remembered-email','fixture@example.test']])
  rememberEmail(storage, false, 'fixture@example.test'); assert.equal(values.size,0)
  rememberEmail({ setItem: () => { throw new Error() }, removeItem: () => {} }, true, 'fixture@example.test')
})
