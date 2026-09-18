import { test } from 'node:test'
import assert from 'node:assert/strict'
import { platform, ConsoleError, checkedConsole, callbackLines, listPath, takeConsoleArrival } from '../src/console-api.ts'
import { consoleCopy } from '../src/console-copy.ts'
const client = { async getAccessToken() { return 'test-user-bearer' } }
test('console callback URL is cleared synchronously while the SDK retains only an in-memory snapshot', () => {
  const calls: unknown[][] = [], address = { href: 'https://auth.example/console/callback?code=secret&state=nonce', pathname: '/console/callback' }
  assert.equal(takeConsoleArrival(address, { replaceState: (...args: unknown[]) => calls.push(args) }), address.href)
  assert.deepEqual(calls, [[null, '', '/console/callback']])
})
test('console configuration cannot change the issuer or registered callback destination', () => {
  const value = { authOrigin: 'https://auth.example', console: { enabled: true, clientId: 'console', redirectUri: 'https://auth.example/console/callback' } }
  assert.equal(checkedConsole(value, value.authOrigin)?.clientId, 'console')
  assert.throws(() => checkedConsole(value, 'https://other.example'), ConsoleError)
  assert.throws(() => checkedConsole({ ...value, console: { ...value.console, redirectUri: 'https://evil.example/console/callback' } }, value.authOrigin), ConsoleError)
  assert.equal(checkedConsole({ ...value, console: { enabled: false, clientId: null, redirectUri: null } }, value.authOrigin), null)
})
test('platform transport sends only explicit bearer on same-origin requests and never cookies', async () => {
  let calls = 0
  const result = await platform(client, '/applications', 'POST', { name: 'A', actions: [] }, async (url, options) => {
    calls++; assert.equal(url, '/api/v1/platform/applications'); assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error'); assert.equal(options?.cache, 'no-store')
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-user-bearer')
    return new Response(JSON.stringify({ data: { id: 'app' } }))
  })
  assert.deepEqual(result, { id: 'app' }); assert.equal(calls, 1)
})
test('lost write responses are uncertain and never retried or exposed in errors', async () => {
  let calls = 0
  await assert.rejects(platform(client, '/services/svc_test/rotate', 'POST', {}, async () => { calls++; throw new Error('private-secret-response') }),
    (error: unknown) => error instanceof ConsoleError && error.uncertain && error.code === 'NETWORK_ERROR' && !error.message.includes('private-secret'))
  assert.equal(calls, 1)
  await assert.rejects(platform(client, '/users', 'GET', undefined, async () => { throw new Error('private') }),
    (error: unknown) => error instanceof ConsoleError && !error.uncertain)
})
test('version conflict is actionable but unknown error text and malformed responses are not displayed', async () => {
  await assert.rejects(platform(client, '/applications/app', 'PUT', {}, async () => new Response(JSON.stringify({ error: { code: 'VERSION_CONFLICT' }, requestId: '00000000-0000-0000-0000-000000000000' }), { status: 409 })),
    (error: unknown) => error instanceof ConsoleError && error.code === 'VERSION_CONFLICT' && !error.uncertain && error.requestId.length === 36)
  await assert.rejects(platform(client, '/applications', 'POST', {}, async () => new Response(JSON.stringify({ secret: 'private' }))),
    (error: unknown) => error instanceof ConsoleError && error.code === 'INVALID_RESPONSE' && error.uncertain)
})
test('callbacks are separate exact entries and pagination encodes cursors', () => {
  assert.deepEqual(callbackLines('https://a.example/callback\n\nhttps://b.example/callback'), ['https://a.example/callback', 'https://b.example/callback'])
  assert.throws(() => callbackLines('https://a.example/callback\nhttps://a.example/callback'), ConsoleError)
  assert.throws(() => callbackLines(''), ConsoleError)
  assert.equal(listPath('/users', 'a&limit=200'), '/users?limit=25&cursor=a%26limit%3D200')
})
test('both console locales expose the same controls and security messages', () => {
  assert.deepEqual(Object.keys(consoleCopy.en).sort(), Object.keys(consoleCopy['zh-CN']).sort())
  assert.deepEqual(Object.keys(consoleCopy.en.errors).sort(), Object.keys(consoleCopy['zh-CN'].errors).sort())
})
