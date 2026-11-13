import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge } from './fixtures.ts'

test('LIVE signup and password reset mail: shared delivery, failed delivery and late-response fencing', async () => {
  const origin = 'http://127.0.0.1:8787'
  let code = '',
    sent = 0,
    fail = false
  let expectedSubject = 'Molis 注册验证码'
  let duringSend: (() => Promise<void>) | undefined
  const p = await getRustProxy(
    {
      AUTH_ORIGIN: origin,
      ALIYUN_ACCESS_KEY_ID: 'test-key',
      ALIYUN_ACCESS_KEY_SECRET: secret(),
      ALIYUN_MAIL_REGION: 'cn-hangzhou',
      ALIYUN_MAIL_ACCOUNT_NAME: 'no-reply@notify.example.test',
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
        environmentId: 'unified-local',
        kind: 'LOCAL',
        authOrigin: origin,
        deliveryMode: 'LIVE',
        providerMode: 'MOCK',
      }),
    },
    async (request: Request) => {
      assert.equal(request.url, 'https://dm.aliyuncs.com/')
      assert.equal(request.method, 'POST')
      sent++
      const f = new URLSearchParams(await request.text())
      assert.equal(f.get('Action'), 'SingleSendMail')
      assert.equal(f.get('Version'), '2015-11-23')
      assert.equal(f.get('AccountName'), 'no-reply@notify.example.test')
      assert.equal(f.get('ToAddress'), 'alice@example.test')
      assert.equal(f.get('ReplyToAddress'), 'false')
      assert.equal(f.get('Subject'), expectedSubject)
      assert.equal(f.get('FromAlias'), 'Molis')
      assert.match(
        f.get('TextBody')!,
        expectedSubject.includes('注册')
          ? /你正在使用此邮箱注册 Molis 账号。/
          : /你正在重置 Molis 账号密码。/,
      )
      assert.match(f.get('TextBody')!, /请勿向他人透露验证码。/)
      code = f.get('TextBody')!.match(/\d{6}/)![0]
      if (duringSend) await duringSend()
      return fail
        ? Response.json({ Code: 'InvalidMailAddress.NotFound' }, { status: 404 })
        : Response.json({ RequestId: 'test-request', EnvId: 'test-mail' })
    },
  )
  try {
    await initializeLocalRuntime(p)
    const db = p.env.DB
    for (const sql of readFileSync(
      new URL('../unified-account-local-seed.sql', import.meta.url),
      'utf8',
    )
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run()
    await db
      .prepare("UPDATE auth_environment SET delivery_mode='LIVE' WHERE id='unified-local'")
      .run()
    async function api(path: string, body: unknown, proof?: string) {
      const r = await p.fetch(
        new Request(origin + '/api/v2' + path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': secret(),
            ...(proof ? { 'X-Auth-Initiator-Proof': proof } : {}),
          },
          body: JSON.stringify(body),
        }),
      )
      return { status: r.status, ...(await r.json()) }
    }
    async function begin(purpose = 'EMAIL_SIGNUP') {
      await db.prepare('DELETE FROM auth_rate_bucket').run()
      const proof = secret()
      const r = await api('/auth/transactions', {
        clientId: 'molis-work-unified-local',
        purpose,
        method: 'EMAIL_CODE',
        redirectUri: 'http://127.0.0.1:4207/account/callback',
        state: secret(),
        codeChallenge: challenge(secret()),
        codeChallengeMethod: 'S256',
        initiatorChallenge: challenge(proof),
      })
      assert.equal(r.status, 200, JSON.stringify(r))
      return { proof, id: r.data.transactionId, path: '/auth/transactions/' + r.data.transactionId }
    }
    const t = await begin()
    const d = await api(
      t.path + '/challenges',
      { channel: 'EMAIL', address: 'ALICE@example.test' },
      t.proof,
    )
    assert.equal(d.status, 200, JSON.stringify(d))
    assert.equal((await db.prepare('SELECT count(*) n FROM auth_mock_delivery').first()).n, 0)
    const verifyPath = t.path + '/challenges/' + d.data.challengeId + '/verify'
    const wrong = code === '000000' ? '111111' : '000000'
    assert.equal((await api(verifyPath, { credential: wrong }, t.proof)).status, 401)
    const v = await api(verifyPath, { credential: code }, t.proof)
    assert.equal(v.status, 200, JSON.stringify(v))
    assert.equal((await api(verifyPath, { credential: code }, t.proof)).status, 401)
    const signup = await api(
      t.path + '/email-signup',
      {
        email: 'alice@example.test',
        password: secret(),
        verificationProof: v.data.verificationProof,
      },
      t.proof,
    )
    assert.equal(signup.status, 200, JSON.stringify(signup))
    expectedSubject = 'Molis 密码重置验证码'
    const reset = await begin('PASSWORD_RESET')
    const resetDelivery = await api(
      reset.path + '/challenges',
      { channel: 'EMAIL', address: 'alice@example.test' },
      reset.proof,
    )
    assert.equal(resetDelivery.status, 200, JSON.stringify(resetDelivery))
    const resetVerify = await api(
      reset.path + '/challenges/' + resetDelivery.data.challengeId + '/verify',
      { credential: code },
      reset.proof,
    )
    assert.equal(resetVerify.status, 200, JSON.stringify(resetVerify))
    const resetProof = await api(reset.path + '/complete', {}, reset.proof)
    assert.equal(resetProof.status, 200, JSON.stringify(resetProof))
    assert.equal(resetProof.data.kind, 'RESET_PROOF')
    const changed = await api(
      '/auth/password-reset/complete',
      {
        transactionId: reset.id,
        resetProof: resetProof.data.resetProof,
        newPassword: secret(),
      },
      reset.proof,
    )
    assert.equal(changed.status, 200, JSON.stringify(changed))
    const beforeUnknown = sent
    const unknown = await begin('PASSWORD_RESET')
    const suppressed = await api(
      unknown.path + '/challenges',
      { channel: 'EMAIL', address: 'unknown@example.test' },
      unknown.proof,
    )
    assert.equal(suppressed.status, 200)
    assert.equal(sent, beforeUnknown, 'unknown email must not receive mail')
    expectedSubject = 'Molis 注册验证码'
    const failed = await begin()
    fail = true
    assert.equal(
      (
        await api(
          failed.path + '/challenges',
          { channel: 'EMAIL', address: 'alice@example.test' },
          failed.proof,
        )
      ).status,
      503,
    )
    const q = await db
      .prepare('SELECT id,delivery_status FROM auth_verification_challenge WHERE transaction_id=?')
      .bind(failed.id)
      .first()
    assert.equal(q.delivery_status, 'PENDING')
    assert.equal(
      (
        await api(
          failed.path + '/challenges/' + q.id + '/verify',
          { credential: code },
          failed.proof,
        )
      ).status,
      401,
    )
    fail = false
    const late = await begin()
    duringSend = async () => {
      await db
        .prepare('UPDATE auth_verification_challenge SET invalidated_at=? WHERE transaction_id=?')
        .bind(Date.now(), late.id)
        .run()
    }
    assert.notEqual(
      (
        await api(
          late.path + '/challenges',
          { channel: 'EMAIL', address: 'alice@example.test' },
          late.proof,
        )
      ).status,
      200,
    )
    assert.equal(sent, 4)
  } finally {
    await p.dispose()
  }
})
