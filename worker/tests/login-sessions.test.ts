import test from 'node:test'
import { validateNamed } from '../../contracts/unified-account/validate.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { importJWK, jwtVerify, type JWK } from 'jose'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { captureAuthLogs, secret, hash, challenge } from './fixtures.ts'

test('AUTH-03 independent sessions, bounded clocks, rotation, replay, revocation and pending-code boundary', async (suite) => {
  const origin = 'http://127.0.0.1:8787',
    work = 'molis-work-unified-local',
    club = 'molis-club-unified-local'
  const config = {
    environmentId: 'unified-local',
    kind: 'LOCAL',
    authOrigin: origin,
    deliveryMode: 'MOCK',
    providerMode: 'MOCK',
  }
  const signingKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  const logs = captureAuthLogs()
  const credentialRead = Promise.withResolvers<void>()
  const resumeActivity = Promise.withResolvers<void>()
  const activityBarrier = 'activity-credential-after/' + crypto.randomUUID()
  const p = await getRustProxy(
    {
      AUTH_ORIGIN: origin,
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify(config),
      SYNC_READ_SIGNING_JWK: JSON.stringify({ ...signingKey, kid: 'synthetic-sync' }),
    },
    async (request) => {
      assert.equal(new URL(request.url).pathname, '/' + activityBarrier)
      credentialRead.resolve()
      await resumeActivity.promise
      return new Response('continue')
    },
    undefined,
    {
      ...logs,
      fixtureEntrypoint: readFileSync(
        new URL('./fixtures/d1-request-barrier.mjs', import.meta.url),
        'utf8',
      ),
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
      .map((x) => x.trim())
      .filter(Boolean))
      await db.prepare(sql).run()
    const n = Date.now()
    await db
      .prepare("INSERT INTO auth_user VALUES ('user','User','ACTIVE',NULL,?,?)")
      .bind(n, n)
      .run()
    await db
      .prepare("INSERT INTO auth_user_security(user_id,updated_at) VALUES ('user',?)")
      .bind(n)
      .run()
    const call = async (
      path: string,
      body?: unknown,
      access?: string,
      key = secret(),
      requestOrigin?: string,
      fixture?: { trace: boolean; barrier?: string },
    ) => {
      const r = await p.fetch(
        new Request(origin + '/api/v2' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(access ? { Authorization: 'Bearer ' + access } : {}),
            ...(requestOrigin ? { Origin: requestOrigin } : {}),
            ...(fixture?.trace
              ? { 'X-Fixture-Barrier': fixture.barrier ?? 'd1-trace', 'X-Fixture-D1-Trace': '1' }
              : {}),
            'Idempotency-Key': key,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const d1Calls = r.headers.get('X-Fixture-D1-Calls')
      return {
        status: r.status,
        ...(await r.json()),
        ...(d1Calls && { d1Calls: JSON.parse(d1Calls) }),
      }
    }
    // Trusted verification output fixture only. No public endpoint accepts a claimed user.
    async function code(client = work) {
      const id = crypto.randomUUID(),
        code = secret(),
        verifier = secret(),
        now = Date.now()
      await db
        .prepare("INSERT INTO auth_security_sequence(kind,created_at) VALUES ('TRANSACTION',?)")
        .bind(now)
        .run()
      const seq = (await db.prepare('SELECT max(seq) n FROM auth_security_sequence').first()).n
      const epoch = (
        await db
          .prepare("SELECT session_epoch FROM auth_user_security WHERE user_id='user'")
          .first()
      ).session_epoch
      const redirect =
        client === work
          ? 'http://127.0.0.1:4207/account/callback'
          : 'http://127.0.0.1:3000/account/callback'
      await db
        .prepare(
          "INSERT INTO auth_product_transaction(id,client_id,environment_id,purpose,method,status,initiator_hash,redirect_uri,product_state,product_state_hash,pkce_challenge,user_id,created_seq,created_at,expires_at) VALUES (?,?,'unified-local','LOGIN','EMAIL_PASSWORD','CONSUMED','fixture',?,'fixture','fixture',?,'user',?,?,?)",
        )
        .bind(id, client, redirect, challenge(verifier), seq, now, now + 600000)
        .run()
      await db
        .prepare(
          "INSERT INTO auth_identity_proof(token_hash,transaction_id,kind,binding_hash,user_id,user_epoch,created_at,expires_at) VALUES (?,?,'LOGIN_CODE','fixture','user',?,?,?)",
        )
        .bind(hash(code), id, epoch, now, now + 60000)
        .run()
      return {
        grantType: 'authorization_code',
        clientId: client,
        code,
        redirectUri: redirect,
        codeVerifier: verifier,
      }
    }
    async function login(client = work) {
      const b = await code(client)
      const r = await call('/auth/token', b)
      assert.equal(r.status, 200, JSON.stringify(r))
      assert.ok(validateNamed('TokenSet', r.data))
      return r.data
    }
    const a = await login(),
      b = await login(club),
      c = await login()
    assert.notEqual(a.session.loginSessionId, c.session.loginSessionId)
    assert.equal(
      Date.parse(a.session.absoluteExpiresAt) - Date.parse(a.session.authenticatedAt),
      90 * 86400000,
    )
    const current = await call(
      '/sessions/current',
      undefined,
      a.accessToken,
      undefined,
      undefined,
      {
        trace: true,
      },
    )
    assert.equal(current.status, 200)
    assert.deepEqual(current.data, a.session)
    assert.deepEqual(current.d1Calls, { read: 1, write: 0 })
    const accountReads = ['/sessions/current', '/users/me', '/users/me/login-methods']
    await suite.test('credential joins preserve lookup and policy error codes', async () => {
      for (const path of accountReads) {
        const unknown = await call(path, undefined, secret())
        assert.equal(unknown.status, 401)
        assert.equal(unknown.error.code, 'INVALID_CREDENTIALS')
        const denied = await call(
          path,
          undefined,
          a.accessToken,
          undefined,
          'https://blocked.example.test',
        )
        assert.equal(denied.status, 403)
        assert.equal(denied.error.code, 'FORBIDDEN')
      }
    })
    // PCSYNC-OPT-01: use an actual live Auth session; publish only the public key.
    const signed = await call('/auth/sync-read-proof', undefined, a.accessToken)
    assert.equal(signed.status, 200)
    const jwksReply = await p.fetch(new Request(origin + '/.well-known/molis-sync-jwks.json'))
    assert.equal(jwksReply.status, 200)
    const { keys } = (await jwksReply.json()) as { keys: JWK[] }
    assert.equal(keys[0].kid, 'synthetic-sync')
    assert.equal(keys[0].d, undefined)
    const claims = (
      await jwtVerify(signed.data.proof, await importJWK(keys[0], 'EdDSA'), {
        issuer: origin,
        audience: a.session.applicationId,
        algorithms: ['EdDSA'],
        typ: 'molis-sync-read+jwt',
      })
    ).payload
    assert.equal(claims.token_sha256, hash(a.accessToken))
    assert.equal(claims.scope, 'molis-sync:read')
    assert.ok(Number(claims.exp) - Number(claims.iat) <= 30)
    // AC-AUTH-01/03: proof and JWKS endpoints use route templates and omit key and grant data.
    for (const route of ['/api/v2/auth/sync-read-proof', '/.well-known/molis-sync-jwks.json']) {
      const log = await logs.waitFor(
        (event) => event.event === 'auth.http.request' && event.route === route,
      )
      assert.equal(log.status, 200)
      assert.equal(log.error_code, 'none')
    }
    for (const value of [
      a.accessToken,
      a.refreshToken,
      signed.data.proof,
      signingKey.d!,
      JSON.stringify(claims.sub),
    ])
      assert.ok(logs.lines.every((line) => !line.includes(value)))
    const before = current.data.lastActiveAt
    const refreshed = await call('/auth/token', {
      grantType: 'refresh_token',
      clientId: work,
      refreshToken: a.refreshToken,
    })
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.data.session.lastActiveAt, before)
    assert.equal(refreshed.data.session.authenticatedAt, a.session.authenticatedAt)
    assert.equal(
      (
        await call('/auth/token', {
          grantType: 'refresh_token',
          clientId: club,
          refreshToken: refreshed.data.refreshToken,
        })
      ).status,
      401,
    )
    const replay = await call('/auth/token', {
      grantType: 'refresh_token',
      clientId: work,
      refreshToken: a.refreshToken,
    })
    assert.equal(replay.status, 401)
    assert.equal(
      (await call('/sessions/current', undefined, refreshed.data.accessToken)).status,
      401,
    )
    assert.equal((await call('/sessions/current', undefined, b.accessToken)).status, 200)
    const event = { eventId: 'event-one', kind: 'INTERACT' }
    const activity = (body: typeof event, barrier?: string) =>
      call('/sessions/current/activity', body, b.accessToken, undefined, undefined, {
        trace: true,
        barrier,
      })
    await suite.test(
      'activity returns the latest guarded value on a concurrent replay',
      async () => {
        const active = await activity(event)
        assert.equal(active.status, 200)
        assert.deepEqual(active.d1Calls, { read: 1, write: 1 })
        const replay = await activity(event)
        assert.equal(replay.status, 200)
        assert.equal(replay.data.lastActiveAt, active.data.lastActiveAt)
        assert.deepEqual(replay.d1Calls, { read: 1, write: 1 })

        const pending = activity(event, activityBarrier)
        try {
          await Promise.race([
            credentialRead.promise,
            pending.then((r) =>
              assert.fail(`Missing activity credential barrier: ${JSON.stringify(r)}`),
            ),
          ])
          const later = Date.parse(active.data.lastActiveAt) + 120_000
          await db
            .prepare('UPDATE auth_login_session SET last_active_at=? WHERE id=?')
            .bind(later, b.session.loginSessionId)
            .run()
          const committed = await activity({ ...event, eventId: 'event-two' })
          assert.equal(committed.status, 200)
          assert.equal(committed.data.lastActiveAt, new Date(later).toISOString())
          assert.deepEqual(committed.d1Calls, { read: 1, write: 1 })
          resumeActivity.resolve()
          const duplicate = await pending
          assert.equal(duplicate.status, 200)
          assert.deepEqual(duplicate.data, committed.data)
          assert.deepEqual(duplicate.d1Calls, { read: 1, write: 1 })
          const receipts = await db
            .prepare(
              'SELECT event_id,received_at FROM auth_login_activity WHERE login_session_id=? ORDER BY event_id',
            )
            .bind(b.session.loginSessionId)
            .all()
          assert.deepEqual(
            receipts.results.map((r) => r.event_id),
            ['event-one', 'event-two'],
          )
          assert.equal(receipts.results[0].received_at, Date.parse(active.data.lastActiveAt))
        } finally {
          resumeActivity.resolve()
          await pending
        }
      },
    )
    assert.equal(
      (await call('/sessions/current/activity', { ...event, timestamp: n }, b.accessToken)).status,
      400,
    )
    assert.equal(
      (
        await call(
          '/sessions/current/activity',
          { eventId: 'background', kind: 'REFRESH' },
          b.accessToken,
        )
      ).status,
      400,
    )
    // Expired access can revoke with an unconsumed refresh, but cannot authenticate.
    await db
      .prepare('UPDATE auth_login_access_token SET expires_at=0 WHERE token_hash=?')
      .bind(hash(c.accessToken))
      .run()
    for (const path of accountReads) {
      const expired = await call(path, undefined, c.accessToken)
      assert.equal(expired.status, 401)
      assert.equal(expired.error.code, 'SESSION_EXPIRED')
    }
    const refreshLogoutKey = secret()
    const refreshProof = { refreshProof: { clientId: work, refreshToken: c.refreshToken } }
    const logout = await call('/sessions/current/logout', refreshProof, undefined, refreshLogoutKey)
    assert.equal(logout.status, 200)
    assert.equal((await call('/sessions/current', undefined, b.accessToken)).status, 200)
    assert.equal(
      (
        await call('/sessions/current/logout', {
          refreshProof: { clientId: work, refreshToken: c.refreshToken },
        })
      ).data.status,
      'ALREADY_ENDED',
    )
    const pending = await code(),
      other = await login()
    const key = secret()
    const all = await call('/sessions/logout-all', {}, b.accessToken, key)
    assert.equal(all.status, 200, JSON.stringify(all))
    assert.equal((await call('/sessions/logout-all', {}, b.accessToken, key)).status, 200)
    assert.equal((await call('/sessions/logout-all', {}, b.accessToken)).status, 401)
    assert.equal((await call('/auth/sync-read-proof', undefined, b.accessToken)).status, 401)
    for (const path of accountReads) {
      const revoked = await call(path, undefined, other.accessToken)
      assert.equal(revoked.status, 401)
      assert.equal(revoked.error.code, 'SESSION_EXPIRED')
    }
    const revokedActivity = await activity({ ...event, eventId: 'after-revocation' })
    assert.equal(revokedActivity.status, 401)
    assert.equal(revokedActivity.error.code, 'SESSION_EXPIRED')
    assert.deepEqual(revokedActivity.d1Calls, { read: 1, write: 0 })
    assert.equal((await call('/auth/token', pending)).status, 409)
    // Even if future verification stamps a fresh epoch, an old anonymous transaction is blocked by sequence.
    await db
      .prepare(
        "UPDATE auth_identity_proof SET user_epoch=(SELECT session_epoch FROM auth_user_security WHERE user_id='user') WHERE token_hash=?",
      )
      .bind(hash(pending.code))
      .run()
    assert.equal((await call('/auth/token', pending)).status, 409)
    await db
      .prepare('UPDATE auth_login_access_token SET expires_at=0 WHERE token_hash=?')
      .bind(hash(b.accessToken))
      .run()
    const countAccessTokens = () =>
      db.prepare('SELECT count(*) AS n FROM auth_login_access_token').first<number>('n')
    const accessTokensBeforeCleanup = await countAccessTokens()
    const cleanup = await p.scheduled()
    assert.equal(cleanup.outcome, 'ok')
    // AC-AUTH-02/03: cron records an independent correlation ID and aggregate counts.
    const summary = await logs.waitFor((record) => record.event === 'auth.cleanup')
    assert.equal(summary.schema, 1)
    assert.equal(summary.service, 'molis-auth')
    assert.equal(summary.env, 'unknown')
    assert.match(summary.request_id, /^[0-9a-f-]{36}$/)
    assert.ok(Number.isInteger(summary.duration_ms) && summary.duration_ms >= 0)
    assert.equal(summary.rounds, 1)
    assert.equal(summary.stop_reason, 'drained')
    assert.equal(
      summary.deleted?.auth_login_access_token,
      accessTokensBeforeCleanup! - (await countAccessTokens())!,
    )
    assert.equal(JSON.stringify(summary).includes(hash(b.accessToken)), false)
    assert.ok(
      await db
        .prepare('SELECT token_hash FROM auth_login_access_token WHERE token_hash=?')
        .bind(hash(b.accessToken))
        .first(),
    )
    assert.equal((await call('/sessions/logout-all', {}, b.accessToken, key)).status, 200)
    await suite.test(
      'cleanup catches up in rounds and respects proofs, grace and replays',
      async () => {
        await db
          .prepare('UPDATE auth_login_refresh_token SET expires_at=created_at+1 WHERE token_hash=?')
          .bind(hash(c.refreshToken))
          .run()
        await db
          .prepare(
            "WITH RECURSIVE numbers(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM numbers WHERE n<501) INSERT INTO auth_one_use SELECT 'cleanup-'||n,'fixture','fixture','{}',0 FROM numbers",
          )
          .run()
        const old = await code()
        const grace = await code()
        const ids = await Promise.all(
          [old, grace].map(
            async ({ code }) =>
              (
                await db
                  .prepare('SELECT transaction_id FROM auth_identity_proof WHERE token_hash=?')
                  .bind(hash(code))
                  .first()
              ).transaction_id,
          ),
        )
        const [oldId, graceId] = ids
        await db
          .prepare('UPDATE auth_product_transaction SET created_at=0,expires_at=1 WHERE id=?')
          .bind(oldId)
          .run()
        await db
          .prepare('UPDATE auth_product_transaction SET created_at=0,expires_at=? WHERE id=?')
          .bind(Date.now() - 3_600_000, graceId)
          .run()
        await db
          .prepare('DELETE FROM auth_identity_proof WHERE transaction_id=?')
          .bind(graceId)
          .run()
        await db
          .prepare(
            "INSERT INTO auth_verification_challenge (id,transaction_id,channel,canonical_target,credential_hash,delivery_id,delivery_status,max_attempts,created_at,expires_at,next_send_at) VALUES ('cleanup',?,'EMAIL','fixture','fixture','cleanup','ACCEPTED',5,0,?,0)",
          )
          .bind(oldId, Date.now() + 60_000)
          .run()
        const backlog = async () =>
          (
            await db
              .prepare("SELECT COUNT(*) n FROM auth_one_use WHERE token_hash LIKE 'cleanup-%'")
              .first()
          ).n
        const exists = async (table: string, column: string, id: unknown) =>
          Boolean(await db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).bind(id).first())
        const plan = (
          await db
            .prepare(
              'EXPLAIN QUERY PLAN SELECT 1 FROM auth_logout_receipt WHERE proof_hash=? AND expires_at>?',
            )
            .bind(hash(c.refreshToken), Date.now())
            .all()
        ).results
          .map(({ detail }) => detail)
          .join('\n')
        assert.match(plan, /USING COVERING INDEX ix_logout_receipt_proof_expiry/)
        assert.equal((await p.scheduled()).outcome, 'ok')
        assert.equal(await backlog(), 51)
        assert.equal(await exists('auth_product_transaction', 'id', oldId), true)
        assert.equal(await exists('auth_verification_challenge', 'id', 'cleanup'), true)
        assert.equal(
          (await call('/sessions/current/logout', refreshProof, undefined, refreshLogoutKey))
            .status,
          200,
        )
        assert.equal((await call('/sessions/logout-all', {}, b.accessToken, key)).status, 200)

        await db
          .prepare("UPDATE auth_verification_challenge SET expires_at=1 WHERE id='cleanup'")
          .run()
        assert.equal((await p.scheduled()).outcome, 'ok')
        assert.equal(await backlog(), 0)
        assert.equal(await exists('auth_verification_challenge', 'id', 'cleanup'), false)
        assert.equal(await exists('auth_product_transaction', 'id', oldId), true)
        await db
          .prepare(
            'UPDATE auth_identity_proof SET created_at=0,expires_at=1 WHERE transaction_id=?',
          )
          .bind(oldId)
          .run()
        assert.equal((await p.scheduled()).outcome, 'ok')
        assert.equal(await exists('auth_product_transaction', 'id', oldId), false)
        assert.equal(await exists('auth_product_transaction', 'id', graceId), true)
        assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, [])
      },
    )
    const fresh = await login()
    assert.equal((await call('/sessions/current', undefined, fresh.accessToken)).status, 200)
    const oneUse = await code()
    assert.equal((await call('/auth/token', { ...oneUse, codeVerifier: secret() })).status, 401)
    assert.equal((await call('/auth/token', oneUse)).status, 200)
    assert.equal((await call('/auth/token', oneUse)).status, 401)
    const concurrent = await login()
    const rotated = await Promise.all(
      [1, 2].map(() =>
        call('/auth/token', {
          grantType: 'refresh_token',
          clientId: work,
          refreshToken: concurrent.refreshToken,
        }),
      ),
    )
    assert.equal(rotated.filter((r) => r.status === 200).length, 1)
    assert.equal(
      (
        await call(
          '/sessions/current',
          undefined,
          rotated.find((r) => r.status === 200).data.accessToken,
        )
      ).status,
      401,
    )
    const deniedCode = await code()
    const wrongOrigin = await p.fetch(
      new Request(origin + '/api/v2/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.test' },
        body: JSON.stringify(deniedCode),
      }),
    )
    assert.equal(wrongOrigin.status, 403)
    assert.equal((await call('/auth/token', deniedCode)).status, 200)
    const expiredCode = await code()
    await db
      .prepare('UPDATE auth_identity_proof SET expires_at=created_at+1 WHERE token_hash=?')
      .bind(hash(expiredCode.code))
      .run()
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await call('/auth/token', expiredCode)).status, 401)
    const unauthorizedAll = await call('/sessions/logout-all', {
      refreshProof: { clientId: work, refreshToken: secret() },
    })
    assert.equal(unauthorizedAll.status, 401)
    const disabled = await login(club)
    await db
      .prepare("UPDATE auth_client SET status='DISABLED',version=version+1 WHERE client_id=?")
      .bind(club)
      .run()
    for (const path of accountReads) {
      const denied = await call(path, undefined, disabled.accessToken)
      assert.equal(denied.status, 403)
      assert.equal(denied.error.code, 'POLICY_MISMATCH')
    }
    const disabledRefresh = await call('/sessions/current/logout', {
      refreshProof: { clientId: club, refreshToken: disabled.refreshToken },
    })
    assert.equal(disabledRefresh.status, 403)
    assert.equal(disabledRefresh.error.code, 'POLICY_MISMATCH')
    const wrongClient = await call('/sessions/current/logout', {
      refreshProof: { clientId: work, refreshToken: disabled.refreshToken },
    })
    assert.equal(wrongClient.status, 401)
    assert.equal(wrongClient.error.code, 'INVALID_CREDENTIALS')
    await db
      .prepare("UPDATE auth_client SET status='ACTIVE',version=version+1 WHERE client_id=?")
      .bind(club)
      .run()
    const racing = await login()
    const race = await Promise.all([
      call('/auth/token', {
        grantType: 'refresh_token',
        clientId: work,
        refreshToken: racing.refreshToken,
      }),
      call('/sessions/current/logout', {}, racing.accessToken),
    ])
    assert.equal(race[1].status, 200)
    if (race[0].status === 200)
      assert.equal(
        (await call('/sessions/current', undefined, race[0].data.accessToken)).status,
        401,
      )
    assert.equal((await call('/sessions/current', undefined, racing.accessToken)).status, 401)
    const idle = await login()
    await db
      .prepare(
        'UPDATE auth_login_session SET authenticated_at=?,last_active_at=?,absolute_expires_at=? WHERE id=?',
      )
      .bind(n - 31 * 86400000, n - 31 * 86400000, n + 59 * 86400000, idle.session.loginSessionId)
      .run()
    for (const path of accountReads) {
      const expired = await call(path, undefined, idle.accessToken)
      assert.equal(expired.status, 401)
      assert.equal(expired.error.code, 'SESSION_EXPIRED')
    }
    assert.equal(
      (
        await call('/auth/token', {
          grantType: 'refresh_token',
          clientId: work,
          refreshToken: idle.refreshToken,
        })
      ).status,
      401,
    )
    const expired = await login()
    await db
      .prepare(
        'UPDATE auth_login_session SET authenticated_at=?,last_active_at=?,absolute_expires_at=? WHERE id=?',
      )
      .bind(n - 91 * 86400000, n - 2 * 86400000, n - 86400000, expired.session.loginSessionId)
      .run()
    assert.equal((await call('/sessions/current', undefined, expired.accessToken)).status, 401)
    assert.equal((await call('/sessions/current', undefined, fresh.accessToken)).status, 200)

    await suite.test('revalidates configuration and signs with the current binding', async () => {
      const currentSession = () => call('/sessions/current', undefined, fresh.accessToken)
      await p.updateBindings({ AUTH_ORIGIN: 'http://127.0.0.1:8788' })
      const wrongOrigin = await currentSession()
      assert.equal(wrongOrigin.status, 503)
      assert.equal(wrongOrigin.error.code, 'UNIFIED_CONFIGURATION_INVALID')

      await p.updateBindings({ AUTH_ORIGIN: origin, UNIFIED_ACCOUNT_CONFIG: '{' })
      const malformed = await currentSession()
      assert.equal(malformed.status, 503)
      assert.equal(malformed.error.code, 'UNIFIED_CONFIGURATION_INVALID')

      await p.updateBindings({
        UNIFIED_ACCOUNT_CONFIG: JSON.stringify({ ...config, environmentId: 'unified-other' }),
      })
      const changedEnvironment = await currentSession()
      assert.equal(changedEnvironment.status, 403)
      assert.equal(changedEnvironment.error.code, 'POLICY_MISMATCH')

      const rotatedKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
      await p.updateBindings({
        UNIFIED_ACCOUNT_CONFIG: JSON.stringify(config, null, 2),
        SYNC_READ_SIGNING_JWK: JSON.stringify({ ...rotatedKey, kid: 'synthetic-sync' }),
      })
      assert.equal((await currentSession()).status, 200)
      const newJwksReply = await p.fetch(new Request(origin + '/.well-known/molis-sync-jwks.json'))
      assert.equal(newJwksReply.status, 200)
      const { keys: rotatedKeys } = (await newJwksReply.json()) as { keys: JWK[] }
      assert.equal(rotatedKeys[0].kid, 'synthetic-sync')
      assert.equal(rotatedKeys[0].x, rotatedKey.x)
      assert.equal(rotatedKeys[0].d, undefined)
      const oldPublic = await importJWK(keys[0], 'EdDSA')
      const newPublic = await importJWK(rotatedKeys[0], 'EdDSA')
      for (let attempt = 0; attempt < 2; attempt++) {
        const proof = await call('/auth/sync-read-proof', undefined, fresh.accessToken)
        assert.equal(proof.status, 200)
        await assert.rejects(jwtVerify(proof.data.proof, oldPublic, { algorithms: ['EdDSA'] }))
        const verified = await jwtVerify(proof.data.proof, newPublic, { algorithms: ['EdDSA'] })
        assert.equal(verified.payload.token_sha256, hash(fresh.accessToken))
      }
    })
  } finally {
    await p.dispose()
  }
})
