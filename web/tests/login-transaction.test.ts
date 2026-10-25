import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { prepareLoginTransaction } from '../src/login-transaction.ts'
import { ApiError, type View } from '../src/protocol.ts'
import type { AuthOptions } from '../../sdk/browser/src/index.ts'

function fixture() {
  const origin = 'https://auth.example.test', storage = new Map<string, string>()
  const requests: any[] = []
  let time = 0
  const options: AuthOptions = {
    issuer: origin, clientId: 'molis-auth-console', redirectUri: origin + '/console/callback', scopes: ['account', 'profile'],
    environment: {
      storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } },
      crypto: webcrypto as unknown as Crypto, now: () => time, currentUrl: () => origin + '/register',
      navigate: () => assert.fail('Keep the form on screen'), replaceUrl: () => {},
      fetch: async (url, request) => {
        assert.equal(url, origin + '/api/v1/auth/transactions')
        requests.push(JSON.parse(String(request?.body)))
        const transaction = String(requests.length).repeat(43)
        return Response.json({ data: { transaction, loginUrl: origin + '/login#transaction=' + transaction } })
      },
    },
  }
  const context = async (_path: string, transaction: string): Promise<View> => {
    assert.equal(transaction, String(requests.length).repeat(43))
    const request = requests.at(-1)
    return { status: 'READY', context: { id: transaction, clientId: request.clientId, redirectUri: request.redirectUri, clientType: 'WEB',
      forceLogin: request.forceLogin, challenge: request.codeChallenge, state: request.state, scopes: request.scopes } }
  }
  return { options, requests, storage, context, advance: (ms: number) => { time += ms } }
}

test('direct submissions start fresh PKCE at action time, including retries after a long pause', async () => {
  const f = fixture()
  f.advance(20 * 60_000)
  assert.equal(f.requests.length, 0)
  const first = await prepareLoginTransaction(f.options, { transaction: '' }, f.context)
  const pending = () => JSON.parse([...f.storage.entries()].find(([key]) => key.endsWith(':pending'))![1])
  assert.equal(pending().createdAt, 20 * 60_000)
  assert.equal(f.requests[0].forceLogin, true)
  assert.equal(f.requests[0].codeChallengeMethod, 'S256')
  const firstVerifier = pending().verifier
  f.advance(20 * 60_000)
  const second = await prepareLoginTransaction(f.options, first, f.context)
  assert.equal(pending().createdAt, 40 * 60_000)
  assert.notEqual(second.transaction, first.transaction)
  assert.notEqual(pending().verifier, firstVerifier)
  assert.notEqual(f.requests[1].codeChallenge, f.requests[0].codeChallenge)
  assert.notEqual(f.requests[1].state, f.requests[0].state)
})

test('application entry keeps its original transaction, callback, scopes and PKCE', async () => {
  const f = fixture()
  const original = await prepareLoginTransaction(f.options, { transaction: '' }, f.context)
  original.view.context.clientId = 'external-app'
  original.view.context.redirectUri = 'https://product.example/callback'
  f.advance(20 * 60_000)
  const ready = await prepareLoginTransaction(undefined, original, async () => assert.fail('Do not replace application transactions'))
  assert.equal(ready.transaction, original.transaction)
  assert.equal(ready.view, original.view)
  assert.equal(f.requests.length, 1)
})

test('missing and consumed application transactions never fall back to console login', async () => {
  const f = fixture()
  const original = await prepareLoginTransaction(f.options, { transaction: '' }, f.context)
  for (const current of [{ transaction: '' }, { transaction: 'broken', view: original.view },
    { transaction: original.transaction, view: { ...original.view, status: 'CONSUMED' } }]) {
    await assert.rejects(prepareLoginTransaction(undefined, current), (error: ApiError) => error.code === 'INVALID_TRANSACTION')
  }
  assert.equal(f.requests.length, 1)
})

test('direct preparation rejects mismatched context and never retries a failed begin', async () => {
  const f = fixture()
  await assert.rejects(prepareLoginTransaction(f.options, { transaction: '' }, async (...args) => {
    const view = await f.context(...args)
    view.context.redirectUri = 'https://other.example/callback'
    return view
  }), (error: ApiError) => error.code === 'INVALID_TRANSACTION')
  let calls = 0
  f.options.environment!.fetch = async () => { calls++; throw new Error('synthetic lost response') }
  await assert.rejects(prepareLoginTransaction(f.options, { transaction: '' }, f.context), /RESULT_UNKNOWN/)
  assert.equal(calls, 1)
})
