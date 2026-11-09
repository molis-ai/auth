import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge, hash } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

test('AUTH-06 profiles, bound identities and password lifecycle on real WASM/D1', async (suite) => {
  const origin = 'http://127.0.0.1:8787'
  const p = await getRustProxy({
    AUTH_ORIGIN: origin,
    PROVIDER_STATE_KEY: secret(),
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
    for (const file of ['unified-account-local-seed.sql', 'mock-provider-local-seed.sql'])
      for (const sql of readFileSync(new URL('../' + file, import.meta.url), 'utf8')
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(sql).run()
    async function call(
      path: string,
      body?: unknown,
      actor?: any,
      proof?: string,
      key = secret(),
      method = body === undefined ? 'GET' : 'POST',
    ) {
      const r = await p.fetch(
        new Request(origin + '/api/v2' + path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
            ...(actor ? { Authorization: 'Bearer ' + actor.accessToken } : {}),
            ...(proof ? { 'X-Auth-Initiator-Proof': proof } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      return { status: r.status, ...(await r.json()) }
    }
    function ok(r: any, schema?: string) {
      assert.equal(r.status, 200, JSON.stringify(r))
      if (schema) assert.ok(validateNamed(schema, r.data), schema + ': ' + JSON.stringify(r.data))
      return r.data
    }
    async function me(actor: any) {
      return ok(await call('/users/me', undefined, actor), 'MeView')
    }
    async function begin(purpose: string, method: string, actor?: any, extra = {}, club = false) {
      await db.prepare('DELETE FROM auth_rate_bucket').run()
      const proof = secret(),
        verifier = secret()
      const b = {
        clientId:
          actor?.session.clientId ??
          (club ? 'molis-club-unified-local' : 'molis-work-unified-local'),
        purpose,
        method,
        redirectUri: `http://127.0.0.1:${(actor?.session.clientId ?? (club ? 'club' : '')).includes('club') ? 3000 : 4207}/account/callback`,
        state: secret(),
        codeChallenge: challenge(verifier),
        codeChallengeMethod: 'S256',
        initiatorChallenge: challenge(proof),
        ...extra,
      }
      const request: any = { ...b }
      if (purpose === 'REAUTH') delete request.purpose
      const r = ok(
        await call(
          purpose === 'REAUTH' ? '/users/me/reauthentications' : '/auth/transactions',
          request,
          actor,
        ),
        'TransactionCreated',
      )
      return {
        ...b,
        proof,
        verifier,
        actor,
        id: r.transactionId,
        path: '/auth/transactions/' + r.transactionId,
      }
    }
    async function verify(t: any, address: string) {
      const d = ok(
        await call(
          t.path + '/challenges',
          { channel: t.method === 'PHONE_OTP' ? 'SMS' : 'EMAIL', address },
          t.actor,
          t.proof,
        ),
        'ChallengeCreated',
      )
      const row = await db
        .prepare(
          'SELECT m.credential FROM auth_mock_delivery m JOIN auth_verification_challenge c ON c.delivery_id=m.delivery_id WHERE c.id=?',
        )
        .bind(d.challengeId)
        .first()
      assert.ok(row?.credential)
      return ok(
        await call(
          t.path + '/challenges/' + d.challengeId + '/verify',
          { credential: row.credential },
          t.actor,
          t.proof,
        ),
        'VerificationResult',
      ).verificationProof
    }
    async function complete(t: any) {
      return ok(await call(t.path + '/complete', {}, t.actor, t.proof), 'TransactionCompleteResult')
    }
    async function exchange(t: any, code: string) {
      return ok(
        await call('/auth/token', {
          grantType: 'authorization_code',
          clientId: t.clientId,
          code,
          redirectUri: t.redirectUri,
          codeVerifier: t.verifier,
        }),
        'TokenSet',
      )
    }
    async function phoneLogin(address: string, club = false) {
      const t = await begin('LOGIN', 'PHONE_OTP', undefined, {}, club)
      const proof = await verify(t, address)
      ok(await call(t.path + '/phone', { verificationProof: proof }, undefined, t.proof))
      return exchange(t, (await complete(t)).code)
    }
    async function passwordLogin(address: string, password: string, club = false) {
      const t = await begin('LOGIN', 'EMAIL_PASSWORD', undefined, {}, club)
      ok(await call(t.path + '/password', { email: address, password }, undefined, t.proof))
      return exchange(t, (await complete(t)).code)
    }
    async function providerReady(t: any, accountId = 'mock-' + t.method.toLowerCase() + '-local') {
      const provider = t.method.toLowerCase()
      const start = ok(
        await call(t.path + '/providers/' + provider + '/start', {}, t.actor, t.proof),
        'ProviderStartResult',
      )
      const first = await p.fetch(new Request(start.browserStartUrl))
      assert.equal(first.status, 303, await first.clone().text())
      const cookie = first.headers.get('Set-Cookie')!.split(';')[0]
      const page = await p.fetch(
        new Request(first.headers.get('Location')!, { headers: { Cookie: cookie } }),
      )
      const html = await page.text()
      const state = new URL(first.headers.get('Location')!).searchParams.get('state')!
      const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]
      const response = await p.fetch(
        new Request(origin + '/api/v2/auth/mock/' + provider + '/authorize', {
          method: 'POST',
          headers: {
            Origin: origin,
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ state, csrf, accountId, outcome: 'SUCCESS' }),
        }),
      )
      assert.equal(response.status, 303, await response.clone().text())
      return {
        callback: () =>
          p.fetch(new Request(response.headers.get('Location')!, { headers: { Cookie: cookie } })),
      }
    }
    async function verifyMethod(t: any, value: string, password?: string) {
      if (t.method === 'EMAIL_PASSWORD')
        ok(await call(t.path + '/password', { email: value, password }, t.actor, t.proof))
      else if (['GOOGLE', 'GITHUB'].includes(t.method)) {
        const r = await (await providerReady(t, value || undefined)).callback()
        assert.equal(r.status, 303, await r.clone().text())
      } else await verify(t, value)
      assert.equal(
        ok(await call(t.path, undefined, t.actor, t.proof), 'TransactionView').nextStep,
        'COMPLETE',
      )
    }
    async function reauth(
      actor: any,
      operation: string,
      target: any,
      method = 'PHONE_OTP',
      value = '+8613800000011',
      password?: string,
    ) {
      const t = await begin('REAUTH', method, actor, { operation, target })
      await verifyMethod(t, value, password)
      return (await complete(t)).operationProof
    }
    async function identity(actor: any, method: string, value: string, bindingId?: string) {
      const t = await begin(
        bindingId ? 'REPLACE' : 'BIND',
        method,
        actor,
        bindingId ? { bindingId } : {},
      )
      await verifyMethod(t, value)
      return (await complete(t)).newIdentityProof
    }
    async function bind(
      actor: any,
      method: string,
      value: string,
      authMethod = 'PHONE_OTP',
      authValue = '+8613800000011',
      password?: string,
    ) {
      const type = method === 'EMAIL_CODE' ? 'EMAIL' : method === 'PHONE_OTP' ? 'PHONE' : method
      const operationProof = await reauth(
        actor,
        'BIND_METHOD',
        { method: type },
        authMethod,
        authValue,
        password,
      )
      const newIdentityProof = await identity(actor, method, value)
      return ok(
        await call(
          '/users/me/login-methods/bind',
          { operationProof, newIdentityProof, expectedVersion: (await me(actor)).user.version },
          actor,
        ),
        'LoginMethodsView',
      )
    }
    let a = await phoneLogin('+8613800000011')
    const otherDevice = await phoneLogin('+8613800000011', true)
    const b = await phoneLogin('+8613800000012')
    let emailBinding: string, phoneBinding: string, googleBinding: string
    let password = 'Fixture-Saturn-Seven-93'
    let peer: Awaited<ReturnType<typeof passwordLogin>>
    await suite.test(
      'UAS-03/26: profile versioning, PNG cleaning/removal, platform view and idempotent retry',
      async () => {
        const initial = await me(a)
        phoneBinding = initial.loginMethods[0].bindingId
        await db
          .prepare(
            "INSERT INTO auth_platform_permission(user_id,permission,status,granted_by,granted_at) VALUES (?,'TENANT_READ','ACTIVE',?,?)",
          )
          .bind(initial.user.userId, initial.user.userId, Date.now())
          .run()
        assert.deepEqual((await me(a)).platformCapabilities, ['TENANT_READ'])
        await db
          .prepare(
            "UPDATE auth_platform_permission SET status='REVOKED',revoked_at=? WHERE user_id=?",
          )
          .bind(Date.now(), initial.user.userId)
          .run()
        assert.deepEqual((await me(a)).platformCapabilities, [])
        assert.equal(initial.passwordEnabled, false)
        assert.deepEqual(initial.platformCapabilities, [])
        assert.equal((await call('/users/me')).status, 401)
        const png = new PNG({ width: 1, height: 1 })
        png.data.fill(127)
        const image =
          'data:image/png;base64,' +
          Buffer.concat([PNG.sync.write(png), Buffer.from('discarded-metadata')]).toString('base64')
        const body = {
          displayName: '账号测试',
          avatarDataUrl: image,
          expectedVersion: initial.user.version,
        }
        const key = secret()
        const profile = ok(
          await call('/users/me/profile', body, a, undefined, key, 'PATCH'),
          'UserView',
        )
        assert.equal(profile.displayName, body.displayName)
        assert.equal(PNG.sync.read(Buffer.from(profile.avatarUrl.split(',')[1], 'base64')).width, 1)
        assert.deepEqual(
          ok(await call('/users/me/profile', body, a, undefined, key, 'PATCH')),
          profile,
        )
        assert.equal(
          (
            await call(
              '/users/me/profile',
              { ...body, displayName: 'changed' },
              a,
              undefined,
              key,
              'PATCH',
            )
          ).error.code,
          'IDEMPOTENCY_CONFLICT',
        )
        assert.equal(
          (await call('/users/me/profile', body, a, undefined, secret(), 'PATCH')).error.code,
          'VERSION_CONFLICT',
        )
        for (const avatarDataUrl of [
          'https://evil.invalid/avatar.png',
          'data:image/png;base64,' + Buffer.alloc(30).toString('base64'),
        ]) {
          assert.equal(
            (
              await call(
                '/users/me/profile',
                { avatarDataUrl, expectedVersion: profile.version },
                a,
                undefined,
                secret(),
                'PATCH',
              )
            ).status,
            400,
          )
          assert.equal((await me(a)).user.avatarUrl, profile.avatarUrl)
        }
        ok(
          await call(
            '/users/me/profile',
            { avatarDataUrl: null, expectedVersion: profile.version },
            a,
            undefined,
            secret(),
            'PATCH',
          ),
        )
        assert.equal((await me(a)).user.avatarUrl, null)
        assert.equal((await me(b)).user.displayName, 'Molis 用户')
      },
    )
    await suite.test(
      'UAS-06/07/08: verified email alone is not usable; profile edits preserve proofs; last usable method stays',
      async () => {
        const operationProof = await reauth(a, 'BIND_METHOD', { method: 'EMAIL' })
        const newIdentityProof = await identity(a, 'EMAIL_CODE', 'alice@example.test')
        assert.equal((await db.prepare('SELECT count(*) n FROM auth_user_email').first()).n, 0)
        const profile = ok(
          await call(
            '/users/me/profile',
            { displayName: 'Alice', expectedVersion: (await me(a)).user.version },
            a,
            undefined,
            secret(),
            'PATCH',
          ),
        )
        const body = { operationProof, newIdentityProof, expectedVersion: profile.version }
        assert.equal(
          (
            await call(
              '/users/me/login-methods/bind',
              { ...body, operationProof: newIdentityProof },
              a,
            )
          ).status,
          401,
        )
        assert.equal(
          (
            await call(
              '/users/me/login-methods/bind',
              { ...body, newIdentityProof: operationProof },
              a,
            )
          ).status,
          401,
        )
        const key = secret()
        const bound = ok(
          await call('/users/me/login-methods/bind', body, a, undefined, key),
          'LoginMethodsView',
        )
        emailBinding = bound.loginMethods.find((x: any) => x.type === 'EMAIL').bindingId
        assert.equal(bound.loginMethods.find((x: any) => x.type === 'EMAIL').verified, true)
        assert.equal(bound.loginMethods.find((x: any) => x.type === 'EMAIL').usableForLogin, false)
        assert.deepEqual(
          ok(await call('/users/me/login-methods/bind', body, a, undefined, key)),
          bound,
        )
        assert.equal(
          (
            await call(
              '/users/me/login-methods/bind',
              { ...body, expectedVersion: bound.version },
              a,
            )
          ).status,
          401,
        )
        const unlinkProof = await reauth(a, 'UNLINK_METHOD', { bindingId: phoneBinding })
        const rejected = await call(
          '/users/me/login-methods/' + phoneBinding + '/unlink',
          { operationProof: unlinkProof, expectedVersion: bound.version },
          a,
        )
        assert.equal(rejected.error.code, 'LAST_LOGIN_METHOD')
        assert.equal((await me(a)).loginMethods.length, 2)
      },
    )
    await suite.test(
      'UAS-33/41: first password keeps only trusted current login, preserves deadlines and supports retry/refresh',
      async () => {
        const operationProof = await reauth(a, 'CHANGE_PASSWORD', { kind: 'PASSWORD' })
        const current = (await me(a)).session
        const body = {
          operationProof,
          newPassword: password,
          expectedVersion: (await me(a)).user.version,
        }
        const key = secret()
        assert.equal(
          (
            await call(
              '/users/me/password/change',
              { ...body, exceptSessionId: otherDevice.session.loginSessionId },
              a,
            )
          ).status,
          400,
        )
        const responses = await Promise.all([
          call('/users/me/password/change', body, a, undefined, key),
          call('/users/me/password/change', body, a, undefined, key),
        ])
        const changed = ok(responses[0], 'PasswordChangeResult')
        assert.deepEqual(ok(responses[1], 'PasswordChangeResult'), changed)
        assert.equal(changed.keptLoginSessionId, a.session.loginSessionId)
        for (const field of [
          'authenticatedAt',
          'lastActiveAt',
          'idleExpiresAt',
          'absoluteExpiresAt',
        ])
          assert.equal(changed.session[field], current[field])
        assert.deepEqual(
          ok(await call('/users/me/password/change', body, a, undefined, key)),
          changed,
        )
        assert.equal((await call('/users/me', undefined, otherDevice)).status, 401)
        assert.equal(
          (
            await call('/auth/token', {
              grantType: 'refresh_token',
              clientId: otherDevice.session.clientId,
              refreshToken: otherDevice.refreshToken,
            })
          ).status,
          401,
        )
        a = ok(
          await call('/auth/token', {
            grantType: 'refresh_token',
            clientId: a.session.clientId,
            refreshToken: a.refreshToken,
          }),
          'TokenSet',
        )
        const view = await me(a)
        assert.equal(view.passwordEnabled, true)
        assert.equal(view.loginMethods.find((x: any) => x.type === 'EMAIL').usableForLogin, true)
        await me(b)
        await passwordLogin('alice@example.test', password, true)
      },
    )
    await suite.test(
      'UAS-06/07/28: Google/GitHub binding and any-bound-method reauthentication; conflicts never merge',
      async () => {
        const g = await bind(a, 'GOOGLE', '')
        googleBinding = g.loginMethods.find((x: any) => x.type === 'GOOGLE').bindingId
        await bind(a, 'GITHUB', '', 'GOOGLE', '')
        const n = (await db.prepare('SELECT count(*) n FROM auth_user').first()).n
        const operationProof = await reauth(
          b,
          'BIND_METHOD',
          { method: 'GOOGLE' },
          'PHONE_OTP',
          '+8613800000012',
        )
        const newIdentityProof = await identity(b, 'GOOGLE', '')
        const conflict = await call(
          '/users/me/login-methods/bind',
          { operationProof, newIdentityProof, expectedVersion: (await me(b)).user.version },
          b,
        )
        assert.equal(conflict.error.code, 'IDENTITY_IN_USE')
        assert.equal((await me(b)).loginMethods.length, 1)
        const wrong = await begin('REAUTH', 'GOOGLE', b, {
          operation: 'CHANGE_PASSWORD',
          target: { kind: 'PASSWORD' },
        })
        const callback = await (await providerReady(wrong)).callback()
        assert.equal(callback.status, 409)
        assert.equal((await db.prepare('SELECT count(*) n FROM auth_user').first()).n, n)
        assert.equal((await call(wrong.path + '/complete', {}, b, wrong.proof)).status, 409)
      },
    )
    await suite.test(
      'UAS-06/26: wrong operation, user, session, expiry and canceled provider transaction reject mutation',
      async () => {
        const proof = await reauth(a, 'UNLINK_METHOD', { bindingId: phoneBinding }, 'GITHUB', '')
        assert.equal(
          (
            await call(
              '/users/me/login-methods/' + googleBinding + '/unlink',
              { operationProof: proof, expectedVersion: (await me(a)).user.version },
              a,
            )
          ).status,
          403,
        )
        const another = await passwordLogin('alice@example.test', password)
        assert.equal(
          (
            await call(
              '/users/me/login-methods/' + phoneBinding + '/unlink',
              { operationProof: proof, expectedVersion: (await me(a)).user.version },
              another,
            )
          ).status,
          401,
        )
        assert.equal(
          (
            await call(
              '/users/me/login-methods/' + phoneBinding + '/unlink',
              { operationProof: proof, expectedVersion: (await me(b)).user.version },
              b,
            )
          ).status,
          401,
        )
        await db
          .prepare('UPDATE auth_identity_proof SET expires_at=created_at+1 WHERE token_hash=?')
          .bind(hash(proof))
          .run()
        await new Promise((r) => setTimeout(r, 5))
        assert.equal(
          (
            await call(
              '/users/me/login-methods/' + phoneBinding + '/unlink',
              { operationProof: proof, expectedVersion: (await me(a)).user.version },
              a,
            )
          ).status,
          401,
        )
        const t = await begin('BIND', 'GOOGLE', a)
        const ready = await providerReady(t)
        ok(await call(t.path + '/cancel', {}, a, t.proof))
        assert.equal((await ready.callback()).status, 401)
      },
    )
    await suite.test(
      'UAS-06/07: replace verifies a new identity atomically, and unlink preserves other usable methods',
      async () => {
        const operationProof = await reauth(
          a,
          'REPLACE_METHOD',
          { bindingId: emailBinding },
          'EMAIL_PASSWORD',
          'alice@example.test',
          password,
        )
        const newIdentityProof = await identity(
          a,
          'EMAIL_CODE',
          'new-alice@example.test',
          emailBinding,
        )
        const result = ok(
          await call(
            '/users/me/login-methods/' + emailBinding + '/replace',
            { operationProof, newIdentityProof, expectedVersion: (await me(a)).user.version },
            a,
          ),
          'LoginMethodsView',
        )
        assert.ok(!result.loginMethods.some((x: any) => x.bindingId === emailBinding))
        emailBinding = result.loginMethods.find((x: any) => x.type === 'EMAIL').bindingId
        const old = await begin('LOGIN', 'EMAIL_PASSWORD')
        assert.equal(
          (
            await call(
              old.path + '/password',
              { email: 'alice@example.test', password },
              undefined,
              old.proof,
            )
          ).status,
          401,
        )
        await passwordLogin('new-alice@example.test', password)
        const unlink = await reauth(
          a,
          'UNLINK_METHOD',
          { bindingId: phoneBinding },
          'EMAIL_PASSWORD',
          'new-alice@example.test',
          password,
        )
        const removed = ok(
          await call(
            '/users/me/login-methods/' + phoneBinding + '/unlink',
            { operationProof: unlink, expectedVersion: result.version },
            a,
          ),
          'LoginMethodsView',
        )
        assert.ok(!removed.loginMethods.some((x: any) => x.bindingId === phoneBinding))
        const gone = await begin('REAUTH', 'PHONE_OTP', a, {
          operation: 'CHANGE_PASSWORD',
          target: { kind: 'PASSWORD' },
        })
        assert.equal(
          (
            await call(
              gone.path + '/challenges',
              { channel: 'SMS', address: '+8613800000011' },
              a,
              gone.proof,
            )
          ).status,
          401,
        )
      },
    )
    await suite.test(
      'UAS-06/07: two accounts race for one identity; losing operation leaves original account unchanged',
      async () => {
        const opA = await reauth(a, 'BIND_METHOD', { method: 'PHONE' }, 'GOOGLE', '')
        const idA = await identity(a, 'PHONE_OTP', '+8613800000013')
        const opB = await reauth(
          b,
          'BIND_METHOD',
          { method: 'PHONE' },
          'PHONE_OTP',
          '+8613800000012',
        )
        const idB = await identity(b, 'PHONE_OTP', '+8613800000013')
        const beforeA = await me(a),
          beforeB = await me(b)
        const results = await Promise.all([
          call(
            '/users/me/login-methods/bind',
            { operationProof: opA, newIdentityProof: idA, expectedVersion: beforeA.user.version },
            a,
          ),
          call(
            '/users/me/login-methods/bind',
            { operationProof: opB, newIdentityProof: idB, expectedVersion: beforeB.user.version },
            b,
          ),
        ])
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
        assert.equal(results.find((r) => r.status === 409).error.code, 'IDENTITY_IN_USE')
        assert.equal(
          (
            await db
              .prepare(
                "SELECT count(*) n FROM auth_user_phone WHERE canonical_phone='+8613800000013'",
              )
              .first()
          ).n,
          1,
        )
        const loser = results[0].status === 409 ? a : b
        const before = results[0].status === 409 ? beforeA : beforeB
        assert.equal((await me(loser)).user.version, before.user.version)
      },
    )
    await suite.test(
      'UAS-06/07: replacement conflict preserves the old binding; identity edits reject unfinished logins',
      async () => {
        await bind(b, 'EMAIL_CODE', 'taken@example.test', 'PHONE_OTP', '+8613800000012')
        const operationProof = await reauth(
          a,
          'REPLACE_METHOD',
          { bindingId: emailBinding },
          'GOOGLE',
          '',
        )
        const newIdentityProof = await identity(a, 'EMAIL_CODE', 'taken@example.test', emailBinding)
        const before = await me(a)
        const conflict = await call(
          '/users/me/login-methods/' + emailBinding + '/replace',
          { operationProof, newIdentityProof, expectedVersion: before.user.version },
          a,
        )
        assert.equal(conflict.error.code, 'IDENTITY_IN_USE')
        assert.deepEqual((await me(a)).loginMethods, before.loginMethods)
        assert.equal((await me(a)).user.version, before.user.version)
        const login = await begin('LOGIN', 'EMAIL_PASSWORD')
        ok(
          await call(
            login.path + '/password',
            { email: 'new-alice@example.test', password },
            undefined,
            login.proof,
          ),
        )
        const code = (await complete(login)).code
        await bind(a, 'EMAIL_CODE', 'second@example.test', 'GOOGLE', '')
        assert.equal(
          (
            await call('/auth/token', {
              grantType: 'authorization_code',
              clientId: login.clientId,
              redirectUri: login.redirectUri,
              code,
              codeVerifier: login.verifier,
            })
          ).status,
          409,
        )
        await me(a)
      },
    )
    await suite.test(
      'UAS-07/26: racing unlinks leave one usable method and consume only the winning proof',
      async () => {
        const c = await phoneLogin('+8613800000014')
        await db
          .prepare(
            "INSERT INTO auth_mock_provider_account(id,environment_id,provider,subject,label) VALUES ('unlink-race','unified-local','GOOGLE','unlink-race-subject','Unlink race fixture')",
          )
          .run()
        await bind(c, 'GOOGLE', 'unlink-race', 'PHONE_OTP', '+8613800000014')
        const before = await me(c)
        assert.equal(before.loginMethods.length, 2)
        const proofs = []
        for (const method of before.loginMethods)
          proofs.push(
            await reauth(
              c,
              'UNLINK_METHOD',
              { bindingId: method.bindingId },
              'PHONE_OTP',
              '+8613800000014',
            ),
          )
        const results = await Promise.all(
          before.loginMethods.map((m: any, i: number) =>
            call(
              '/users/me/login-methods/' + m.bindingId + '/unlink',
              { operationProof: proofs[i], expectedVersion: before.user.version },
              c,
            ),
          ),
        )
        assert.deepEqual(results.map((r: any) => r.status).sort(), [200, 409])
        const after = await me(c)
        assert.equal(after.loginMethods.length, 1)
        assert.equal(after.loginMethods[0].usableForLogin, true)
        const consumed = await db
          .prepare(
            'SELECT count(*) n FROM auth_identity_proof WHERE token_hash IN (?,?) AND consumed_at IS NOT NULL',
          )
          .bind(...proofs.map(hash))
          .first()
        assert.equal(consumed.n, 1)
      },
    )
    await suite.test(
      'UAS-26/41 V2U-01: independent V2 clients share versions and identity-proof revocation',
      async () => {
        peer = await passwordLogin('new-alice@example.test', password, true)
        const before = await me(a)
        ok(
          await call(
            '/users/me/profile',
            {
              displayName: 'Shared account',
              avatarDataUrl: null,
              expectedVersion: before.user.version,
            },
            peer,
            undefined,
            secret(),
            'PATCH',
          ),
        )
        assert.equal((await me(a)).user.version, before.user.version + 1)
        assert.equal(
          (
            await call(
              '/users/me/profile',
              { displayName: 'stale', expectedVersion: before.user.version },
              a,
              undefined,
              secret(),
              'PATCH',
            )
          ).error.code,
          'VERSION_CONFLICT',
        )
        await db
          .prepare(
            "INSERT INTO auth_mock_provider_account(id,environment_id,provider,subject,label) VALUES ('peer-extra','unified-local','GOOGLE','peer-extra-subject','Extra identity fixture')",
          )
          .run()
        await bind(a, 'GOOGLE', 'peer-extra', 'EMAIL_PASSWORD', 'new-alice@example.test', password)
        const extra = await db
          .prepare("SELECT id FROM auth_external_identity WHERE subject='peer-extra-subject'")
          .first()
        const operationProof = await reauth(
          a,
          'CHANGE_PASSWORD',
          { kind: 'PASSWORD' },
          'GOOGLE',
          '',
        )
        const unlinkProof = await reauth(
          peer,
          'UNLINK_METHOD',
          { bindingId: extra.id },
          'EMAIL_PASSWORD',
          'new-alice@example.test',
          password,
        )
        ok(
          await call(
            '/users/me/login-methods/' + extra.id + '/unlink',
            { operationProof: unlinkProof, expectedVersion: (await me(peer)).user.version },
            peer,
          ),
        )
        assert.equal(
          (
            await call(
              '/users/me/password/change',
              {
                operationProof,
                newPassword: password,
                expectedVersion: (await me(a)).user.version,
              },
              a,
            )
          ).status,
          401,
        )
        peer = await passwordLogin('new-alice@example.test', password, true)
      },
    )
    await suite.test(
      'UAS-26/41: identity edits invalidate old reset proofs; reset revokes all sessions and pending proofs/codes',
      async () => {
        const resetOld = await begin('PASSWORD_RESET', 'EMAIL_CODE')
        await verify(resetOld, 'new-alice@example.test')
        const oldProof = (await complete(resetOld)).resetProof
        await bind(a, 'EMAIL_CODE', 'spare@example.test', 'GITHUB', '')
        assert.equal(
          (
            await call(
              '/auth/password-reset/complete',
              { transactionId: resetOld.id, resetProof: oldProof, newPassword: password },
              undefined,
              resetOld.proof,
            )
          ).status,
          401,
        )
        const pending = await begin('LOGIN', 'EMAIL_PASSWORD')
        ok(
          await call(
            pending.path + '/password',
            { email: 'new-alice@example.test', password },
            undefined,
            pending.proof,
          ),
        )
        const oldCode = (await complete(pending)).code
        const staleOperation = await reauth(
          a,
          'CHANGE_PASSWORD',
          { kind: 'PASSWORD' },
          'GOOGLE',
          '',
        )
        const other = await passwordLogin('new-alice@example.test', password, true)
        const reset = await begin('PASSWORD_RESET', 'EMAIL_CODE')
        await verify(reset, 'new-alice@example.test')
        const resetProof = (await complete(reset)).resetProof
        password = 'Fixture-Jupiter-Eight-94'
        const body = { transactionId: reset.id, resetProof, newPassword: password }
        assert.equal(
          (await call('/auth/password-reset/complete', body, undefined, secret())).status,
          401,
        )
        ok(
          await call('/auth/password-reset/complete', body, undefined, reset.proof),
          'PasswordResetResult',
        )
        assert.equal((await call('/users/me', undefined, peer)).status, 401)
        assert.equal(
          (await call('/auth/password-reset/complete', body, undefined, reset.proof)).status,
          401,
        )
        for (const actor of [a, other]) {
          assert.equal((await call('/users/me', undefined, actor)).status, 401)
          assert.equal(
            (
              await call('/auth/token', {
                grantType: 'refresh_token',
                clientId: actor.session.clientId,
                refreshToken: actor.refreshToken,
              })
            ).status,
            401,
          )
        }
        assert.equal(
          (
            await call('/auth/token', {
              grantType: 'authorization_code',
              clientId: pending.clientId,
              code: oldCode,
              redirectUri: pending.redirectUri,
              codeVerifier: pending.verifier,
            })
          ).status,
          409,
        )
        a = await passwordLogin('new-alice@example.test', password)
        assert.equal(
          (
            await call(
              '/users/me/password/change',
              {
                operationProof: staleOperation,
                newPassword: password,
                expectedVersion: (await me(a)).user.version,
              },
              a,
            )
          ).status,
          401,
        )
        await me(b)
        const events = JSON.stringify(
          (await db.prepare('SELECT * FROM auth_audit_event').all()).results,
        )
        const receipts = JSON.stringify(
          (await db.prepare('SELECT * FROM auth_management_result').all()).results,
        )
        for (const value of [password, resetProof, staleOperation, a.accessToken, a.refreshToken]) {
          assert.ok(!events.includes(value))
          assert.ok(!receipts.includes(value))
        }
      },
    )
    await suite.test(
      'UAS-26: management receipts expire without removing live retry results',
      async () => {
        const count = (await db.prepare('SELECT count(*) n FROM auth_management_result').first()).n
        const user = (await me(a)).user.userId
        await db
          .prepare(
            "INSERT INTO auth_management_result VALUES (?,?,'expired-fixture','fixture',?,?,200,'{}',0,1)",
          )
          .bind(user, a.session.clientId, hash(secret()), hash(secret()))
          .run()
        await p.scheduled()
        assert.equal(
          (
            await db
              .prepare(
                "SELECT count(*) n FROM auth_management_result WHERE operation='expired-fixture'",
              )
              .first()
          ).n,
          0,
        )
        assert.equal(
          (await db.prepare('SELECT count(*) n FROM auth_management_result').first()).n,
          count,
        )
      },
    )
    await suite.test(
      'UAS-26: logout blocks a late authenticated provider bind and proof completion',
      async () => {
        const t = await begin('BIND', 'GITHUB', a)
        const ready = await providerReady(t)
        ok(await call('/sessions/current/logout', {}, a))
        assert.equal((await ready.callback()).status, 409)
        assert.equal((await call(t.path + '/complete', {}, a, t.proof)).status, 401)
      },
    )
  } finally {
    await p.dispose()
  }
})
