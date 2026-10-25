import test from 'node:test'
import assert from 'node:assert/strict'
import { pbkdf2Sync } from 'node:crypto'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret } from './fixtures.ts'

test('private Durable Object derives 600k SHA-256 correctly and rejects custom parameters', async () => {
  const proxy = await getRustProxy({ AUTH_ORIGIN: 'http://127.0.0.1:8787' })
  try {
    const namespace = proxy.env.PASSWORD_KDF!
    const stub = namespace.get(namespace.newUniqueId())
    const password = 'fixed-test-密码-é'
    const salt = '000102030405060708090a0b0c0d0e0f'
    async function derive(body: unknown) {
      return stub.fetch('https://password-kdf.internal/derive', { method: 'POST', body: JSON.stringify(body) })
    }
    const response = await derive({ password, salt })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pbkdf2Sync(password, Buffer.from(salt, 'hex'), 600000, 32, 'sha256'))
    for (const body of [
      { password, salt, iterations: 1 },
      { password, salt: '00' },
      { password, salt: 'zz'.repeat(16) },
      { password: 'x'.repeat(513), salt },
      { password: 'x'.repeat(5000), salt },
      { salt },
    ]) assert.equal((await derive(body)).status, 400)
    assert.equal((await stub.fetch('https://password-kdf.internal/derive')).status, 404)
    assert.equal((await stub.fetch('https://password-kdf.internal/other', { method: 'POST' })).status, 404)
    await initializeLocalRuntime(proxy)
    const publicAttempt = await proxy.fetch(new Request('http://127.0.0.1:8787/derive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, salt }),
    }))
    assert.notEqual(publicAttempt.status, 200)
  } finally { await proxy.dispose() }
})

test('missing KDF fails closed without creating accounts or authenticating a transaction', async () => {
  const origin = 'http://127.0.0.1:8787'
  const proxy = await getRustProxy({ AUTH_ORIGIN: origin }, undefined, undefined, { passwordKdf: false })
  try {
    await initializeLocalRuntime(proxy)
    const before = await proxy.env.DB.prepare('SELECT count(*) n FROM auth_user').first()
    async function post(path: string, body: unknown, transaction?: string) {
      return proxy.fetch(new Request(origin + path, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(transaction ? { 'X-Auth-Transaction': transaction } : {}) },
        body: JSON.stringify(body),
      }))
    }
    const flow = await post('/api/v1/auth/transactions', {
      clientId: 'molis-auth-console', redirectUri: origin + '/console/callback', codeChallenge: secret(), codeChallengeMethod: 'S256', state: secret(), scopes: ['account'],
    })
    const { data } = await flow.json()
    const password = 'unique-test-password-with-entropy'
    const signup = await post('/api/v1/auth/transactions/signup', { email: 'failure@example.test', password, confirmPassword: password }, data.transaction)
    assert.equal(signup.status, 503)
    assert.equal((await signup.json()).error.code, 'AUTH_UNAVAILABLE')
    assert.deepEqual(await proxy.env.DB.prepare('SELECT count(*) n FROM auth_user').first(), before)
    const login = await post('/api/v1/auth/transactions/password', { email: 'failure@example.test', password }, data.transaction)
    assert.equal(login.status, 503)
    assert.equal((await login.json()).error.code, 'AUTH_UNAVAILABLE')
    const transaction = await proxy.env.DB.prepare('SELECT status FROM auth_transaction').first()
    assert.equal(transaction!.status, 'READY')
  } finally { await proxy.dispose() }
})
