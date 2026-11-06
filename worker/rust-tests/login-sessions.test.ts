import test from 'node:test'
import { validateNamed } from '../../contracts/unified-account/validate.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, hash, challenge } from './fixtures.ts'

test('AUTH-03 independent sessions, bounded clocks, rotation, replay, revocation and pending-code boundary', async () => {
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
  const p = await getRustProxy({
    AUTH_ORIGIN: origin,
    UNIFIED_ACCOUNT_CONFIG: JSON.stringify(config),
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
    const call = async (path: string, body?: unknown, access?: string, key = secret()) => {
      const r = await p.fetch(
        new Request(origin + '/api/v2' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(access ? { Authorization: 'Bearer ' + access } : {}),
            'Idempotency-Key': key,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      return { status: r.status, ...(await r.json()) }
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
    const current = await call('/sessions/current', undefined, a.accessToken)
    assert.equal(current.status, 200)
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
    const active = await call('/sessions/current/activity', event, b.accessToken)
    assert.equal(active.status, 200)
    assert.equal(
      (await call('/sessions/current/activity', event, b.accessToken)).data.lastActiveAt,
      active.data.lastActiveAt,
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
    assert.equal((await call('/sessions/current', undefined, c.accessToken)).status, 401)
    const logout = await call('/sessions/current/logout', {
      refreshProof: { clientId: work, refreshToken: c.refreshToken },
    })
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
    assert.equal((await call('/sessions/current', undefined, other.accessToken)).status, 401)
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
    const cleanup = await p.scheduled()
    assert.equal(cleanup.outcome, 'ok')
    assert.ok(
      await db
        .prepare('SELECT token_hash FROM auth_login_access_token WHERE token_hash=?')
        .bind(hash(b.accessToken))
        .first(),
    )
    assert.equal((await call('/sessions/logout-all', {}, b.accessToken, key)).status, 200)
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
    assert.equal((await call('/sessions/current', undefined, disabled.accessToken)).status, 403)
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
  } finally {
    await p.dispose()
  }
})
