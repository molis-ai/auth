import test from 'node:test'
import assert from 'node:assert/strict'
import { pbkdf2Sync } from 'node:crypto'
import { localCredential } from '../scripts/local-credential.mjs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge } from './fixtures.ts'

test('local admin bootstrap uses current Rust policy and password encoding', async () => {
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
  await assert.rejects(localCredential('invalid-email', password), /INVALID_REQUEST/)
  await assert.rejects(localCredential('admin@example.com', 'password123'), /INVALID_REQUEST/)
})

test('V2 authenticates a known PBKDF2 encoding vector and rejects a wrong password', async () => {
  const origin = 'http://127.0.0.1:8787'
  const proxy = await getRustProxy({
    AUTH_ORIGIN: origin,
    UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
      environmentId: 'unified-local',
      kind: 'LOCAL',
      authOrigin: origin,
      deliveryMode: 'MOCK',
      providerMode: 'MOCK',
    }),
  })
  try {
    await initializeLocalRuntime(proxy)
    const db = proxy.env.DB
    // Independently generated with JDK 21 SecretKeyFactory/PBEKeySpec.
    const encoded =
      '{pbkdf2-sha256-600k-v1}000102030405060708090a0b0c0d0e0f08acf49901aaf21cdef94f9532bb327863e74f577a312f971f4e7098044612fe'
    await db.batch([
      db.prepare(
        "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES ('vector','Vector','ACTIVE',0,0)",
      ),
      db.prepare(
        "INSERT INTO auth_user_email(id,user_id,canonical_email,created_at) VALUES ('email','vector','vector@example.test',0)",
      ),
      db.prepare("INSERT INTO auth_local_credential VALUES ('vector',?,0)").bind(encoded),
    ])
    async function post(path: string, body: unknown, transaction?: string) {
      return proxy.fetch(
        new Request(origin + path, {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            ...(transaction ? { 'X-Auth-Initiator-Proof': transaction } : {}),
          },
          body: JSON.stringify(body),
        }),
      )
    }
    await db.prepare('UPDATE auth_user_email SET verified_at=0').run()
    await db.prepare("INSERT INTO auth_user_security(user_id,updated_at) VALUES ('vector',0)").run()
    for (const [password, expected] of [
      ['migration-test-密码-e\u0301', 200],
      ['wrong-password', 401],
    ] as const) {
      const proof = secret()
      const response = await post('/api/v2/auth/transactions', {
        clientId: 'molis-auth-web-local',
        redirectUri: origin + '/account/callback',
        codeChallenge: challenge(secret()),
        codeChallengeMethod: 'S256',
        state: secret(),
        purpose: 'LOGIN',
        method: 'EMAIL_PASSWORD',
        initiatorChallenge: challenge(proof),
      })
      const { data } = await response.json()
      const login = await post(
        '/api/v2/auth/transactions/' + data.transactionId + '/password',
        { email: 'vector@example.test', password },
        proof,
      )
      assert.equal(login.status, expected, await login.text())
    }
  } finally {
    await proxy.dispose()
  }
})
