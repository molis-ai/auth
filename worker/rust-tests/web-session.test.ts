import { authOpen } from '../rust/src/runtime/federation.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { challenge, hash, secret } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

test('V2U-03 V2U-07 same-origin BFF hides proofs, persists encrypted login, and rejects CSRF', async (t) => {
  const origin = 'http://127.0.0.1:8787',
    bffKey = secret()
  const fixturePassword = secret() + 'aA!5'
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
    assert.equal(
      ok(await call('/api/account/auth/capabilities')).methods.length,
      5,
      'capabilities bootstrap the anonymous browser before parent session loading',
    )
    assert.equal(
      (await call('/api/account/session', undefined, { Origin: 'https://evil.example' })).status,
      403,
    )
    assert.equal(ok(await call('/api/account/session')).state, 'ANONYMOUS')
    assert.ok(cookie && csrf)
    // LOGIN-P1-04: the BFF binds client identity; capabilities expose no proofs or secrets.
    const methods = ['ACCOUNT_PASSWORD', 'EMAIL_CODE', 'PHONE_OTP', 'GOOGLE', 'GITHUB']
    assert.deepEqual(ok(await call('/api/account/auth/capabilities')).methods, methods)
    assert.deepEqual(ok(await call('/api/v2/auth/capabilities?clientId=auth-web')).methods, methods)
    assert.equal((await call('/api/v2/auth/capabilities?clientId=unknown')).status, 403)
    assert.equal(
      (await call('/api/v2/auth/capabilities?clientId=auth-web&clientId=other')).status,
      400,
    )
    assert.equal(
      (
        await call('/api/v2/auth/capabilities?clientId=auth-web', undefined, {
          Origin: 'https://evil.example',
        })
      ).status,
      403,
    )
    await db.prepare("UPDATE auth_client SET status='DISABLED' WHERE client_id='auth-web'").run()
    assert.equal((await call('/api/account/auth/capabilities')).status, 403)
    await db.prepare("UPDATE auth_client SET status='ACTIVE' WHERE client_id='auth-web'").run()
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
    const sent = ok(
      await call('/api/account/auth/verification-codes', {
        purpose: 'LOGIN',
        channel: 'SMS',
        address: '+8613800000888',
      }),
    )
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
    await t.test(
      'BFF and direct V2 share per-IP delivery quotas and report the D1 expiry',
      async () => {
        const ipA = '192.0.2.1',
          ipB = '192.0.2.2',
          ipC = '192.0.2.3'
        const sendBody = (address: string) => ({ purpose: 'LOGIN', channel: 'EMAIL', address })
        async function browser(ip: string) {
          const bootstrap = await p.fetch(
            new Request(origin + '/api/account/session', {
              headers: { Origin: origin, 'CF-Connecting-IP': ip },
            }),
          )
          assert.equal(bootstrap.status, 200)
          assert.equal((await bootstrap.json()).data.state, 'ANONYMOUS')
          const cookie = bootstrap.headers.get('Set-Cookie')?.split(';')[0]
          const csrf = bootstrap.headers.get('X-CSRF-Token')
          assert.ok(cookie && csrf)
          return {
            cookie,
            send: (address: string) =>
              p.fetch(
                new Request(origin + '/api/account/auth/verification-codes', {
                  method: 'POST',
                  headers: {
                    Origin: origin,
                    Cookie: cookie,
                    'X-CSRF-Token': csrf,
                    'Content-Type': 'application/json',
                    'CF-Connecting-IP': ip,
                  },
                  body: JSON.stringify(sendBody(address)),
                }),
              ),
          }
        }
        function direct(ip: string, address: string) {
          const proof = secret()
          return p.fetch(
            new Request(origin + '/api/v2/auth/verification-codes', {
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
        assert.notEqual(first.cookie, second.cookie)
        const hourlyBucket = (ip: string) => hash(`v2-delivery-ip-hour:${ip}`)
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

        const accepted = await first.send('quota-first@example.test')
        assert.equal(accepted.status, 200, await accepted.text())
        await assertThrottled(() => second.send('quota-same-ip@example.test'))
        const otherIp = await other.send('quota-other-ip@example.test')
        assert.equal(otherIp.status, 200, await otherIp.text())
        await assertThrottled(() => direct(ipA, 'quota-direct-same@example.test'))
        const directOther = await direct(ipC, 'quota-direct-other@example.test')
        assert.equal(directOther.status, 200, await directOther.text())

        const hourlyHits = async (ip: string) =>
          (
            await db
              .prepare('SELECT hits FROM auth_rate_bucket WHERE bucket_hash=?')
              .bind(hourlyBucket(ip))
              .first()
          )?.hits
        assert.equal(await hourlyHits(ipA), 62)
        assert.equal(await hourlyHits(ipB), 1)
        assert.equal(await hourlyHits(ipC), 1)
      },
    )
    // V2-04: reload the same worker bindings, then change the local session generation twice.
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
      await p.updateBindings({ MOLIS_LOCAL_GENERATION: generation })
      assert.equal(
        ok(await call('/api/account/session', undefined, { Cookie: oldCookie })).state,
        'ANONYMOUS',
      )
    }
  } finally {
    await p.dispose()
  }
})
