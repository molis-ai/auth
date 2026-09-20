import test from 'node:test'
import assert from 'node:assert/strict'
import { pbkdf2Sync } from 'node:crypto'
import { localCredential } from '../scripts/local-credential.mjs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge } from './fixtures.ts'

test('local admin bootstrap uses Rust policy and compatible password encoding', async () => {
  const password = 'migration-test-密码-e\u0301'
  const result = await localCredential(' Admin@Example.com ', password)
  assert.equal(result.email, 'admin@example.com')
  assert.match(result.encoded, /^\{pbkdf2-sha256-600k-v1\}[a-f0-9]{96}$/)
  const bytes = Buffer.from(result.encoded.split('}')[1], 'hex')
  const derived = pbkdf2Sync(
    password.normalize('NFC'),
    bytes.subarray(0, 16),
    600_000,
    32,
    'sha256',
  )
  assert.deepEqual(bytes.subarray(16), derived)
  await assert.rejects(localCredential('invalid-email', password), /INVALID_EMAIL/)
  await assert.rejects(localCredential('admin@example.com', 'password123'), /PASSWORD_BLOCKED/)
})

test('Rust authenticates deployed JDK/TS password records', async () => {
  const origin = 'http://127.0.0.1:8787'
  const proxy = await getRustProxy({ AUTH_ORIGIN: origin })
  try {
    await initializeLocalRuntime(proxy)
    const db = proxy.env.DB
    // Independently generated with JDK 21 SecretKeyFactory/PBEKeySpec.
    const encoded =
      '{pbkdf2-sha256-600k-v1}000102030405060708090a0b0c0d0e0f08acf49901aaf21cdef94f9532bb327863e74f577a312f971f4e7098044612fe'
    await db.batch([
      db.prepare(
        "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES ('legacy','Legacy','ACTIVE',0,0)",
      ),
      db.prepare(
        "INSERT INTO auth_user_email(id,user_id,canonical_email,created_at) VALUES ('email','legacy','legacy@example.test',0)",
      ),
      db.prepare("INSERT INTO auth_local_credential VALUES ('legacy',?,0)").bind(encoded),
    ])
    async function post(path: string, body: unknown, transaction?: string) {
      return proxy.fetch(
        new Request(origin + path, {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            ...(transaction ? { 'X-Auth-Transaction': transaction } : {}),
          },
          body: JSON.stringify(body),
        }),
      )
    }
    for (const [password, expected] of [
      ['migration-test-密码-e\u0301', 200],
      ['wrong-password', 401],
    ] as const) {
      const response = await post('/api/v1/auth/transactions', {
        clientId: 'molis-auth-console',
        redirectUri: origin + '/console/callback',
        codeChallenge: challenge(secret()),
        codeChallengeMethod: 'S256',
        state: secret(),
        scopes: ['account'],
      })
      const { data } = await response.json()
      const login = await post(
        '/api/v1/auth/transactions/password',
        { email: 'legacy@example.test', password },
        data.transaction,
      )
      assert.equal(login.status, expected, await login.text())
    }
  } finally {
    await proxy.dispose()
  }
})
