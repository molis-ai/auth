import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { challenge, secret } from './fixtures.ts'

test('ENV-10: test admission denies unlisted password and verification before delivery', async (t) => {
  const origin = 'http://127.0.0.1:8787'
  const p = await getRustProxy({
    AUTH_ORIGIN: origin,
    AUTH_TEST_ADMISSION: JSON.stringify({ emails: ['approved@example.test'], phones: [] }),
    UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
      environmentId: 'unified-local',
      kind: 'TEST',
      authOrigin: origin,
      deliveryMode: 'MOCK',
      providerMode: 'MOCK',
    }),
  })
  t.after(() => p.dispose())
  await initializeLocalRuntime(p)
  const db = p.env.DB
  const seed = readFileSync(new URL('../unified-account-local-seed.sql', import.meta.url), 'utf8')
  for (const statement of seed
    .replace(/--[^\n]*/gu, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run()
  }
  await db.prepare("UPDATE auth_environment SET kind='TEST' WHERE id='unified-local'").run()
  const post = (path: string, body: object, proof?: string) =>
    p.fetch(
      new Request(origin + '/api/v2/auth/' + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(proof ? { 'X-Auth-Initiator-Proof': proof } : {}),
        },
        body: JSON.stringify(body),
      }),
    )
  const start = () => ({
    clientId: 'molis-work-unified-local',
    redirectUri: 'http://127.0.0.1:4207/account/callback',
    state: secret(),
    codeChallengeMethod: 'S256',
    codeChallenge: challenge(secret()),
  })
  const passwordProof = secret()
  const password = await post(
    'login/password',
    {
      ...start(),
      initiatorChallenge: challenge(passwordProof),
      identifier: 'unlisted@example.test',
      password: 'Example-pass-20%',
    },
    passwordProof,
  )
  assert.equal(password.status, 403)
  for (const [purpose, method, channel, address] of [
    ['LOGIN', 'EMAIL_CODE', 'EMAIL', 'unlisted@example.test'],
    ['EMAIL_SIGNUP', 'EMAIL_CODE', 'EMAIL', 'unlisted@example.test'],
    ['PASSWORD_RESET', 'EMAIL_CODE', 'EMAIL', 'unlisted@example.test'],
    ['LOGIN', 'PHONE_OTP', 'SMS', '+8613800000000'],
  ]) {
    const proof = secret()
    const begun = await post('transactions', {
      ...start(),
      purpose,
      method,
      initiatorChallenge: challenge(proof),
    })
    assert.equal(begun.status, 200)
    const { data } = await begun.json()
    const send = await post(
      `transactions/${data.transactionId}/challenges`,
      { channel, address },
      proof,
    )
    assert.equal(send.status, 403)
  }
  assert.equal(await db.prepare('SELECT count(*) n FROM auth_mock_delivery').first('n'), 0)
})
