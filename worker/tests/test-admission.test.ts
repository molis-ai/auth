import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { challenge, secret } from './fixtures.ts'

const buildDirectory = process.env.AUTH_PRODUCTION_WASM_BUILD_DIR
const artifact = buildDirectory ? 'production WASM' : 'default WASM'

test(`ENV-10 AC-AUTH-06: ${artifact} enforces test admission before delivery`, async (t) => {
  const origin = 'http://127.0.0.1:8787'
  const approvedEmail = 'approved@example.test'
  const runtimeConfig = (mode: 'LIVE' | 'MOCK') =>
    JSON.stringify({
      environmentId: 'unified-local',
      kind: 'TEST',
      authOrigin: origin,
      deliveryMode: mode,
      providerMode: mode,
    })
  const delivered: string[] = []
  const p = await getRustProxy(
    {
      AUTH_ORIGIN: origin,
      MOLIS_ENVIRONMENT: 'test',
      UNIFIED_ACCOUNT_CONFIG: runtimeConfig('MOCK'),
      PROVIDER_STATE_KEY: secret(),
      ALIYUN_MAIL_TEST_ALLOWLIST: approvedEmail,
      ALIYUN_ACCESS_KEY_ID: 'fixture-key',
      ALIYUN_ACCESS_KEY_SECRET: secret(),
      ALIYUN_MAIL_REGION: 'cn-hangzhou',
      ALIYUN_MAIL_ACCOUNT_NAME: 'no-reply@notify.example.test',
    },
    async (request: Request) => {
      assert.ok(buildDirectory)
      assert.equal(request.url, 'https://dm.aliyuncs.com/')
      const form = new URLSearchParams(await request.text())
      assert.equal(form.get('Action'), 'SingleSendMail')
      delivered.push(form.get('ToAddress')!)
      return Response.json({ RequestId: 'fixture-mail', EnvId: 'fixture-environment' })
    },
    () => new Response('<head></head>', { headers: { 'Content-Type': 'text/html' } }),
    { buildDirectory },
  )
  t.after(() => p.dispose())
  await initializeLocalRuntime(p)
  let db = p.env.DB
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
  const password = (identifier: string) => {
    const proof = secret()
    return post(
      'login/password',
      {
        ...start(),
        initiatorChallenge: challenge(proof),
        identifier,
        password: 'Example-pass-20%',
      },
      proof,
    )
  }
  const sendChallenge = async (
    purpose: string,
    method: string,
    channel: string,
    address: string,
  ) => {
    const proof = secret()
    const begun = await post('transactions', {
      ...start(),
      purpose,
      method,
      initiatorChallenge: challenge(proof),
    })
    assert.equal(begun.status, 200)
    const { data } = await begun.json()
    return post(`transactions/${data.transactionId}/challenges`, { channel, address }, proof)
  }

  const missing = await password(approvedEmail)
  assert.equal(missing.status, 503)
  assert.equal((await missing.json()).error.code, 'UNIFIED_CONFIGURATION_INVALID')
  db = await p.updateBindings({
    AUTH_TEST_ADMISSION: JSON.stringify({ emails: [approvedEmail], phones: [] }),
  })

  if (buildDirectory) {
    const capabilities = await p.fetch(
      new Request(origin + '/api/v2/auth/capabilities?clientId=molis-work-unified-local'),
    )
    assert.equal(capabilities.status, 200)
    assert.deepEqual((await capabilities.json()).data.methods, ['ACCOUNT_PASSWORD'])
    const page = await p.fetch(new Request(origin + '/console'))
    assert.equal(page.status, 200)
    assert.match(await page.text(), /name="molis-tenant-invite-channels" content="USER"/)

    for (const purpose of ['LOGIN', 'PASSWORD_RESET']) {
      const unsupported = await sendChallenge(purpose, 'EMAIL_CODE', 'EMAIL', approvedEmail)
      assert.equal(unsupported.status, 503)
      assert.equal((await unsupported.json()).error.code, 'UPSTREAM_UNAVAILABLE')
    }
    db = await p.updateBindings({ UNIFIED_ACCOUNT_CONFIG: runtimeConfig('LIVE') })
    await db.prepare("UPDATE auth_environment SET delivery_mode='LIVE',provider_mode='LIVE'").run()
  }

  const deniedPassword = await password('unlisted@example.test')
  assert.equal(deniedPassword.status, 403)
  assert.equal((await deniedPassword.json()).error.code, 'FORBIDDEN')
  for (const [purpose, method, channel, address] of [
    ['LOGIN', 'EMAIL_CODE', 'EMAIL', 'unlisted@example.test'],
    ['EMAIL_SIGNUP', 'EMAIL_CODE', 'EMAIL', 'unlisted@example.test'],
    ['PASSWORD_RESET', 'EMAIL_CODE', 'EMAIL', 'unlisted@example.test'],
    ['LOGIN', 'PHONE_OTP', 'SMS', '+8613800000000'],
  ]) {
    const denied = await sendChallenge(purpose, method, channel, address)
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'FORBIDDEN')
  }
  assert.deepEqual(delivered, [])
  assert.equal(await db.prepare('SELECT count(*) n FROM auth_verification_challenge').first('n'), 0)
  assert.equal(await db.prepare('SELECT count(*) n FROM auth_mock_delivery').first('n'), 0)

  const allowed = await sendChallenge('EMAIL_SIGNUP', 'EMAIL_CODE', 'EMAIL', approvedEmail)
  assert.equal(allowed.status, 200)
  const { data } = await allowed.json()
  assert.equal(
    await db
      .prepare('SELECT delivery_status FROM auth_verification_challenge WHERE id=?')
      .bind(data.challengeId)
      .first('delivery_status'),
    'ACCEPTED',
  )
  assert.deepEqual(delivered, buildDirectory ? [approvedEmail] : [])
  assert.equal(
    await db.prepare('SELECT count(*) n FROM auth_mock_delivery').first('n'),
    buildDirectory ? 0 : 1,
  )
})
