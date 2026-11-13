import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge } from './fixtures.ts'

test('LIVE SMS: shared Auth challenges, provider validation, replay and cancellation fencing', async () => {
  const origin = 'http://127.0.0.1:8787',
    target = '+8613800000000',
    key = secret()
  let verdict = 'UNKNOWN',
    sends = 0,
    checks = 0,
    duringCheck: (() => Promise<void>) | undefined
  const p = await getRustProxy(
    {
      AUTH_ORIGIN: origin,
      ALIYUN_ACCESS_KEY_ID: 'test-key',
      ALIYUN_ACCESS_KEY_SECRET: key,
      ALIYUN_SMS_SIGN_NAME: 'Test signature',
      ALIYUN_SMS_TEST_ALLOWLIST: target,
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
        environmentId: 'unified-local',
        kind: 'LOCAL',
        authOrigin: origin,
        deliveryMode: 'LIVE',
        providerMode: 'MOCK',
      }),
    },
    async (request: Request) => {
      assert.equal(request.url, 'https://dypnsapi.aliyuncs.com/')
      assert.equal(request.method, 'POST')
      const form = new URLSearchParams(await request.text()),
        signature = form.get('Signature')
      form.delete('Signature')
      const enc = (s: string) =>
        encodeURIComponent(s).replace(
          /[!'()*]/g,
          (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
        )
      const canonical = [...form]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => enc(k) + '=' + enc(v))
        .join('&')
      assert.equal(
        signature,
        createHmac('sha1', key + '&')
          .update('POST&%2F&' + enc(canonical))
          .digest('base64'),
      )
      assert.equal(form.get('PhoneNumber'), '13800000000')
      assert.equal(form.get('SchemeName')?.length, 20)
      if (form.get('Action') === 'SendSmsVerifyCode') {
        sends++
        assert.equal(form.get('TemplateCode'), '100001')
        assert.equal(form.get('ReturnVerifyCode'), 'false')
        assert.deepEqual(JSON.parse(form.get('TemplateParam')!), { code: '##code##', min: '5' })
        return Response.json({ Code: 'OK', Success: true, Model: { BizId: 'test' } })
      }
      checks++
      if (duringCheck) await duringCheck()
      if (verdict === 'VALIDATE_FAIL')
        return Response.json({ Code: 'isv.ValidateFail', Success: false }, { status: 400 })
      if (verdict === 'DENIED')
        return Response.json({ Code: 'Forbidden.NoPermission' }, { status: 403 })
      return Response.json({ Code: 'OK', Success: true, Model: { VerifyResult: verdict } })
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
    async function begin() {
      await db.prepare('DELETE FROM auth_rate_bucket').run()
      const proof = secret()
      const r = await api('/auth/transactions', {
        clientId: 'molis-work-unified-local',
        purpose: 'LOGIN',
        method: 'PHONE_OTP',
        redirectUri: 'http://127.0.0.1:4207/account/callback',
        state: secret(),
        codeChallenge: challenge(secret()),
        codeChallengeMethod: 'S256',
        initiatorChallenge: challenge(proof),
      })
      assert.equal(r.status, 200, JSON.stringify(r))
      return { proof, path: '/auth/transactions/' + r.data.transactionId }
    }
    const t = await begin()
    const sent = await api(t.path + '/challenges', { channel: 'SMS', address: target }, t.proof)
    assert.equal(sent.status, 200, JSON.stringify(sent))
    const path = t.path + '/challenges/' + sent.data.challengeId + '/verify'
    const row = await db
      .prepare('SELECT * FROM auth_verification_challenge WHERE id=?')
      .bind(sent.data.challengeId)
      .first()
    assert.equal(row.credential_hash, '')
    assert.equal(row.verifier, 'ALIYUN')
    assert.equal((await db.prepare('SELECT count(*) n FROM auth_mock_delivery').first()).n, 0)
    assert.equal((await api(path, { credential: '123456' }, t.proof)).status, 401) // Code OK alone is not verification
    verdict = 'VALIDATE_FAIL'
    const invalid = await api(path, { credential: '123456' }, t.proof)
    assert.equal(invalid.status, 401, JSON.stringify(invalid))
    assert.match(JSON.stringify(invalid), /INVALID_CREDENTIALS/)
    verdict = 'DENIED'
    assert.equal((await api(path, { credential: '123456' }, t.proof)).status, 503)
    verdict = 'PASS'
    const verified = await api(path, { credential: '123456' }, t.proof)
    assert.equal(verified.status, 200, JSON.stringify(verified))
    assert.equal((await api(path, { credential: '123456' }, t.proof)).status, 401)
    assert.equal(checks, 4)
    const login = await api(
      t.path + '/phone',
      { verificationProof: verified.data.verificationProof },
      t.proof,
    )
    assert.equal(login.status, 200, JSON.stringify(login))
    const next = await begin()
    const pending = await api(
      next.path + '/challenges',
      { channel: 'SMS', address: target },
      next.proof,
    )
    assert.equal(pending.status, 200, JSON.stringify(pending))
    duringCheck = async () => {
      await db
        .prepare('UPDATE auth_verification_challenge SET invalidated_at=? WHERE id=?')
        .bind(Date.now(), pending.data.challengeId)
        .run()
    }
    assert.notEqual(
      (
        await api(
          next.path + '/challenges/' + pending.data.challengeId + '/verify',
          { credential: '123456' },
          next.proof,
        )
      ).status,
      200,
    )
    duringCheck = undefined
    const exhausted = await begin()
    const e = await api(
      exhausted.path + '/challenges',
      { channel: 'SMS', address: target },
      exhausted.proof,
    )
    assert.equal(e.status, 200, JSON.stringify(e))
    const ep = exhausted.path + '/challenges/' + e.data.challengeId + '/verify'
    verdict = 'UNKNOWN'
    for (let i = 0; i < 5; i++)
      assert.equal((await api(ep, { credential: '123456' }, exhausted.proof)).status, 401)
    const before = checks
    verdict = 'PASS'
    assert.equal((await api(ep, { credential: '123456' }, exhausted.proof)).status, 401)
    assert.equal(checks, before)
    const denied = await begin()
    assert.equal(
      (
        await api(
          denied.path + '/challenges',
          { channel: 'SMS', address: '+8613800000001' },
          denied.proof,
        )
      ).status,
      503,
    )
    assert.equal(sends, 3)
  } finally {
    await p.dispose()
  }
})
