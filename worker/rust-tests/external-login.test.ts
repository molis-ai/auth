import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, hash, challenge } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'
import { authOpen, authSeal } from '../rust/src/runtime/federation.js'

test('AUTH-05 isolated Google/GitHub authorization through real transactions and sessions', async (suite) => {
  const origin = 'http://127.0.0.1:8787'
  const encryptionKey = secret()
  const p = await getRustProxy({
    AUTH_ORIGIN: origin,
    PROVIDER_STATE_KEY: encryptionKey,
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
    async function api(path: string, body?: unknown, proof?: string, access?: string) {
      const r = await p.fetch(
        new Request(origin + '/api/v2' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': secret(),
            ...(proof ? { 'X-Auth-Initiator-Proof': proof } : {}),
            ...(access ? { Authorization: 'Bearer ' + access } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      return { status: r.status, ...(await r.json()) }
    }
    async function begin(provider = 'google', club = false) {
      // Keep individual security scenarios independent of the per-IP quota.
      await db.prepare('DELETE FROM auth_rate_bucket').run()
      const proof = secret(),
        verifier = secret()
      const b = {
        clientId: club ? 'molis-club-unified-local' : 'molis-work-unified-local',
        purpose: 'LOGIN',
        method: provider.toUpperCase(),
        redirectUri: `http://127.0.0.1:${club ? 3000 : 4207}/account/callback`,
        state: secret(),
        codeChallenge: challenge(verifier),
        codeChallengeMethod: 'S256',
        initiatorChallenge: challenge(proof),
      }
      const r = await api('/auth/transactions', b)
      assert.equal(r.status, 200, JSON.stringify(r))
      assert.ok(validateNamed('TransactionCreated', r.data))
      assert.equal(r.data.nextStep, 'START_PROVIDER')
      return {
        ...b,
        proof,
        verifier,
        provider,
        id: r.data.transactionId,
        path: '/auth/transactions/' + r.data.transactionId,
      }
    }
    async function start(t: any) {
      const r = await api(t.path + '/providers/' + t.provider + '/start', {}, t.proof)
      assert.equal(r.status, 200, JSON.stringify(r))
      assert.ok(validateNamed('ProviderStartResult', r.data))
      const ticketUrl = r.data.browserStartUrl
      const response = await p.fetch(new Request(ticketUrl))
      assert.equal(response.status, 303, await response.clone().text())
      const cookie = response.headers.get('Set-Cookie')!.split(';')[0]
      assert.match(response.headers.get('Set-Cookie')!, /HttpOnly/)
      assert.match(response.headers.get('Set-Cookie')!, /SameSite=Lax/)
      const authorizeUrl = response.headers.get('Location')!
      const page = await p.fetch(new Request(authorizeUrl, { headers: { Cookie: cookie } }))
      assert.equal(page.status, 200, await page.clone().text())
      assert.equal(
        page.headers.get('Content-Security-Policy'),
        `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${new URL(t.redirectUri).origin}`,
      )
      assert.equal(page.headers.get('Referrer-Policy'), 'same-origin')
      const html = await page.text()
      assert.match(html, /仅用于隔离测试/)
      const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]
      assert.equal((await api(t.path, undefined, t.proof)).data.nextStep, 'WAIT_PROVIDER')
      return {
        ...t,
        ticketUrl,
        authorizeUrl,
        cookie,
        csrf,
        providerState: new URL(authorizeUrl).searchParams.get('state')!,
      }
    }
    async function authorize(
      f: any,
      outcome = 'SUCCESS',
      accountId = 'mock-' + f.provider + '-local',
      extra = {},
    ) {
      return p.fetch(
        new Request(origin + '/api/v2/auth/mock/' + f.provider + '/authorize', {
          method: 'POST',
          headers: {
            Cookie: f.cookie,
            Origin: origin,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            state: f.providerState,
            csrf: f.csrf,
            accountId,
            outcome,
            ...extra,
          }),
        }),
      )
    }
    async function ready(provider = 'google', club = false, accountId?: string) {
      const f = await start(await begin(provider, club))
      const r = await authorize(f, 'SUCCESS', accountId)
      assert.equal(r.status, 303, await r.clone().text())
      return { ...f, callbackUrl: r.headers.get('Location')! }
    }
    async function callback(f: any, cookie = f.cookie, url = f.callbackUrl) {
      return p.fetch(new Request(url, { headers: { Cookie: cookie } }))
    }
    async function accepted(f: any, response?: Response, result = 'VERIFIED') {
      const r = response ?? (await callback(f))
      assert.equal(r.status, 303, await r.clone().text())
      const dest = new URL(r.headers.get('Location')!)
      assert.equal(dest.origin + dest.pathname, f.redirectUri)
      assert.deepEqual([...dest.searchParams.keys()].sort(), ['result', 'state', 'transactionId'])
      assert.equal(dest.searchParams.get('state'), f.state)
      assert.equal(dest.searchParams.get('transactionId'), f.id)
      assert.equal(dest.searchParams.get('result'), result)
      assert.match(r.headers.get('Set-Cookie')!, /Max-Age=0/)
    }
    async function finish(f: any) {
      const r = await api(f.path + '/complete', {}, f.proof)
      assert.equal(r.status, 200, JSON.stringify(r))
      assert.ok(validateNamed('TransactionCompleteResult', r.data))
      assert.equal(r.data.state, f.state)
      const tokens = await api('/auth/token', {
        grantType: 'authorization_code',
        clientId: f.clientId,
        code: r.data.code,
        redirectUri: f.redirectUri,
        codeVerifier: f.verifier,
      })
      assert.equal(tokens.status, 200, JSON.stringify(tokens))
      assert.ok(validateNamed('TokenSet', tokens.data))
      return tokens.data
    }
    async function count(table: string) {
      return (await db.prepare(`SELECT count(*) n FROM ${table}`).first()).n
    }
    let googleSession: any
    await suite.test(
      'UAS-05/11: both products and providers issue independent sessions for stable identities',
      async () => {
        const sessions = []
        for (const provider of ['google', 'github']) {
          for (const club of [false, true]) {
            const f = await ready(provider, club)
            await accepted(f)
            const tokens = await finish(f)
            sessions.push(tokens.session.loginSessionId)
            if (provider === 'google') googleSession = tokens
            assert.equal((await callback(f)).status, 401)
            assert.equal((await api(f.path + '/complete', {}, f.proof)).status, 409)
          }
        }
        assert.equal(new Set(sessions).size, 4)
        assert.equal(await count('auth_user'), 2)
        assert.equal(await count('auth_external_identity'), 2)
        assert.equal(await count('auth_user_email'), 0)
        assert.equal(
          await count('auth_space'),
          0,
          'a V2 identity does not create a separate V1 personal space',
        )
      },
    )
    await suite.test(
      'UAS-28/40: provider email never merges identities; mock issuer cannot match live identity',
      async () => {
        const google = await db
          .prepare("SELECT user_id FROM auth_external_identity WHERE provider='GOOGLE'")
          .first()
        await db
          .prepare(
            "INSERT INTO auth_user_email VALUES ('existing-email',?,'same@example.test',?,?)",
          )
          .bind(google.user_id, Date.now(), Date.now())
          .run()
        await db
          .prepare(
            "UPDATE auth_mock_provider_account SET email='same@example.test',email_verified=1 WHERE provider='GITHUB'",
          )
          .run()
        await db
          .prepare(
            "INSERT INTO auth_external_identity VALUES ('live-identity',?,'GOOGLE','https://accounts.google.com','google-fixture-1',?)",
          )
          .bind(google.user_id, Date.now())
          .run()
        const f = await ready('github')
        await accepted(f)
        await finish(f)
        const github = await db
          .prepare("SELECT user_id FROM auth_external_identity WHERE provider='GITHUB'")
          .first()
        assert.notEqual(github.user_id, google.user_id)
        await db
          .prepare(
            "INSERT INTO auth_mock_provider_account(id,environment_id,provider,subject,label,email,email_verified) VALUES ('same-email-new','unified-local','GITHUB','new-subject','Same email fixture','same@example.test',1)",
          )
          .run()
        const newIdentity = await ready('github', false, 'same-email-new')
        await accepted(newIdentity)
        const newSession = await finish(newIdentity)
        const newOwner = await db
          .prepare('SELECT user_id FROM auth_login_session WHERE id=?')
          .bind(newSession.session.loginSessionId)
          .first()
        assert.notEqual(newOwner.user_id, google.user_id)
        assert.notEqual(newOwner.user_id, github.user_id)
        assert.equal(await count('auth_user_email'), 1)
        // Use a different live owner for the same subject; only the mock issuer is consulted.
        await db
          .prepare("UPDATE auth_external_identity SET user_id=? WHERE id='live-identity'")
          .bind(github.user_id)
          .run()
        const g = await ready('google')
        await accepted(g)
        const s = await finish(g)
        assert.equal(
          (
            await db
              .prepare('SELECT user_id FROM auth_login_session WHERE id=?')
              .bind(s.session.loginSessionId)
              .first()
          ).user_id,
          google.user_id,
        )
      },
    )
    await suite.test(
      'UAS-11/40: initiator, one-use browser ticket, state, cookie, CSRF and provider binding reject substitutions',
      async () => {
        const t = await begin()
        assert.equal((await api(t.path + '/providers/google/start', {}, secret())).status, 401)
        assert.equal((await api(t.path + '/providers/github/start', {}, t.proof)).status, 400)
        assert.equal(
          (await api(t.path + '/providers/google/start', { subject: 'chosen' }, t.proof)).status,
          400,
        )
        const f = await start(t)
        assert.equal((await p.fetch(new Request(f.ticketUrl))).status, 401)
        assert.equal((await api(t.path + '/providers/google/start', {}, t.proof)).status, 409)
        assert.equal((await authorize(f, 'SUCCESS', 'unknown')).status, 400)
        assert.equal((await authorize(f, 'SUCCESS', undefined, { subject: 'chosen' })).status, 400)
        assert.equal((await authorize({ ...f, csrf: secret() })).status, 403)
        const crossOrigin = await p.fetch(
          new Request(origin + '/api/v2/auth/mock/google/authorize', {
            method: 'POST',
            headers: { Origin: 'https://evil.invalid', Cookie: f.cookie },
            body: '',
          }),
        )
        assert.equal(crossOrigin.status, 403)
        const response = await authorize(f)
        const full = { ...f, callbackUrl: response.headers.get('Location')! }
        assert.equal((await callback(full, '')).status, 401)
        assert.equal((await callback(full, f.cookie.split('=')[0] + '=' + secret())).status, 401)
        assert.equal(
          (await callback(full, f.cookie, full.callbackUrl.replace('/google/', '/github/'))).status,
          401,
        )
        const wrong = new URL(full.callbackUrl)
        wrong.searchParams.set('state', secret())
        assert.equal((await callback(full, f.cookie, wrong.toString())).status, 401)
        const another = await ready()
        const swapped = new URL(full.callbackUrl)
        swapped.searchParams.set('code', new URL(another.callbackUrl).searchParams.get('code')!)
        assert.equal((await callback(full, f.cookie, swapped.toString())).status, 401)
        await accepted(full)
        await finish(full)
      },
    )
    await suite.test(
      'UAS-40: cancel, provider failure, product cancellation and expired callbacks cannot authenticate',
      async () => {
        const before = await count('auth_user')
        for (const outcome of ['CANCEL', 'FAIL']) {
          const f = await start(await begin('github', true))
          const r = await authorize(f, outcome)
          const full = { ...f, callbackUrl: r.headers.get('Location')! }
          await accepted(full, await callback(full), outcome === 'CANCEL' ? 'CANCELLED' : 'FAILED')
          assert.equal((await api(f.path, undefined, f.proof)).data.status, 'CANCELLED')
          assert.equal((await api(f.path + '/complete', {}, f.proof)).status, 409)
          assert.equal((await callback(full)).status, 401)
        }
        const cancelled = await ready()
        assert.equal((await api(cancelled.path + '/cancel', {}, cancelled.proof)).status, 200)
        assert.equal((await callback(cancelled)).status, 401)
        const expired = await ready()
        await db
          .prepare('UPDATE auth_one_use SET expires_at=0 WHERE token_hash=?')
          .bind(hash(new URL(expired.callbackUrl).searchParams.get('code')!))
          .run()
        assert.equal((await callback(expired)).status, 401)
        const old = await ready()
        await db
          .prepare('UPDATE auth_product_transaction SET expires_at=created_at+1 WHERE id=?')
          .bind(old.id)
          .run()
        await new Promise((r) => setTimeout(r, 5))
        assert.equal((await callback(old)).status, 401)
        assert.equal(await count('auth_user'), before)
      },
    )
    await suite.test(
      'UAS-11/40: client, environment and configuration changes invalidate outstanding callbacks',
      async () => {
        for (const column of ['client_id', 'environment_id']) {
          const f = await ready()
          const replacement =
            column === 'client_id' ? 'molis-club-unified-local' : 'another-environment'
          if (column === 'environment_id') {
            await db
              .prepare(
                "INSERT INTO auth_environment SELECT 'another-environment',kind,auth_origin,delivery_mode,provider_mode,status,version,created_at,updated_at FROM auth_environment WHERE id='unified-local'",
              )
              .run()
            await db
              .prepare(
                "INSERT INTO auth_client SELECT 'another-client-id','another-client',application_id,client_type,status,version,scopes,redirects FROM auth_client WHERE client_id=?",
              )
              .bind(f.clientId)
              .run()
            await db
              .prepare(
                "INSERT INTO auth_client_policy SELECT 'another-client',policy_profile,'another-environment',allowed_origins,version,created_at,updated_at FROM auth_client_policy WHERE client_id=?",
              )
              .bind(f.clientId)
              .run()
            await db
              .prepare(
                "UPDATE auth_product_transaction SET client_id='another-client',environment_id='another-environment' WHERE id=?",
              )
              .bind(f.id)
              .run()
          } else {
            await db
              .prepare('UPDATE auth_product_transaction SET client_id=? WHERE id=?')
              .bind(replacement, f.id)
              .run()
          }
          assert.equal((await callback(f)).status, 403)
        }
        const version = await ready()
        await db
          .prepare('UPDATE auth_client_policy SET version=version+1 WHERE client_id=?')
          .bind(version.clientId)
          .run()
        assert.equal((await callback(version)).status, 403)
        const stopped = await ready()
        await db
          .prepare("UPDATE auth_client SET status='DISABLED' WHERE client_id=?")
          .bind(stopped.clientId)
          .run()
        assert.equal((await callback(stopped)).status, 403)
        await db
          .prepare("UPDATE auth_client SET status='ACTIVE' WHERE client_id=?")
          .bind(stopped.clientId)
          .run()
        const live = await begin()
        await db
          .prepare("UPDATE auth_environment SET provider_mode='LIVE' WHERE id='unified-local'")
          .run()
        assert.equal((await api(live.path + '/providers/google/start', {}, live.proof)).status, 403)
        await db
          .prepare("UPDATE auth_environment SET provider_mode='MOCK' WHERE id='unified-local'")
          .run()
      },
    )
    await suite.test(
      'UAS-40: Google nonce/issuer and both adapters audience/PKCE reject corrupted provider assertions',
      async () => {
        for (const [provider, field] of [
          ['google', 'nonce'],
          ['google', 'iss'],
          ['google', 'aud'],
          ['github', 'pkceChallenge'],
          ['github', 'environmentId'],
        ]) {
          const f = await ready(provider)
          const digest = hash(new URL(f.callbackUrl).searchParams.get('code')!)
          const row = await db
            .prepare('SELECT payload FROM auth_one_use WHERE token_hash=?')
            .bind(digest)
            .first()
          const claims = JSON.parse(await authOpen(encryptionKey, JSON.parse(row.payload)))
          claims[field] = secret()
          await db
            .prepare('UPDATE auth_one_use SET payload=? WHERE token_hash=?')
            .bind(JSON.stringify(await authSeal(encryptionKey, JSON.stringify(claims))), digest)
            .run()
          assert.equal((await callback(f)).status, 401)
          assert.equal((await api(f.path, undefined, f.proof)).data.status, 'PENDING')
        }
      },
    )
    await suite.test(
      'UAS-11: logout-all blocks late callback and verified completion; fresh login succeeds',
      async () => {
        const pending = await ready(),
          verified = await ready()
        await accepted(verified)
        assert.equal(
          (await api('/sessions/logout-all', {}, undefined, googleSession.accessToken)).status,
          200,
        )
        assert.equal((await callback(pending)).status, 409)
        assert.equal((await api(verified.path + '/complete', {}, verified.proof)).status, 409)
        const fresh = await ready()
        await accepted(fresh)
        await finish(fresh)
      },
    )
    await suite.test(
      'UAS-05/28: concurrent first login creates one identity and allows both independent sessions',
      async () => {
        await db
          .prepare(
            "INSERT INTO auth_mock_provider_account(id,environment_id,provider,subject,label) VALUES ('racing','unified-local','GITHUB','racing-subject','Race fixture')",
          )
          .run()
        const a = await ready('github', false, 'racing'),
          b = await ready('github', true, 'racing')
        const before = await count('auth_user')
        const results = await Promise.all([callback(a), callback(b)])
        await accepted(a, results[0])
        await accepted(b, results[1])
        const sa = await finish(a),
          sb = await finish(b)
        assert.notEqual(sa.session.loginSessionId, sb.session.loginSessionId)
        assert.equal(await count('auth_user'), before + 1)
        const owners = await db
          .prepare('SELECT DISTINCT user_id FROM auth_login_session WHERE id IN (?,?)')
          .bind(sa.session.loginSessionId, sb.session.loginSessionId)
          .all()
        assert.equal(owners.results.length, 1)
      },
    )
    await suite.test(
      'UAS-40: no credential or provider assertion is stored in audit events',
      async () => {
        const f = await ready()
        await accepted(f)
        const tokens = await finish(f)
        const events = JSON.stringify(
          (await db.prepare('SELECT * FROM auth_audit_event').all()).results,
        )
        for (const value of [
          encryptionKey,
          f.providerState,
          f.cookie.split('=')[1],
          tokens.accessToken,
          tokens.refreshToken,
          new URL(f.callbackUrl).searchParams.get('code')!,
        ])
          assert.ok(!events.includes(value))
      },
    )
  } finally {
    await p.dispose()
  }
})

test('UAS-40: matching LIVE configuration or missing mock key fails closed without mock fallback', async () => {
  const origin = 'http://127.0.0.1:8787'
  for (const providerMode of ['LIVE', 'MOCK']) {
    const p = await getRustProxy({
      AUTH_ORIGIN: origin,
      ...(providerMode === 'LIVE' ? { PROVIDER_STATE_KEY: secret() } : {}),
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
        environmentId: 'unified-local',
        kind: 'LOCAL',
        authOrigin: origin,
        deliveryMode: 'MOCK',
        providerMode,
      }),
    })
    try {
      await initializeLocalRuntime(p)
      for (const sql of readFileSync(
        new URL('../unified-account-local-seed.sql', import.meta.url),
        'utf8',
      )
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await p.env.DB.prepare(sql).run()
      await p.env.DB.prepare('UPDATE auth_environment SET provider_mode=?').bind(providerMode).run()
      const proof = secret()
      async function post(path: string, body: unknown) {
        return p.fetch(
          new Request(origin + '/api/v2/auth/' + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Initiator-Proof': proof },
            body: JSON.stringify(body),
          }),
        )
      }
      const created = await post('transactions', {
        clientId: 'molis-work-unified-local',
        purpose: 'LOGIN',
        method: 'GOOGLE',
        redirectUri: 'http://127.0.0.1:4207/account/callback',
        state: secret(),
        codeChallenge: challenge(secret()),
        codeChallengeMethod: 'S256',
        initiatorChallenge: challenge(proof),
      })
      assert.equal(created.status, 200)
      const { data } = await created.json()
      const result = await post(
        'transactions/' + data.transactionId + '/providers/google/start',
        {},
      )
      assert.equal(result.status, 503)
      assert.equal((await result.json()).error.code, 'UPSTREAM_UNAVAILABLE')
      assert.equal((await p.env.DB.prepare('SELECT count(*) n FROM auth_one_use').first()).n, 0)
      assert.equal((await p.env.DB.prepare('SELECT count(*) n FROM auth_user').first()).n, 0)
    } finally {
      await p.dispose()
    }
  }
})
