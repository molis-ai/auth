import { authOpen, authSeal } from '../rust/src/runtime/federation.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { captureAuthFailures, challenge, hash, secret } from './fixtures.ts'
import { localCredential } from '../scripts/local-credential.mjs'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

test('BFF observes key rotation without changing credential rows on reads', async (t) => {
  const origin = 'http://127.0.0.1:8787'
  const original = secret(),
    rotated = secret()
  const p = await getRustProxy({
    AUTH_ORIGIN: origin,
    AUTH_WEB_SESSION_KEY: original,
    AUTH_WEB_CLIENT_ID: 'molis-auth-web-local',
    UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
      environmentId: 'unified-local',
      kind: 'LOCAL',
      authOrigin: origin,
      deliveryMode: 'MOCK',
      providerMode: 'MOCK',
    }),
  })
  t.after(() => p.dispose())
  await initializeLocalRuntime(p)
  let db = p.env.DB
  const cookie = `molis-auth-web=${secret()}`
  const id = hash(cookie.split('=')[1])
  const payload = await authSeal(original, JSON.stringify({ id, data: null }))
  await db
    .prepare('INSERT INTO auth_web_session(id_hash,payload,expires_at) VALUES (?,?,?)')
    .bind(id, payload, Date.now() + 60_000)
    .run()
  const session = (cookie = '') =>
    p.fetch(new Request(origin + '/api/account/session', { headers: { Cookie: cookie } }))
  assert.equal((await session(cookie)).status, 200)
  assert.equal(
    await db
      .prepare('SELECT payload FROM auth_web_session WHERE id_hash=?')
      .bind(id)
      .first('payload'),
    payload,
  )

  db = await p.updateBindings({ AUTH_WEB_SESSION_KEY: rotated })
  const rejected = await session(cookie)
  assert.equal(rejected.status, 503)
  assert.equal((await rejected.json()).error.code, 'AUTH_UNAVAILABLE')
  const newSession = await session()
  assert.equal(newSession.status, 200)
  assert.equal(newSession.headers.get('Set-Cookie'), null)
  const started = await p.fetch(
    new Request(origin + '/api/account/auth/transactions', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': newSession.headers.get('X-CSRF-Token')!,
      },
      body: JSON.stringify({ purpose: 'LOGIN', method: 'EMAIL_PASSWORD' }),
    }),
  )
  assert.equal(started.status, 200, await started.clone().text())
  const newCookie = started.headers.get('Set-Cookie')!.split(';')[0]
  const newId = hash(newCookie.split('=')[1])
  const newPayload = await db
    .prepare('SELECT payload FROM auth_browser_transaction WHERE browser_hash=?')
    .bind(newId)
    .first('payload')
  await assert.rejects(authOpen(original, newPayload))
  assert.match(JSON.parse(await authOpen(rotated, newPayload)).id, new RegExp('^' + newId + ':'))
  assert.equal((await session(newCookie)).status, 200)
})

test('AUTH-U-03 AUTH-U-07 same-origin BFF hides proofs, persists encrypted login, and rejects CSRF', async (t) => {
  const origin = 'http://127.0.0.1:8787',
    bffKey = secret()
  const fixturePassword = secret() + 'aA!5'
  const failures = captureAuthFailures()
  const p = await getRustProxy(
    {
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
    },
    undefined,
    undefined,
    failures,
  )
  try {
    await initializeLocalRuntime(p)
    let db = p.env.DB
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
        "INSERT INTO auth_client(id,client_id,application_id,client_type,redirects,environment_id,allowed_origins) VALUES ('auth-web','auth-web','molis-work-unified-local-app','WEB',?,'unified-local',?)",
      )
      .bind(JSON.stringify([origin + '/account/callback']), JSON.stringify([origin]))
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
        return {
          status: r.status,
          html: await r.text(),
          csp: r.headers.get('Content-Security-Policy'),
        }
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
    assert.equal(ok(await call('/api/account/auth/capabilities')).methods.length, 5)
    assert.equal(cookie, '')
    assert.equal(csrf, '')
    assert.equal(
      (await call('/api/account/session', undefined, { Origin: 'https://evil.example' })).status,
      403,
    )
    assert.equal(ok(await call('/api/account/session')).state, 'ANONYMOUS')
    assert.equal(cookie, '')
    assert.ok(csrf.startsWith('bootstrap.'))
    assert.equal((await call('/api/account/login-sessions')).status, 401)
    // LOGIN-P1-04: the BFF binds client identity; capabilities expose no proofs or secrets.
    const methods = ['ACCOUNT_PASSWORD', 'EMAIL_CODE', 'PHONE_OTP', 'GOOGLE', 'GITHUB']
    assert.deepEqual(ok(await call('/api/account/auth/capabilities')).methods, methods)
    assert.deepEqual(ok(await call('/api/v1/auth/capabilities?clientId=auth-web')).methods, methods)
    assert.equal((await call('/api/v1/auth/capabilities?clientId=unknown')).status, 403)
    assert.equal(
      (await call('/api/v1/auth/capabilities?clientId=auth-web&clientId=other')).status,
      400,
    )
    assert.equal(
      (
        await call('/api/v1/auth/capabilities?clientId=auth-web', undefined, {
          Origin: 'https://evil.example',
        })
      ).status,
      403,
    )
    await db.prepare("UPDATE auth_client SET status='DISABLED' WHERE client_id='auth-web'").run()
    const disabled = await call('/api/account/auth/capabilities')
    assert.equal(disabled.status, 403)
    assert.equal(disabled.error.code, 'POLICY_MISMATCH')
    await db.prepare("UPDATE auth_client SET status='ACTIVE' WHERE client_id='auth-web'").run()
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
    const sent = ok(
      await call('/api/account/auth/verification-codes', {
        purpose: 'LOGIN',
        channel: 'SMS',
        address: '+8613800000888',
      }),
    )
    const anonymousCookie = cookie
    const anonymousCsrf = csrf
    assert.ok(anonymousCookie && anonymousCsrf)
    assert.equal(typeof sent.verificationId, 'string')
    assert.equal(sent.challengeId, undefined)
    const code = await db
      .prepare(
        'SELECT m.credential FROM auth_mock_delivery m JOIN auth_verification_challenge c ON c.delivery_id=m.delivery_id WHERE c.id=?',
      )
      .bind(sent.verificationId)
      .first()
    assert.equal(
      (
        await call('/api/account/auth/login/code', {
          verificationId: sent.verificationId,
          code: code.credential === '000000' ? '111111' : '000000',
        })
      ).status,
      401,
    )
    const done = ok(
      await call('/api/account/auth/login/code', {
        verificationId: sent.verificationId,
        code: code.credential,
      }),
    )
    // Browser login consumes the verification transaction while issuing its session.
    assert.deepEqual(
      {
        ...(await db
          .prepare(
            "SELECT t.status, (SELECT count(*) FROM auth_identity_proof p WHERE p.transaction_id=t.id AND p.kind='LOGIN_CODE') codes FROM auth_product_transaction t JOIN auth_verification_challenge c ON c.transaction_id=t.id WHERE c.id=?",
          )
          .bind(sent.verificationId)
          .first()),
      },
      { status: 'CONSUMED', codes: 0 },
    )
    assert.equal(
      (
        await db
          .prepare('SELECT count(*) n FROM auth_local_credential WHERE user_id=?')
          .bind(done.account.user.userId)
          .first()
      ).n,
      0,
    )
    assert.equal(done.account.state, 'AUTHENTICATED')
    assert.ok(validateNamed('AccountView', done.account))
    assert.equal(ok(await call('/api/account/me')).passwordEnabled, false)
    await t.test(
      'session projection reads no password state and preserves SELECT failures',
      async () => {
        await db
          .prepare('ALTER TABLE auth_local_credential RENAME TO hidden_local_credential')
          .run()
        try {
          assert.deepEqual(ok(await call('/api/account/session')), done.account)
          const unavailable = await call('/api/account/login-methods')
          assert.equal(unavailable.status, 503)
          assert.equal(unavailable.error.code, 'AUTH_UNAVAILABLE')
        } finally {
          await db
            .prepare('ALTER TABLE hidden_local_credential RENAME TO auth_local_credential')
            .run()
        }
      },
    )
    await t.test(
      'login session directory only returns the current account’s live session summaries',
      async () => {
        const currentId = done.account.session.loginSessionId
        const timestamp = Date.now()
        const retainSession = db.prepare(
          `INSERT INTO auth_login_session(id,user_id,client_id,authenticated_at,last_active_at,absolute_expires_at,user_epoch,created_seq,revoked_at)
         SELECT ?,COALESCE(?,user_id),?,?,?,?+7776000000,user_epoch+?,created_seq,?
         FROM auth_login_session WHERE id=?`,
        )
        const otherUser = 'qa-sessions-other'
        const work = 'molis-work-unified-local'
        const club = 'molis-club-unified-local'
        const workActivity = timestamp - 120_000
        const clubActivity = timestamp - 180_000
        const fixture = (
          id: string,
          client: string,
          lastActive: number,
          epoch = 0,
          revoked: number | null = null,
          owner: string | null = null,
        ) =>
          retainSession.bind(
            id,
            owner,
            client,
            lastActive,
            lastActive,
            lastActive,
            epoch,
            revoked,
            currentId,
          )
        await db.batch([
          db
            .prepare(
              "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,'Other account','ACTIVE',?,?)",
            )
            .bind(otherUser, timestamp, timestamp),

          fixture('qa-sessions-work', work, workActivity),
          fixture('qa-sessions-club', club, clubActivity),
          fixture('qa-sessions-expired', work, timestamp - 31 * 86_400_000),
          fixture('qa-sessions-revoked', work, timestamp, 0, timestamp),
          fixture('qa-sessions-invalid-epoch', work, timestamp, 1),
          fixture('qa-sessions-different-user', work, timestamp, 0, null, otherUser),
        ])
        try {
          assert.deepEqual(ok(await call('/api/account/login-sessions')), {
            items: [
              {
                productName: 'Molis Work Local',
                clientType: 'WEB',
                lastActiveAt: done.account.session.lastActiveAt,
                current: true,
              },
              {
                productName: 'Molis Work Local',
                clientType: 'MACOS',
                lastActiveAt: new Date(workActivity).toISOString(),
                current: false,
              },
              {
                productName: 'Molis Club Local',
                clientType: 'WEB',
                lastActiveAt: new Date(clubActivity).toISOString(),
                current: false,
              },
            ],
            hasMore: false,
          })
          assert.equal((await call('/api/account/login-sessions?userId=' + otherUser)).status, 400)
          assert.equal((await call('/api/account/login-sessions', {})).status, 405)
        } finally {
          await db.batch([
            db.prepare("DELETE FROM auth_login_session WHERE id LIKE 'qa-sessions-%'"),
            db.prepare('DELETE FROM auth_user WHERE id=?').bind(otherUser),
          ])
        }
      },
    )
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
        newPassword: fixturePassword,
      }),
    )
    assert.equal(ok(await call('/api/account/session')).state, 'AUTHENTICATED')
    assert.equal(ok(await call('/api/account/me')).passwordEnabled, true)
    const browserPasswordOperation = {
      method: 'EMAIL_PASSWORD',
      operation: 'CHANGE_PASSWORD',
      target: { kind: 'PASSWORD' },
      useSession: true,
    }
    const denied = await call('/api/account/reauthentications', {
      ...browserPasswordOperation,
      currentPassword: 'incorrect-test-password',
    })
    assert.equal(denied.status, 401)
    assert.equal(denied.error.code, 'INVALID_CREDENTIALS')
    assert.equal(ok(await call('/api/account/session')).user.userId, done.account.user.userId)
    const verified = ok(
      await call('/api/account/reauthentications', {
        ...browserPasswordOperation,
        currentPassword: fixturePassword,
      }),
    )
    assert.equal(verified.nextStep, 'COMPLETE')
    ok(await call('/api/account/auth/transactions/' + verified.handle + '/cancel', {}))
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
          password: fixturePassword,
        })
      ).status,
      409,
    )
    const stored = await db.prepare('SELECT payload FROM auth_web_session').first()
    assert.doesNotMatch(stored.payload, /accessToken|refreshToken|PHONE_OTP|userId/)
    assert.equal(ok(await call('/api/account/session')).user.userId, done.account.user.userId)
    assert.equal((await call('/api/account/logout', { scope: 'INVALID' })).status, 400)
    assert.equal(ok(await call('/api/account/session')).state, 'AUTHENTICATED')
    assert.equal((await call('/api/account/platform/applications')).status, 403)
    // AUTH-C-01: retired service administration has no BFF mapping even with a valid login.
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
    assert.equal(
      (
        await call('/api/account/auth/login/code', {
          verificationId: sent.verificationId,
          code: code.credential,
        })
      ).status,
      403,
    )
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
        new Request(origin + '/api/v1/auth/mock/' + provider + '/authorize', {
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
      const sealed = await db
        .prepare('SELECT payload FROM auth_browser_transaction WHERE handle=?')
        .bind(tx.handle)
        .first()
      const pending = JSON.parse(await authOpen(bffKey, sealed.payload)).data
      assert.equal(pending.method, provider.toUpperCase())
      assert.equal(pending.nextStep, 'WAIT_PROVIDER')
      assert.equal(pending.state, callback.searchParams.get('state'))
      const central = await db
        .prepare('SELECT status FROM auth_product_transaction WHERE id=?')
        .bind(tx.handle)
        .first()
      assert.equal(central.status, 'VERIFIED')
      // LOGIN-P1-03: even after provider verification, reads cannot consume the proof or establish a login.
      for (let i = 0; i < 2; i++) {
        assert.equal(
          ok(await call('/api/account/auth/transactions/' + tx.handle)).status,
          'PENDING',
        )
        assert.equal(ok(await call('/api/account/session')).state, 'ANONYMOUS')
        assert.equal(
          (
            await db
              .prepare('SELECT status FROM auth_product_transaction WHERE id=?')
              .bind(tx.handle)
              .first()
          ).status,
          'VERIFIED',
        )
      }
      const callbackPage = await call(callback.pathname + callback.search, undefined, navigation)
      assert.equal(callbackPage.status, 200)
      assert.match(callbackPage.html, /授权已完成/)
      assert.match(callbackPage.html, /window\.close\(\)/)
      const nonce = callbackPage.html.match(/script nonce="([^"]+)"/)![1]
      assert.ok(callbackPage.csp.includes("script-src 'nonce-" + nonce + "'"))
      assert.doesNotMatch(callbackPage.html, /requestId|accessToken|refreshToken/)

      const status = ok(await call('/api/account/auth/transactions/' + tx.handle))
      assert.equal(status.status, 'CONSUMED')
      assert.equal(status.nextStep, 'NONE')
      assert.deepEqual(Object.keys(status).sort(), ['expiresAt', 'handle', 'nextStep', 'status'])
      const first = { account: ok(await call('/api/account/session')) }
      assert.equal(first.account.state, 'AUTHENTICATED')
      assert.equal(ok(await call('/api/account/auth/transactions/' + tx.handle)).status, 'CONSUMED')
      assert.equal(
        ok(await call('/api/account/session')).session.loginSessionId,
        first.account.session.loginSessionId,
      )
      // Replaying a bound callback must not issue a second central login.
      assert.equal(
        (await call(callback.pathname + callback.search, undefined, navigation)).status,
        403,
      )
      assert.equal(
        ok(await call('/api/account/session')).session.loginSessionId,
        first.account.session.loginSessionId,
      )
      if (provider === 'google') {
        const row = await db.prepare('SELECT payload FROM auth_web_session').first()
        const tokens = JSON.parse(await authOpen(bffKey, row.payload)).data
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
        assert.equal(row, null, 'revocation clears encrypted recovery material')
        assert.equal(
          await db
            .prepare('SELECT 1 FROM auth_browser_transaction WHERE browser_hash=?')
            .bind(hash(cookie.split('=')[1]))
            .first(),
          null,
          'revocation clears pending sensitive proofs',
        )
        const again = ok(
          await call('/api/account/auth/transactions', { purpose: 'LOGIN', method: 'PHONE_OTP' }),
        )
        assert.equal(
          again.status,
          'PENDING',
          'the browser can immediately start a new central login',
        )
        ok(await call('/api/account/auth/transactions/' + again.handle + '/cancel', {}))
      }
      assert.equal(
        ok(await call('/api/account/logout', { scope: 'CURRENT_LOGIN' })).localCleared,
        true,
      )
      assert.equal(ok(await call('/api/account/session')).state, 'ANONYMOUS')
      assert.equal((await call('/api/account/login-methods')).status, 401)
    }
    await t.test(
      'BFF uses per-IP password and delivery buckets, and both APIs report the D1 expiry',
      async () => {
        const ipA = '192.0.2.1',
          ipB = '192.0.2.2',
          ipC = '192.0.2.3',
          ipD = '192.0.2.4'
        const sendPath = '/api/account/auth/verification-codes'
        const sendBody = (address: string) => ({ purpose: 'LOGIN', channel: 'EMAIL', address })
        async function browser(ip: string) {
          const bootstrap = await p.fetch(
            new Request(origin + '/api/account/session', {
              headers: { Origin: origin, 'CF-Connecting-IP': ip },
            }),
          )
          assert.equal(bootstrap.status, 200)
          assert.equal((await bootstrap.json()).data.state, 'ANONYMOUS')
          assert.equal(bootstrap.headers.get('Set-Cookie'), null)
          let cookie = ''
          let csrf = bootstrap.headers.get('X-CSRF-Token')!
          assert.ok(csrf.startsWith('bootstrap.'))
          return {
            get cookie() {
              return cookie
            },
            post: async (path: string, body: unknown) => {
              const response = await p.fetch(
                new Request(origin + path, {
                  method: 'POST',
                  headers: {
                    Origin: origin,
                    Cookie: cookie,
                    'X-CSRF-Token': csrf,
                    'Content-Type': 'application/json',
                    'CF-Connecting-IP': ip,
                  },
                  body: JSON.stringify(body),
                }),
              )
              cookie = response.headers.get('Set-Cookie')?.split(';')[0] ?? cookie
              csrf = response.headers.get('X-CSRF-Token') ?? csrf
              return response
            },
          }
        }
        function direct(ip: string, address: string) {
          const proof = secret()
          return p.fetch(
            new Request(origin + '/api/v1/auth/verification-codes', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'CF-Connecting-IP': ip,
                'X-Auth-Initiator-Proof': proof,
              },
              body: JSON.stringify({
                ...sendBody(address),
                clientId: 'auth-web',
                redirectUri: origin + '/account/callback',
                state: secret(),
                codeChallenge: challenge(secret()),
                codeChallengeMethod: 'S256',
                initiatorChallenge: challenge(proof),
              }),
            }),
          )
        }
        const first = await browser(ipA),
          second = await browser(ipA),
          other = await browser(ipB)
        const hourlyBucket = (ip: string) => hash(`delivery:ip-hour:${ip}`)
        const bucketHits = async (bucketHash: string) =>
          (
            await db
              .prepare('SELECT hits FROM auth_rate_bucket WHERE bucket_hash=?')
              .bind(bucketHash)
              .first()
          )?.hits
        const clientBucket = hash('delivery:client:auth-web')
        const clientHits = (await bucketHits(clientBucket)) ?? 0
        // Put IP A one send below the hourly quota with a partially elapsed window.
        const expiresAt = Date.now() + 1_800_750
        await db
          .prepare('INSERT INTO auth_rate_bucket(bucket_hash,hits,expires_at) VALUES (?,59,?)')
          .bind(hourlyBucket(ipA), expiresAt)
          .run()

        async function assertThrottled(send: () => ReturnType<typeof direct>) {
          const before = Date.now()
          const response = await send()
          const after = Date.now()
          const body = await response.json()
          assert.equal(response.status, 429, JSON.stringify(body))
          assert.ok(validateNamed('Error429', body))
          const seconds = body.error.retryAfterSeconds
          assert.equal(response.headers.get('Retry-After'), String(seconds))
          assert.ok(seconds > 60 && seconds <= 3600)
          assert.ok(seconds >= Math.ceil((expiresAt - after) / 1000))
          assert.ok(seconds <= Math.ceil((expiresAt - before) / 1000))
        }

        const accepted = await first.post(sendPath, sendBody('quota-first@example.test'))
        assert.equal(accepted.status, 200, await accepted.text())
        assert.notEqual(first.cookie, second.cookie)
        await assertThrottled(() => second.post(sendPath, sendBody('quota-same-ip@example.test')))
        const otherIp = await other.post(sendPath, sendBody('quota-other-ip@example.test'))
        assert.equal(otherIp.status, 200, await otherIp.text())
        await assertThrottled(() => direct(ipA, 'quota-direct-same@example.test'))
        const directOther = await direct(ipC, 'quota-direct-other@example.test')
        assert.equal(directOther.status, 200, await directOther.text())

        assert.equal(await bucketHits(hourlyBucket(ipA)), 62)
        assert.equal(await bucketHits(hourlyBucket(ipB)), 1)
        assert.equal(await bucketHits(hourlyBucket(ipC)), 1)
        assert.equal(await bucketHits(hash(`delivery:ip:${ipA}`)), 3)
        for (const address of ['quota-same-ip@example.test', 'quota-direct-same@example.test']) {
          assert.equal(await bucketHits(hash(`delivery:target:EMAIL:${address}`)), undefined)
          assert.equal(await bucketHits(hash(`delivery:resend:EMAIL:${address}`)), undefined)
        }
        assert.equal(await bucketHits(clientBucket), clientHits + 3)

        await db
          .prepare('INSERT INTO auth_rate_bucket(bucket_hash,hits,expires_at) VALUES (?,59,?)')
          .bind(hourlyBucket(ipD), expiresAt)
          .run()
        const concurrent = await Promise.all([
          direct(ipD, 'quota-concurrent-1@example.test'),
          direct(ipD, 'quota-concurrent-2@example.test'),
        ])
        assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 429])
        assert.equal(await bucketHits(hourlyBucket(ipD)), 61)
        assert.equal(await bucketHits(clientBucket), clientHits + 4)

        const localPasswordBucket = hash('auth:password:local')
        const localPasswordHits = await bucketHits(localPasswordBucket)
        const badPassword = await first.post('/api/account/auth/login/password', {
          identifier: 'quota-password@example.test',
          password: 'incorrect-test-password',
        })
        assert.equal(badPassword.status, 401, await badPassword.text())
        assert.equal(await bucketHits(hash(`auth:password:${ipA}`)), 1)
        assert.equal(await bucketHits(localPasswordBucket), localPasswordHits)
      },
    )
    // ENV-U-04: reload the same worker bindings, then change the local session generation twice.
    await p.updateBindings({ MOLIS_LOCAL_GENERATION: 'fixture-dev-first' })
    assert.equal(ok(await call('/api/account/session')).state, 'ANONYMOUS')
    const signedIn = ok(
      await call('/api/account/auth/login/password', {
        identifier: 'bff@example.test',
        password: fixturePassword,
      }),
    )
    assert.equal(signedIn.account.state, 'AUTHENTICATED')
    const oldCookie = cookie
    await p.updateBindings({ MOLIS_LOCAL_GENERATION: 'fixture-dev-first' })
    assert.equal(
      ok(await call('/api/account/session')).session.loginSessionId,
      signedIn.account.session.loginSessionId,
    )
    for (const generation of ['fixture-test', 'fixture-dev-return']) {
      db = await p.updateBindings({ MOLIS_LOCAL_GENERATION: generation })
      assert.equal(
        ok(await call('/api/account/session', undefined, { Cookie: oldCookie })).state,
        'ANONYMOUS',
      )
    }
    await t.test(
      'AC-AUTH-01/03 correlates a BFF response, central dispatch and D1 failure without inputs',
      async () => {
        ok(await call('/api/account/session'))
        const tx = ok(
          await call('/api/account/auth/transactions', {
            purpose: 'LOGIN',
            method: 'PHONE_OTP',
          }),
        )
        const phone = '+8613800000888'
        await db.prepare('DROP TABLE auth_rate_bucket').run()
        const failure = await call('/api/account/auth/transactions/' + tx.handle + '/submit', {
          step: 'REQUEST_CHALLENGE',
          address: phone,
        })
        assert.equal(failure.status, 503, JSON.stringify(failure))
        const logs = await failures.forRequest(failure.requestId, [
          'd1.all',
          'internal',
          'dispatch',
        ])
        const isHttp = (event: (typeof failures.records)[number]) =>
          event.event === 'auth.http.request' && event.request_id === failure.requestId
        const http = await failures.waitFor(isHttp)
        assert.equal(failures.records.filter(isHttp).length, 1)
        assert.equal(http.route, '/api/account/auth/transactions/{handle}/submit')
        assert.equal(http.status, 503)
        assert.equal(http.error_code, 'AUTH_UNAVAILABLE')
        const reportedRoutes = new Map(logs.map(({ phase, route }) => [phase, route]))
        assert.equal(
          reportedRoutes.get('dispatch'),
          '/api/account/auth/transactions/{handle}/submit',
        )
        for (const phase of ['d1.all', 'internal']) {
          assert.equal(
            reportedRoutes.get(phase),
            '/api/v1/auth/transactions/{transactionId}/challenges',
          )
        }
        for (const log of logs) {
          assert.equal(log.code, 'AUTH_UNAVAILABLE')
          assert.equal(log.status, 503)
          assert.ok(log.duration_ms >= 0)
          assert.equal(log.schema, 1)
          assert.equal(log.service, 'molis-auth')
          assert.equal(log.env, 'unknown')
          assert.deepEqual(Object.keys(log).sort(), [
            'code',
            'duration_ms',
            'env',
            'event',
            'phase',
            'request_id',
            'route',
            'schema',
            'service',
            'status',
          ])
        }
        const raw = JSON.stringify([...logs, http])
        for (const value of [phone, tx.handle, cookie, csrf, fixturePassword, 'auth_rate_bucket']) {
          assert.equal(raw.includes(value), false)
        }
      },
    )
  } finally {
    await p.dispose()
  }
})

test(
  'BFF uses revision-fenced credentials and independent transaction records',
  { timeout: 45_000 },
  async (t) => {
    const origin = 'http://127.0.0.1:8787'
    const bffKey = secret()
    const clientId = 'molis-auth-web-local'
    const barriers = new Map<
      string,
      {
        reached: ReturnType<typeof Promise.withResolvers<void>>
        proceed: ReturnType<typeof Promise.withResolvers<void>>
      }
    >()
    const p = await getRustProxy(
      {
        AUTH_ORIGIN: origin,
        AUTH_WEB_SESSION_KEY: bffKey,
        AUTH_WEB_CLIENT_ID: clientId,
        UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
          environmentId: 'unified-local',
          kind: 'LOCAL',
          authOrigin: origin,
          deliveryMode: 'MOCK',
          providerMode: 'MOCK',
        }),
      },
      async (request) => {
        const barrier = barriers.get(new URL(request.url).pathname.slice(1))
        assert.ok(barrier, request.url)
        barrier.reached.resolve()
        await barrier.proceed.promise
        return new Response('continue')
      },
      undefined,
      {
        fixtureEntrypoint: readFileSync(
          new URL('./fixtures/d1-request-barrier.mjs', import.meta.url),
          'utf8',
        ),
      },
    )
    t.after(async () => {
      for (const { proceed } of barriers.values()) proceed.resolve()
      await p.dispose()
    })
    await initializeLocalRuntime(p)
    const db = p.env.DB

    type Browser = { cookie: string; csrf: string; id: string }
    function request(
      browser?: Browser,
      path = '/session',
      options: {
        method?: string
        body?: unknown
        raw?: string
        headers?: Record<string, string>
      } = {},
    ) {
      return p.fetch(
        new Request(origin + '/api/account' + path, {
          method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
            ...(browser ? { Cookie: browser.cookie, 'X-CSRF-Token': browser.csrf } : {}),
            ...options.headers,
          },
          body:
            options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        }),
      )
    }

    async function data(response: Response) {
      if (response.status !== 200) assert.fail(`${response.status}: ${await response.text()}`)
      const body = await response.json()
      return body.data
    }

    async function conflict(response: Response) {
      assert.equal(response.status, 409)
      assert.equal((await response.json()).error.code, 'VERSION_CONFLICT')
      assert.deepEqual(response.headers.getSetCookie(), [])
      assert.equal(response.headers.get('Retry-After'), null)
    }

    async function browser(): Promise<Browser> {
      const response = await request()
      assert.equal((await data(response)).state, 'ANONYMOUS')
      assert.deepEqual(response.headers.getSetCookie(), [])
      const bootstrap = response.headers.get('X-CSRF-Token')!
      const started = await request(undefined, '/auth/transactions', {
        body: { purpose: 'LOGIN', method: 'EMAIL_PASSWORD' },
        headers: { 'X-CSRF-Token': bootstrap },
      })
      await data(started)
      const cookie = started.headers.getSetCookie()[0]?.split(';')[0]
      const csrf = started.headers.get('X-CSRF-Token')
      assert.ok(cookie && csrf)
      return { cookie, csrf, id: hash(cookie.slice('molis-auth-web='.length)) }
    }

    async function row(b: Browser) {
      const value = await db
        .prepare('SELECT * FROM auth_web_session WHERE id_hash=?')
        .bind(b.id)
        .first()
      return value
    }

    async function authenticated({ accessTtlMs = 900_000, usedRefresh = false } = {}) {
      const b = await browser()
      const userId = crypto.randomUUID()
      const loginId = crypto.randomUUID()
      const accessToken = secret()
      const refreshToken = secret()
      const now = Date.now()
      const expiry = now + 7_776_000_000
      await db
        .prepare(
          "INSERT INTO auth_user(id,display_name,status,avatar_data,created_at,updated_at) VALUES (?,'Browser Account','ACTIVE',NULL,?,?)",
        )
        .bind(userId, now, now)
        .run()

      const seq = await db
        .prepare(
          "INSERT INTO auth_security_sequence(kind,created_at) VALUES ('TRANSACTION',?) RETURNING seq",
        )
        .bind(now)
        .first()
      assert.ok(seq)
      await db
        .prepare(
          'INSERT INTO auth_login_session(id,user_id,client_id,authenticated_at,last_active_at,absolute_expires_at,user_epoch,created_seq,identity_verified_at) VALUES (?,?,?,?,?,?,0,?,?)',
        )
        .bind(loginId, userId, clientId, now, now, expiry, seq.seq, now)
        .run()
      const accessExpiresAt = now + accessTtlMs
      await db
        .prepare('INSERT INTO auth_login_access_token VALUES (?,?,0,0,?)')
        .bind(hash(accessToken), loginId, accessExpiresAt)
        .run()
      await db
        .prepare(
          'INSERT INTO auth_login_refresh_token(token_hash,login_session_id,generation,session_revision,user_epoch,created_at,expires_at,used_at) VALUES (?,?,0,0,0,?,?,?)',
        )
        .bind(hash(refreshToken), loginId, now, expiry, usedRefresh ? now : null)
        .run()
      const payload = await authSeal(
        bffKey,
        JSON.stringify({
          id: b.id,
          data: {
            accessToken,
            refreshToken,
            accessExpiresAt: new Date(accessExpiresAt).toISOString(),
            session: { loginSessionId: loginId },
          },
        }),
      )
      await db
        .prepare('INSERT INTO auth_web_session(id_hash,payload,expires_at) VALUES (?,?,?)')
        .bind(b.id, payload, expiry)
        .run()
      return { b, userId, loginId, accessToken }
    }

    async function pause(
      b: Browser,
      point: string,
      path?: string,
      options: Parameters<typeof request>[2] = {},
    ) {
      const tag = point + '/' + crypto.randomUUID()
      const reached = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      barriers.set(tag, { reached, proceed })
      const response = request(b, path, {
        ...options,
        headers: { ...options.headers, 'X-Fixture-Barrier': tag },
      })
      let paused = false
      await Promise.race([
        reached.promise.then(() => {
          paused = true
        }),
        response.then(async (value) => {
          if (!paused)
            assert.fail(`Request never reached ${point}: ${value.status} ${await value.text()}`)
        }),
      ])
      return async () => {
        proceed.resolve()
        try {
          return await response
        } finally {
          barriers.delete(tag)
        }
      }
    }

    const logout = { body: { scope: 'CURRENT_LOGIN' } }
    const activity = { body: { eventId: crypto.randomUUID(), kind: 'OPEN' } }
    async function traced(
      counts: { read: number; write: number },
      b?: Browser,
      path = '/session',
      options: Parameters<typeof request>[2] = {},
    ) {
      const response = await request(b, path, {
        ...options,
        headers: { ...options.headers, 'X-Fixture-Barrier': 'web-session-trace' },
      })
      assert.deepEqual(JSON.parse(response.headers.get('X-Fixture-D1-Calls')!), counts)
      return response
    }

    await t.test('cold and previous-cookie password login use at most four D1 calls', async () => {
      const address = 'direct-password@example.test'
      const password = secret() + 'aA!5'
      const credential = await localCredential(address, password)
      const id = crypto.randomUUID()
      const at = Date.now()
      await db.batch([
        db
          .prepare(
            "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,'Direct','ACTIVE',?,?)",
          )
          .bind(id, at, at),
        db
          .prepare('INSERT INTO auth_user_email VALUES (?,?,?,?,?)')
          .bind(crypto.randomUUID(), id, address, at, at),
        db
          .prepare('INSERT INTO auth_local_credential VALUES (?,?,?)')
          .bind(id, credential.encoded, at),
      ])
      const started = await request()
      const anonymousCookie = await browser()
      const query = { body: { identifier: address, password } }
      const count = async () =>
        db.prepare('SELECT count(*) FROM auth_product_transaction').first('count(*)')
      const before = await count()
      const cold = await traced({ read: 1, write: 2 }, undefined, '/auth/login/password', {
        ...query,
        headers: { 'X-CSRF-Token': started.headers.get('X-CSRF-Token')! },
      })
      assert.equal((await data(cold)).account.user.userId, id)
      const existing = await traced(
        { read: 2, write: 2 },
        anonymousCookie,
        '/auth/login/password',
        query,
      )
      assert.equal((await data(existing)).account.user.userId, id)
      assert.equal(await count(), before)
      assert.ok(cold.headers.getSetCookie()[0])
    })

    await t.test(
      'one-step phone verification uses five calls and stores no proof token',
      async () => {
        const b = await browser()
        const sent = await data(
          await request(b, '/auth/verification-codes', {
            body: { purpose: 'LOGIN', channel: 'SMS', address: '+8613800000777' },
          }),
        )
        const delivered = await db
          .prepare(
            'SELECT q.transaction_id,d.credential FROM auth_verification_challenge q JOIN auth_mock_delivery d ON d.delivery_id=q.delivery_id WHERE q.id=?',
          )
          .bind(sent.verificationId)
          .first()
        assert.ok(delivered)
        const done = await traced({ read: 2, write: 3 }, b, '/auth/login/code', {
          body: { verificationId: sent.verificationId, code: delivered.credential },
        })
        assert.equal((await data(done)).account.state, 'AUTHENTICATED')
        assert.equal(
          await db
            .prepare('SELECT count(*) n FROM auth_identity_proof WHERE transaction_id=?')
            .bind(delivered.transaction_id)
            .first('n'),
          0,
        )
        assert.equal(
          await db
            .prepare('SELECT status FROM auth_product_transaction WHERE id=?')
            .bind(delivered.transaction_id)
            .first('status'),
          'CONSUMED',
        )
        assert.ok(done.headers.getSetCookie()[0])
      },
    )

    await t.test('anonymous capability and session lookups are read-only', async () => {
      const capability = await traced({ read: 1, write: 0 }, undefined, '/auth/capabilities')
      assert.ok((await data(capability)).methods.includes('ACCOUNT_PASSWORD'))
      assert.equal(capability.headers.get('X-CSRF-Token'), null)
      const anonymous = await traced({ read: 0, write: 0 })
      assert.equal((await data(anonymous)).state, 'ANONYMOUS')
      assert.deepEqual(anonymous.headers.getSetCookie(), [])
      assert.ok(anonymous.headers.get('X-CSRF-Token'))
    })

    await t.test('independent transactions never write to the credential table', async () => {
      const b = await browser()
      const tx = { body: { purpose: 'LOGIN', method: 'EMAIL_PASSWORD' } }
      const [first, second] = await Promise.all([
        request(b, '/auth/transactions', tx).then(data),
        request(b, '/auth/transactions', tx).then(data),
      ])
      assert.notEqual(first.handle, second.handle)
      assert.equal(await row(b), null)
      for (const handle of [first.handle, second.handle]) {
        const stored = await db
          .prepare('SELECT payload FROM auth_browser_transaction WHERE browser_hash=? AND handle=?')
          .bind(b.id, handle)
          .first()
        assert.ok(stored)
        const ciphertext = JSON.parse(await authOpen(bffKey, stored.payload))
        assert.equal(ciphertext.id, b.id + ':' + handle)
        assert.ok(ciphertext.data.proof)
      }
      await data(await request(b, '/auth/transactions/' + first.handle + '/cancel', { body: {} }))
      assert.equal(
        (await data(await request(b, '/auth/transactions/' + second.handle))).status,
        'PENDING',
      )
    })

    await t.test(
      'parallel reads, activity and profile writes keep one browser revision',
      async () => {
        const { b } = await authenticated()
        const before = await row(b)
        const pending = await pause(b, 'business', '/profile', {
          method: 'PATCH',
          body: { displayName: 'Changed', expectedVersion: 0 },
        })
        await Promise.all([
          traced({ read: 2, write: 0 }, b, '/tenants').then(data),
          request(b, '/activity', activity).then(data),
          request(b, '/login-methods').then(data),
        ])
        await data(await pending())
        assert.deepEqual(await row(b), before)
      },
    )

    await t.test(
      'logout fences delayed reads and writes and revokes the central session',
      async () => {
        const { b, loginId, userId } = await authenticated()
        const heldRead = await pause(b, 'managed-list-before', '/tenants')
        const heldWrite = await pause(b, 'business', '/profile', {
          method: 'PATCH',
          body: { displayName: 'Stale update', expectedVersion: 0 },
        })
        const logoutResult = await data(await request(b, '/logout', logout))
        assert.deepEqual(logoutResult, { localCleared: true, remoteRevocation: 'CONFIRMED' })
        assert.equal(await row(b), null)
        assert.equal((await data(await request(b))).state, 'ANONYMOUS')
        await conflict(await heldRead())
        const lateWrite = await heldWrite()
        assert.equal(lateWrite.status, 401)
        assert.equal((await lateWrite.json()).error.code, 'SESSION_EXPIRED')
        assert.deepEqual(
          await db
            .prepare('SELECT display_name,account_version FROM auth_user WHERE id=?')
            .bind(userId)
            .first(),
          { display_name: 'Browser Account', account_version: 0 },
        )
        assert.ok(
          await db
            .prepare('SELECT revoked_at FROM auth_login_session WHERE id=?')
            .bind(loginId)
            .first('revoked_at'),
        )
      },
    )

    await t.test('parallel expired access refreshes rotate tokens exactly once', async () => {
      const { b, loginId } = await authenticated({ accessTtlMs: 0 })
      const before = await row(b)
      const delayed = await pause(b, 'refresh-race')
      assert.deepEqual(await row(b), before)
      assert.equal((await data(await request(b))).state, 'AUTHENTICATED')
      assert.equal((await data(await delayed())).state, 'AUTHENTICATED')
      const current = await row(b)
      assert.equal(current.revision, Number(before.revision) + 1)
      assert.notEqual(current.payload, before.payload)
      assert.deepEqual(
        await db
          .prepare(
            'SELECT generation,used_at IS NOT NULL used FROM auth_login_refresh_token WHERE login_session_id=? ORDER BY generation',
          )
          .bind(loginId)
          .all()
          .then((r) => r.results),
        [
          { generation: 0, used: 1 },
          { generation: 1, used: 0 },
        ],
      )
      assert.equal(
        await db
          .prepare('SELECT revoked_at FROM auth_login_session WHERE id=?')
          .bind(loginId)
          .first('revoked_at'),
        null,
      )
    })

    await t.test('logout racing a pending refresh cannot restore browser credentials', async () => {
      const { b, loginId } = await authenticated({ accessTtlMs: 0 })
      const delayed = await pause(b, 'refresh-race')
      assert.equal((await data(await request(b, '/logout', logout))).remoteRevocation, 'CONFIRMED')
      await conflict(await delayed())
      assert.equal(await row(b), null)
      assert.ok(
        await db
          .prepare('SELECT revoked_at FROM auth_login_session WHERE id=?')
          .bind(loginId)
          .first('revoked_at'),
      )
    })

    await t.test(
      'a transient refresh failure retains the old credential and can retry',
      async () => {
        const { b } = await authenticated({ accessTtlMs: 0 })
        const before = await row(b)
        await db.prepare('ALTER TABLE auth_rate_bucket RENAME TO fixture_missing_rate_bucket').run()
        try {
          assert.equal((await request(b)).status, 503)
          assert.deepEqual(await row(b), before)
        } finally {
          await db
            .prepare('ALTER TABLE fixture_missing_rate_bucket RENAME TO auth_rate_bucket')
            .run()
        }
        assert.equal((await data(await request(b))).state, 'AUTHENTICATED')
      },
    )

    await t.test('a delayed 401 does not erase newer browser credentials', async () => {
      const { b, loginId } = await authenticated()
      await db
        .prepare('DELETE FROM auth_login_access_token WHERE login_session_id=?')
        .bind(loginId)
        .run()
      const delayed = await pause(b, 'account-read-after')
      await db
        .prepare('UPDATE auth_web_session SET revision=revision+1 WHERE id_hash=?')
        .bind(b.id)
        .run()
      const newer = await row(b)
      await conflict(await delayed())
      assert.deepEqual(await row(b), newer)
      const result = await traced({ read: 2, write: 1 }, b)
      assert.equal((await data(result)).state, 'EXPIRED')
      assert.equal(await row(b), null)
    })

    await t.test(
      'lightweight browser account reads preserve the original central error boundary',
      async () => {
        const { b, accessToken } = await authenticated()
        const before = await row(b)
        const headers = { 'X-Fixture-Barrier': 'web-session-missing-config' }
        const central = await p.fetch(
          new Request(origin + '/api/v1/users/me', {
            headers: { ...headers, Authorization: 'Bearer ' + accessToken },
          }),
        )
        assert.equal(central.status, 503)
        assert.equal((await central.json()).error.code, 'UNIFIED_CONFIGURATION_INVALID')
        const browser = await request(b, '/session', { headers })
        assert.equal(browser.status, 503)
        assert.equal((await browser.json()).error.code, 'AUTH_UNAVAILABLE')
        assert.deepEqual(browser.headers.getSetCookie(), [])
        assert.deepEqual(await row(b), before)
      },
    )
  },
)
