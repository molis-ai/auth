import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, hash, challenge } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

test('AUTH-04 email/password and phone: real verification, isolated mock deliveries and one-use credentials', async () => {
  const origin = 'http://127.0.0.1:8787'
  const p = await getRustProxy({
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
    await initializeLocalRuntime(p)
    const db = p.env.DB
    for (const s of readFileSync(
      new URL('../unified-account-local-seed.sql', import.meta.url),
      'utf8',
    )
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(s).run()
    const password = 'Fixture-Neptune-7-Cloud'
    async function call(path: string, body?: unknown, proof?: string, access?: string) {
      const r = await p.fetch(
        new Request(origin + '/api/v2' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(proof ? { 'X-Auth-Initiator-Proof': proof } : {}),
            ...(access ? { Authorization: 'Bearer ' + access } : {}),
            'Idempotency-Key': secret(),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      return { status: r.status, ...(await r.json()) }
    }
    async function begin(purpose = 'EMAIL_SIGNUP', method = 'EMAIL_CODE', club = false) {
      const proof = secret(),
        verifier = secret()
      const b = {
        clientId: club ? 'molis-club-unified-local' : 'molis-work-unified-local',
        purpose,
        method,
        redirectUri: club
          ? 'http://127.0.0.1:3000/account/callback'
          : 'http://127.0.0.1:4207/account/callback',
        state: secret(),
        codeChallenge: challenge(verifier),
        codeChallengeMethod: 'S256',
        initiatorChallenge: challenge(proof),
      }
      const r = await call('/auth/transactions', b)
      assert.equal(r.status, 200, JSON.stringify(r))
      assert.ok(validateNamed('TransactionCreated', r.data))
      return {
        ...b,
        proof,
        verifier,
        id: r.data.transactionId,
        path: '/auth/transactions/' + r.data.transactionId,
      }
    }
    async function send(t: any, address: string, channel = 'EMAIL') {
      const r = await call(t.path + '/challenges', { channel, address }, t.proof)
      assert.equal(r.status, 200, JSON.stringify(r))
      assert.ok(validateNamed('ChallengeCreated', r.data))
      const q = await db
        .prepare(
          'SELECT m.credential FROM auth_mock_delivery m JOIN auth_verification_challenge c ON c.delivery_id=m.delivery_id WHERE c.id=?',
        )
        .bind(r.data.challengeId)
        .first()
      return { ...r.data, credential: q?.credential }
    }
    async function verify(t: any, d: any) {
      const r = await call(
        t.path + '/challenges/' + d.challengeId + '/verify',
        { credential: d.credential },
        t.proof,
      )
      assert.equal(r.status, 200, JSON.stringify(r))
      assert.ok(validateNamed('VerificationResult', r.data))
      return r.data.verificationProof
    }
    async function finish(t: any) {
      const r = await call(t.path + '/complete', {}, t.proof)
      assert.equal(r.status, 200, JSON.stringify(r))
      assert.ok(validateNamed('TransactionCompleteResult', r.data))
      assert.equal(r.data.state, t.state)
      const token = await call('/auth/token', {
        grantType: 'authorization_code',
        clientId: t.clientId,
        code: r.data.code,
        redirectUri: t.redirectUri,
        codeVerifier: t.verifier,
      })
      assert.equal(token.status, 200, JSON.stringify(token))
      assert.ok(validateNamed('TokenSet', token.data))
      return token.data
    }
    async function cooldown() {
      await db.prepare('DELETE FROM auth_rate_bucket').run()
    }
    const t = await begin()
    assert.equal((await call(t.path, undefined, secret())).status, 401)
    assert.equal(
      (
        await call(
          t.path + '/email-signup',
          { email: 'alice@example.test', password, verificationProof: secret() },
          t.proof,
        )
      ).status,
      401,
    )
    assert.equal((await db.prepare('SELECT count(*) n FROM auth_user').first()).n, 0)
    const delivered = await send(t, 'ALICE@example.test')
    assert.match(delivered.credential, /^[0-9]{6}$/)
    assert.equal(
      (
        await call(
          t.path + '/challenges',
          { channel: 'EMAIL', address: 'alice@example.test' },
          t.proof,
        )
      ).status,
      429,
    )
    const throttled = await call(
      t.path + '/challenges',
      { channel: 'EMAIL', address: 'alice@example.test' },
      t.proof,
    )
    assert.ok(validateNamed('Error429', { error: throttled.error, requestId: throttled.requestId }))
    const vp = await verify(t, delivered)
    assert.equal(
      (
        await call(
          t.path + '/challenges/' + delivered.challengeId + '/verify',
          { credential: delivered.credential },
          t.proof,
        )
      ).status,
      401,
    )
    assert.equal(
      (
        await call(
          t.path + '/email-signup',
          { email: 'wrong@example.test', password, verificationProof: vp },
          t.proof,
        )
      ).status,
      400,
    )
    assert.equal(
      (
        await call(
          t.path + '/email-signup',
          { email: 'alice@example.test', password, verificationProof: vp },
          t.proof,
        )
      ).status,
      200,
    )
    const registered = await finish(t)
    assert.equal((await call(t.path + '/complete', {}, t.proof)).status, 409)
    const u = await db
      .prepare(
        "SELECT u.id,u.display_name,e.verified_at FROM auth_user u JOIN auth_user_email e ON e.user_id=u.id WHERE e.canonical_email='alice@example.test'",
      )
      .first()
    assert.ok(u.verified_at)
    assert.equal(u.display_name, 'Molis 用户')
    const login = await begin('LOGIN', 'EMAIL_PASSWORD', true)
    assert.equal(
      (
        await call(
          login.path + '/password',
          { email: 'alice@example.test', password: 'wrong' },
          login.proof,
        )
      ).status,
      401,
    )
    assert.equal(
      (await call(login.path + '/password', { email: 'alice@example.test', password }, login.proof))
        .status,
      200,
    )
    const logged = await finish(login)
    assert.notEqual(logged.session.loginSessionId, registered.session.loginSessionId)
    const phone = await begin('LOGIN', 'PHONE_OTP')
    const sms = await send(phone, '+8613800000001', 'SMS')
    const phoneProof = await verify(phone, sms)
    assert.equal(
      (await call(phone.path + '/phone', { verificationProof: phoneProof }, phone.proof)).status,
      200,
    )
    await finish(phone)
    assert.equal((await db.prepare('SELECT count(*) n FROM auth_user_phone').first()).n, 1)
    assert.equal((await db.prepare('SELECT count(*) n FROM auth_user_email').first()).n, 1)
    await cooldown()
    const again = await begin('LOGIN', 'PHONE_OTP', true)
    const sms2 = await send(again, '+8613800000001', 'SMS')
    const pp2 = await verify(again, sms2)
    assert.equal(
      (await call(again.path + '/phone', { verificationProof: pp2 }, again.proof)).status,
      200,
    )
    await finish(again)
    assert.equal((await db.prepare('SELECT count(*) n FROM auth_user').first()).n, 2)
    const lock = await begin()
    const mail = await send(lock, 'lock@example.test')
    const wrong = mail.credential === '000000' ? '000001' : '000000'
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await call(
            lock.path + '/challenges/' + mail.challengeId + '/verify',
            { credential: wrong },
            lock.proof,
          )
        ).status,
        401,
      )
    assert.equal(
      (
        await call(
          lock.path + '/challenges/' + mail.challengeId + '/verify',
          { credential: mail.credential },
          lock.proof,
        )
      ).status,
      401,
    )
    await cooldown()
    const resent = await send(lock, 'lock@example.test')
    assert.equal(
      (
        await call(
          lock.path + '/challenges/' + mail.challengeId + '/verify',
          { credential: mail.credential },
          lock.proof,
        )
      ).status,
      401,
    )
    const validNew = await verify(lock, resent)
    const other = await begin()
    assert.equal(
      (
        await call(
          other.path + '/email-signup',
          { email: 'lock@example.test', password, verificationProof: validNew },
          other.proof,
        )
      ).status,
      401,
    )
    assert.equal((await call(lock.path + '/cancel', {}, lock.proof)).status, 200)
    assert.equal(
      (
        await call(
          lock.path + '/email-signup',
          { email: 'lock@example.test', password, verificationProof: validNew },
          lock.proof,
        )
      ).status,
      409,
    )
    const exp = await begin()
    const expmail = await send(exp, 'expire@example.test')
    await db
      .prepare('UPDATE auth_verification_challenge SET expires_at=created_at+1 WHERE id=?')
      .bind(expmail.challengeId)
      .run()
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(
      (
        await call(
          exp.path + '/challenges/' + expmail.challengeId + '/verify',
          { credential: expmail.credential },
          exp.proof,
        )
      ).status,
      401,
    )
    await cooldown()
    const reset = await begin('PASSWORD_RESET', 'EMAIL_CODE')
    const rd = await send(reset, 'alice@example.test')
    await verify(reset, rd)
    const rp = await call(reset.path + '/complete', {}, reset.proof)
    assert.equal(rp.status, 200)
    assert.equal(rp.data.kind, 'RESET_PROOF')
    assert.equal(
      (
        await call('/auth/token', {
          grantType: 'authorization_code',
          clientId: reset.clientId,
          code: rp.data.resetProof,
          redirectUri: reset.redirectUri,
          codeVerifier: reset.verifier,
        })
      ).status,
      401,
    )
    const unknown = await begin('PASSWORD_RESET', 'EMAIL_CODE')
    const missing = await send(unknown, 'missing@example.test')
    assert.equal(missing.credential, undefined)
    // Pending password verification predates global revocation and cannot restore login.
    const pending = await begin('LOGIN', 'EMAIL_PASSWORD')
    assert.equal(
      (await call('/sessions/logout-all', {}, undefined, registered.accessToken)).status,
      200,
    )
    assert.equal(
      (
        await call(
          pending.path + '/password',
          { email: 'alice@example.test', password },
          pending.proof,
        )
      ).status,
      409,
    )
    const newLogin = await begin('LOGIN', 'EMAIL_PASSWORD')
    assert.equal(
      (
        await call(
          newLogin.path + '/password',
          { email: 'alice@example.test', password },
          newLogin.proof,
        )
      ).status,
      200,
    )
    await finish(newLogin)
    assert.equal((await db.prepare('SELECT count(*) n FROM auth_user').first()).n, 2)
    // Two independently verified first-login transactions race for one phone identity.
    await cooldown()
    const first = await begin('LOGIN', 'PHONE_OTP')
    const d1 = await send(first, '+8613800000002', 'SMS')
    const p1 = await verify(first, d1)
    await cooldown()
    const second = await begin('LOGIN', 'PHONE_OTP', true)
    const d2 = await send(second, '+8613800000002', 'SMS')
    const p2 = await verify(second, d2)
    const racing = await Promise.all([
      call(first.path + '/phone', { verificationProof: p1 }, first.proof),
      call(second.path + '/phone', { verificationProof: p2 }, second.proof),
    ])
    assert.deepEqual(
      racing.map((x) => x.status),
      [200, 200],
    )
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM auth_user_phone WHERE canonical_phone='+8613800000002'")
          .first()
      ).n,
      1,
    )
    const s1 = await finish(first),
      s2 = await finish(second)
    const owners = await db
      .prepare('SELECT DISTINCT user_id FROM auth_login_session WHERE id IN (?,?)')
      .bind(s1.session.loginSessionId, s2.session.loginSessionId)
      .all()
    assert.equal(owners.results.length, 1)
    // Resending invalidates an already verified old proof as well as the old OTP.
    await cooldown()
    const superseded = await begin(),
      oldDelivery = await send(superseded, 'superseded@example.test'),
      oldProof = await verify(superseded, oldDelivery)
    assert.equal(
      (await call(superseded.path, undefined, superseded.proof)).data.nextStep,
      'EMAIL_SIGNUP',
    )
    await cooldown()
    await send(superseded, 'superseded@example.test')
    assert.equal(
      (await call(superseded.path, undefined, superseded.proof)).data.nextStep,
      'VERIFY_CHALLENGE',
    )
    assert.equal(
      (
        await call(
          superseded.path + '/email-signup',
          { email: 'superseded@example.test', password, verificationProof: oldProof },
          superseded.proof,
        )
      ).status,
      401,
    )
    // Reset proof remains tied to the verified binding, and loses authority on identity change.
    await cooldown()
    const changing = await begin('PASSWORD_RESET', 'EMAIL_CODE'),
      changingMail = await send(changing, 'alice@example.test')
    await verify(changing, changingMail)
    await db
      .prepare('UPDATE auth_user_security SET identity_version=identity_version+1 WHERE user_id=?')
      .bind(u.id)
      .run()
    assert.equal((await call(changing.path + '/complete', {}, changing.proof)).status, 409)
    const timeout = await begin()
    await db
      .prepare('UPDATE auth_product_transaction SET expires_at=created_at+1 WHERE id=?')
      .bind(timeout.id)
      .run()
    await new Promise((r) => setTimeout(r, 5))
    assert.equal((await call(timeout.path, undefined, timeout.proof)).data.status, 'EXPIRED')
    assert.equal(
      (
        await call(
          timeout.path + '/challenges',
          { channel: 'EMAIL', address: 'timeout@example.test' },
          timeout.proof,
        )
      ).status,
      409,
    )

    const audit = JSON.stringify((await db.prepare('SELECT * FROM auth_audit_event').all()).results)
    assert.ok(!audit.includes(password))
    assert.ok(!audit.includes(delivered.credential))
  } finally {
    await p.dispose()
  }
})
