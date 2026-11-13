import { authOpen } from '../rust/src/runtime/federation.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { hash, secret } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

test('V2U-03 V2U-07 same-origin BFF hides proofs, persists encrypted login, and rejects CSRF', async () => {
  const origin = 'http://127.0.0.1:8787',
    bffKey = secret()
  const p = await getRustProxy({
    AUTH_ORIGIN: origin,
    PROVIDER_STATE_KEY: secret(),
    AUTH_WEB_SESSION_KEY: bffKey,
    AUTH_WEB_CLIENT_ID: 'auth-web',
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
      .prepare(
        "INSERT INTO auth_client(id,client_id,application_id,client_type,scopes,redirects) VALUES ('auth-web','auth-web','molis-work-unified-local-app','WEB','[\"account\",\"profile\"]',?)",
      )
      .bind(JSON.stringify([origin + '/account/callback']))
      .run()
    await db
      .prepare(
        "INSERT INTO auth_client_policy(client_id,policy_profile,environment_id,allowed_origins,created_at,updated_at) VALUES ('auth-web','unified-account-v2','unified-local',?,0,0)",
      )
      .bind(JSON.stringify([origin]))
      .run()
    for (const sql of readFileSync(
      new URL('../mock-provider-local-seed.sql', import.meta.url),
      'utf8',
    )
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run()
    let cookie = '',
      csrf = ''
    async function call(path: string, body?: unknown, overrides: Record<string, string> = {}) {
      const r = await p.fetch(
        new Request(origin + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Origin: origin,
            Cookie: cookie,
            'X-CSRF-Token': csrf,
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
            ...overrides,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const set = r.headers.get('Set-Cookie')
      if (set) {
        assert.match(set, /HttpOnly/)
        cookie = set.split(';')[0]
      }
      csrf = r.headers.get('X-CSRF-Token') || csrf
      if (r.headers.get('Content-Type')?.includes('text/html')) {
        return { status: r.status, html: await r.text(), csp: r.headers.get('Content-Security-Policy') }
      }
      const value = await r.json()
      return { status: r.status, ...value }
    }
    function ok(r: any) {
      assert.equal(r.status, 200, JSON.stringify(r))
      const raw = JSON.stringify(r)
      assert.doesNotMatch(
        raw,
        /accessToken|refreshToken|initiatorProof|verificationProof|operationProof|newIdentityProof|resetProof|codeVerifier/,
      )
      return r.data
    }
    assert.equal(
      (await call('/api/account/session', undefined, { Origin: 'https://evil.example' })).status,
      403,
    )
    assert.equal(ok(await call('/api/account/session')).state, 'ANONYMOUS')
    assert.ok(cookie && csrf)
    const anonymousCookie = cookie
    const anonymousCsrf = csrf
    assert.equal(
      (
        await call(
          '/api/account/auth/transactions',
          { purpose: 'LOGIN', method: 'PHONE_OTP' },
          { 'X-CSRF-Token': 'forged' },
        )
      ).status,
      403,
    )
    const t = ok(
      await call('/api/account/auth/transactions', { purpose: 'LOGIN', method: 'PHONE_OTP' }),
    )
    const path = '/api/account/auth/transactions/' + t.handle
    const sent = ok(
      await call(path + '/submit', { step: 'REQUEST_CHALLENGE', address: '+8613800000888' }),
    )
    const code = await db
      .prepare(
        'SELECT m.credential FROM auth_mock_delivery m JOIN auth_verification_challenge c ON c.delivery_id=m.delivery_id WHERE c.id=?',
      )
      .bind(sent.challengeHandle)
      .first()
    const verified = ok(
      await call(path + '/submit', {
        step: 'VERIFY_CHALLENGE',
        challengeHandle: sent.challengeHandle,
        credential: code.credential,
      }),
    )
    assert.equal(verified.nextStep, 'PHONE_LOGIN')
    assert.equal(ok(await call(path + '/submit', { step: 'PHONE_LOGIN' })).nextStep, 'COMPLETE')
    const done = ok(await call(path + '/submit', { step: 'COMPLETE' }))
    assert.equal(done.account.state, 'AUTHENTICATED')
    assert.ok(validateNamed('AccountView', done.account))
    assert.ok(cookie !== anonymousCookie, 'login rotates the opaque browser reference')
    const staleAnonymous = await p.fetch(
      new Request(origin + '/api/account/login-methods', {
        headers: { Origin: origin, Cookie: anonymousCookie },
      }),
    )
    assert.equal(
      staleAnonymous.status,
      401,
      'the old anonymous reference gains no account authority',
    )
    assert.equal(
      (await db.prepare('SELECT count(*) n FROM auth_web_session').first()).n,
      1,
      'promotion replaces the anonymous row instead of leaving an authority alias',
    )
    assert.equal(
      (
        await call(
          '/api/account/reauthentications',
          {
            method: 'PHONE_OTP',
            operation: 'CHANGE_PASSWORD',
            target: { kind: 'PASSWORD' },
          },
          { 'X-CSRF-Token': anonymousCsrf },
        )
      ).status,
      403,
      'anonymous CSRF cannot authorize the authenticated session',
    )
    async function verifyPhone(operation: string, target: unknown) {
      await db.prepare('UPDATE auth_rate_bucket SET expires_at=0').run()
      const tx = ok(
        await call('/api/account/reauthentications', { method: 'PHONE_OTP', operation, target }),
      )
      const path = '/api/account/auth/transactions/' + tx.handle + '/submit'
      const challenge = ok(
        await call(path, { step: 'REQUEST_CHALLENGE', address: '+8613800000888' }),
      )
      const sent = await db
        .prepare(
          'SELECT m.credential FROM auth_mock_delivery m JOIN auth_verification_challenge c ON c.delivery_id=m.delivery_id WHERE c.id=?',
        )
        .bind(challenge.challengeHandle)
        .first()
      const verified = ok(
        await call(path, {
          step: 'VERIFY_CHALLENGE',
          challengeHandle: challenge.challengeHandle,
          credential: sent.credential,
        }),
      )
      assert.equal(verified.nextStep, 'COMPLETE')
      assert.equal(ok(await call(path, { step: 'COMPLETE' })).operationReady, true)
      return tx.handle
    }
    const reauth = await verifyPhone('BIND_METHOD', { method: 'PHONE' })
    const bind = ok(
      await call('/api/account/auth/transactions', {
        purpose: 'BIND',
        method: 'PHONE_OTP',
        reauthHandle: reauth,
      }),
    )
    const bindPath = '/api/account/auth/transactions/' + bind.handle + '/submit'
    const emailChallenge = ok(
      await call(bindPath, { step: 'REQUEST_CHALLENGE', address: '+8613800000889' }),
    )
    const emailCode = await db
      .prepare(
        'SELECT m.credential FROM auth_mock_delivery m JOIN auth_verification_challenge c ON c.delivery_id=m.delivery_id WHERE c.id=?',
      )
      .bind(emailChallenge.challengeHandle)
      .first()
    ok(
      await call(bindPath, {
        step: 'VERIFY_CHALLENGE',
        challengeHandle: emailChallenge.challengeHandle,
        credential: emailCode.credential,
      }),
    )
    assert.equal(ok(await call(bindPath, { step: 'COMPLETE' })).operationReady, true)
    let view = ok(await call('/api/account/session'))
    const bound = ok(
      await call('/api/account/login-methods/bind', {
        reauthHandle: reauth,
        identityHandle: bind.handle,
        expectedVersion: view.user.version,
      }),
    )
    assert.equal(bound.loginMethods.length, 2)
    // A managed email is provisioned by the administrator, never by this self-service BFF.
    assert.equal(
      (
        await call('/api/account/reauthentications', {
          method: 'PHONE_OTP',
          operation: 'BIND_METHOD',
          target: { method: 'EMAIL' },
          useSession: true,
        })
      ).status,
      403,
    )
    await db
      .prepare(
        'INSERT INTO auth_user_email(id,user_id,canonical_email,created_at,verified_at) VALUES (?,?,?,?,?)',
      )
      .bind(crypto.randomUUID(), view.user.userId, 'bff@example.test', Date.now(), Date.now())
      .run()
    const passwordHandle = await verifyPhone('CHANGE_PASSWORD', { kind: 'PASSWORD' })
    view = ok(await call('/api/account/session'))
    ok(
      await call('/api/account/password/change', {
        reauthHandle: passwordHandle,
        expectedVersion: view.user.version,
        newPassword: 'Synthetic-BFF-Jupiter-94',
      }),
    )
    assert.equal(ok(await call('/api/account/session')).state, 'AUTHENTICATED')
    const wrongPassword = ok(
      await call('/api/account/reauthentications', {
        method: 'EMAIL_PASSWORD',
        operation: 'CHANGE_PASSWORD',
        target: { kind: 'PASSWORD' },
      }),
    )
    assert.equal(
      (
        await call('/api/account/auth/transactions/' + wrongPassword.handle + '/submit', {
          step: 'PASSWORD_LOGIN',
          email: 'bff@example.test',
          password: 'incorrect-test-password',
        })
      ).status,
      401,
    )
    assert.equal(
      ok(await call('/api/account/session')).user.userId,
      done.account.user.userId,
      'an incorrect reauthentication password must preserve the authenticated session',
    )
    ok(await call('/api/account/auth/transactions/' + wrongPassword.handle + '/cancel', {}))
    const cancelled = ok(
      await call('/api/account/reauthentications', {
        method: 'EMAIL_PASSWORD',
        operation: 'UNLINK_METHOD',
        target: { bindingId: bound.loginMethods.find((m) => m.type === 'PHONE').bindingId },
      }),
    )
    ok(await call('/api/account/auth/transactions/' + cancelled.handle + '/cancel', {}))
    assert.equal(
      (
        await call('/api/account/auth/transactions/' + cancelled.handle + '/submit', {
          step: 'PASSWORD_LOGIN',
          email: 'bff@example.test',
          password: 'Synthetic-BFF-Jupiter-94',
        })
      ).status,
      409,
    )
    const stored = await db.prepare('SELECT payload,status FROM auth_web_session').first()
    assert.equal(stored.status, 'READY')
    assert.doesNotMatch(stored.payload, /accessToken|refreshToken|PHONE_OTP|userId/)
    assert.equal(ok(await call('/api/account/session')).user.userId, done.account.user.userId)
    assert.equal((await call('/api/account/logout', { scope: 'INVALID' })).status, 400)
    assert.equal(ok(await call('/api/account/session')).state, 'AUTHENTICATED')
    assert.equal((await call('/api/account/platform/applications')).status, 403)
    // V2C-01: retired service administration has no BFF mapping even with a valid login.
    for (const path of [
      '/api/account/platform/applications/retired/services',
      '/api/account/platform/services/retired/rotate',
      '/api/account/platform/services/retired/disable',
    ])
      assert.equal((await call(path, {})).status, 404)
    assert.equal(
      (await call('/api/account/arbitrary-proxy', { url: 'https://evil.example' })).status,
      404,
    )
    // AUTH-CYCLE-03: clearing the BFF must also revoke its central login.
    const logout = ok(await call('/api/account/logout', { scope: 'CURRENT_LOGIN' }))
    assert.equal(logout.localCleared, true)
    assert.equal(logout.remoteRevocation, 'CONFIRMED')
    const revoked = await db
      .prepare('SELECT revoked_at FROM auth_login_session WHERE id=?')
      .bind(done.account.session.loginSessionId)
      .first()
    assert.ok(revoked.revoked_at)

    assert.equal(ok(await call('/api/account/session')).state, 'ANONYMOUS')
    assert.equal((await call(path + '/submit', { step: 'COMPLETE' })).status, 404)
    for (const provider of ['google', 'github']) {
      const tx = ok(
        await call('/api/account/auth/transactions', {
          purpose: 'LOGIN',
          method: provider.toUpperCase(),
        }),
      )
      const begun = ok(
        await call('/api/account/auth/transactions/' + tx.handle + '/submit', {
          step: 'START_PROVIDER',
        }),
      )
      const entry = await p.fetch(new Request(begun.browserStartUrl))
      assert.equal(entry.status, 303)
      const providerCookie = entry.headers.get('Set-Cookie')!.split(';')[0],
        authorize = entry.headers.get('Location')!
      const html = await (
        await p.fetch(new Request(authorize, { headers: { Cookie: providerCookie } }))
      ).text()
      const accepted = await p.fetch(
        new Request(origin + '/api/v2/auth/mock/' + provider + '/authorize', {
          method: 'POST',
          headers: {
            Origin: origin,
            Cookie: providerCookie,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            state: new URL(authorize).searchParams.get('state')!,
            csrf: html.match(/name="csrf" value="([^"]+)"/)![1],
            accountId: 'mock-' + provider + '-local',
            outcome: 'SUCCESS',
          }),
        }),
      )
      assert.equal(accepted.status, 303)
      const returned = await p.fetch(
        new Request(accepted.headers.get('Location')!, { headers: { Cookie: providerCookie } }),
      )
      assert.equal(returned.status, 303)
      const callback = new URL(returned.headers.get('Location')!),
        forged = new URL(callback)
      forged.searchParams.set('state', 'forged-callback-state-value')
      const navigation = {
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      }
      assert.equal((await call(forged.pathname + forged.search, undefined, navigation)).status, 403)
      const sealed = await db.prepare('SELECT payload FROM auth_web_session').first()
      const pending = JSON.parse(await authOpen(bffKey, sealed.payload)).data.transactions[
        tx.handle
      ]
      assert.equal(pending.method, provider.toUpperCase())
      assert.equal(pending.nextStep, 'WAIT_PROVIDER')
      assert.equal(pending.state, callback.searchParams.get('state'))
      const central = await db
        .prepare('SELECT status FROM auth_product_transaction WHERE id=?')
        .bind(tx.handle)
        .first()
      assert.equal(central.status, 'VERIFIED')
      const callbackPage = await call(callback.pathname + callback.search, undefined, navigation)
      assert.equal(callbackPage.status, 200)
      assert.match(callbackPage.html, /授权已完成/)
      assert.match(callbackPage.html, /window\.close\(\)/)
      const nonce = callbackPage.html.match(/script nonce="([^"]+)"/)![1]
      assert.ok(callbackPage.csp.includes("script-src 'nonce-" + nonce + "'"))
      assert.doesNotMatch(callbackPage.html, /requestId|accessToken|refreshToken/)

      const first = ok(await call('/api/account/auth/transactions/' + tx.handle))
      assert.equal(first.account.state, 'AUTHENTICATED')
      assert.equal(
        ok(await call('/api/account/auth/transactions/' + tx.handle)).account.session
          .loginSessionId,
        first.account.session.loginSessionId,
      )
      if (provider === 'google') {
        const row = await db.prepare('SELECT payload FROM auth_web_session').first()
        const tokens = JSON.parse(await authOpen(bffKey, row.payload)).data.tokens
        await db
          .prepare('DELETE FROM auth_login_access_token WHERE token_hash=?')
          .bind(hash(tokens.accessToken))
          .run()
        assert.equal(
          ok(await call('/api/account/session')).state,
          'EXPIRED',
          'an unavailable current access credential also clears the local session',
        )
      }
      if (provider === 'github') {
        await db
          .prepare('UPDATE auth_login_session SET revoked_at=1 WHERE id=?')
          .bind(first.account.session.loginSessionId)
          .run()
        assert.equal(ok(await call('/api/account/session')).state, 'EXPIRED')
        const row = await db.prepare('SELECT payload FROM auth_web_session').first()
        const cleared = JSON.parse(await authOpen(bffKey, row.payload)).data
        assert.equal(cleared.tokens, null, 'revocation clears encrypted recovery material')
        assert.deepEqual(cleared.transactions, {}, 'revocation clears pending sensitive proofs')
        const again = ok(
          await call('/api/account/auth/transactions', { purpose: 'LOGIN', method: 'PHONE_OTP' }),
        )
        assert.equal(again.status, 'PENDING', 'the browser can immediately start a new V2 login')
        ok(await call('/api/account/auth/transactions/' + again.handle + '/cancel', {}))
      }
      assert.equal(
        ok(await call('/api/account/logout', { scope: 'CURRENT_LOGIN' })).localCleared,
        true,
      )
      assert.equal(ok(await call('/api/account/session')).state, 'ANONYMOUS')
      assert.equal((await call('/api/account/login-methods')).status, 401)
    }
  } finally {
    await p.dispose()
  }
})
