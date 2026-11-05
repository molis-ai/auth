import test from 'node:test'
import assert from 'node:assert/strict'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import {
  seedSynthetic,
  targets,
  origin,
  config,
  secret,
  challenge,
} from '../scripts/account-migration/synthetic.mjs'
import { inventory } from '../scripts/account-migration/inventory.mjs'
import { applyRehearsal, rollbackRehearsal } from '../scripts/account-migration/cutover.mjs'
import { all } from '../scripts/account-migration/common.mjs'

test('AUTH11-06 UAS-27/28/29/30: real Auth/D1 cutover, same account/password, mock phone creation and non-resurrecting rollback', async () => {
  const p = await getRustProxy({
    AUTH_ORIGIN: origin,
    UNIFIED_ACCOUNT_CONFIG: JSON.stringify(config),
    PROVIDER_STATE_KEY: secret(),
  })
  try {
    await initializeLocalRuntime(p)
    const db = p.env.DB,
      seed = await seedSynthetic(db)
    // An unrelated v2 client uses the same account, in addition to the shared v1 root.
    await db.batch([
      db.prepare(
        "INSERT INTO auth_client SELECT 'synthetic-other-v2','synthetic-other-v2','synthetic-products',client_type,'ACTIVE',0,scopes,redirects FROM auth_client WHERE client_id='molis-club-unified-local'",
      ),
      db.prepare(
        "INSERT INTO auth_client_policy SELECT 'synthetic-other-v2',policy_profile,environment_id,allowed_origins,0,created_at,updated_at FROM auth_client_policy WHERE client_id='molis-club-unified-local'",
      ),
      db.prepare("INSERT INTO auth_client_product VALUES ('synthetic-other-v2','CLUB',0)"),
    ])
    async function call(path: string, body?: unknown, proof?: string, access?: string) {
      const r = await p.fetch(
        new Request(origin + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type':
              path === '/oauth2/token' ? 'application/x-www-form-urlencoded' : 'application/json',
            'Idempotency-Key': secret(),
            ...(proof ? { 'X-Auth-Initiator-Proof': proof } : {}),
            ...(access ? { Authorization: 'Bearer ' + access } : {}),
          },
          ...(body === undefined
            ? {}
            : {
                body:
                  path === '/oauth2/token'
                    ? new URLSearchParams(body as Record<string, string>).toString()
                    : JSON.stringify(body),
              }),
        }),
      )
      return { status: r.status, ...(await r.json()) }
    }
    async function begin(clientId: string, method = 'EMAIL_PASSWORD') {
      const proof = secret(),
        verifier = secret(),
        redirectUri =
          'http://127.0.0.1:' +
          (clientId === targets[0].newClientId ? '4207' : '3000') +
          '/account/callback'
      const r = await call('/api/v2/auth/transactions', {
        clientId,
        purpose: 'LOGIN',
        method,
        redirectUri,
        state: secret(),
        codeChallenge: challenge(verifier),
        codeChallengeMethod: 'S256',
        initiatorChallenge: challenge(proof),
      })
      assert.equal(r.status, 200, r.error?.code)
      return {
        clientId,
        proof,
        verifier,
        redirectUri,
        path: '/api/v2/auth/transactions/' + r.data.transactionId,
        id: r.data.transactionId,
      }
    }
    const finish = async (t: Awaited<ReturnType<typeof begin>>) => {
      const r = await call(t.path + '/complete', {}, t.proof)
      assert.equal(r.status, 200, r.error?.code)
      return {
        grantType: 'authorization_code',
        clientId: t.clientId,
        code: r.data.code,
        redirectUri: t.redirectUri,
        codeVerifier: t.verifier,
      }
    }
    const exchange = async (b: unknown) => {
      const r = await call('/api/v2/auth/token', b)
      assert.equal(r.status, 200, r.error?.code)
      return r.data
    }
    async function passwordLogin(clientId: string) {
      const t = await begin(clientId)
      const r = await call(
        t.path + '/password',
        { email: 'verified@example.test', password: seed.password },
        t.proof,
      )
      assert.equal(r.status, 200, r.error?.code)
      return exchange(await finish(t))
    }
    const unrelated = await passwordLogin('synthetic-other-v2')
    for (const client of [...targets.map((t) => t.legacyClientId), 'synthetic-other-product'])
      assert.equal(
        (await call('/api/v1/users/me', undefined, undefined, seed.accesses[client])).status,
        200,
      )
    const before = await Promise.all(
      [
        'auth_user',
        'auth_user_email',
        'auth_local_credential',
        'auth_external_identity',
        'auth_space',
        'auth_membership',
      ].map((t) => all(db, 'SELECT * FROM ' + t + ' ORDER BY 1')),
    )
    const plan = {
      formatVersion: 1,
      environment: 'SYNTHETIC_ONLY',
      runId: crypto.randomUUID(),
      inventoryDigest: (await inventory(db, 'AUTH')).sourceDigest,
      targets,
      review: { reviewedBy: 'synthetic-operator', evidenceReference: 'runtime-fixture' },
    }
    const applied = await applyRehearsal(db, plan)
    assert.deepEqual(await applyRehearsal(db, plan), applied)
    assert.equal(
      (
        await call(
          '/api/v1/users/me',
          undefined,
          undefined,
          seed.accesses['synthetic-other-product'],
        )
      ).status,
      200,
    )
    assert.equal(
      (await call('/api/v2/users/me', undefined, undefined, unrelated.accessToken)).status,
      200,
    )
    for (const target of targets)
      assert.equal(
        (await call('/api/v1/users/me', undefined, undefined, seed.accesses[target.legacyClientId]))
          .status,
        401,
      )
    const work = await passwordLogin(targets[0].newClientId),
      club = await passwordLogin(targets[1].newClientId)
    for (const tokens of [work, club])
      assert.equal(
        (await call('/api/v2/users/me', undefined, undefined, tokens.accessToken)).data.user.userId,
        'verified',
      )
    const unverified = await begin(targets[0].newClientId)
    assert.equal(
      (
        await call(
          unverified.path + '/password',
          { email: 'unverified@example.test', password: seed.password },
          unverified.proof,
        )
      ).status,
      401,
    )
    assert.deepEqual(
      await Promise.all(
        [
          'auth_user',
          'auth_user_email',
          'auth_local_credential',
          'auth_external_identity',
          'auth_space',
          'auth_membership',
        ].map((t) => all(db, 'SELECT * FROM ' + t + ' ORDER BY 1')),
      ),
      before,
    )
    const pending = await begin(targets[0].newClientId)
    assert.equal(
      (
        await call(
          pending.path + '/password',
          { email: 'verified@example.test', password: seed.password },
          pending.proof,
        )
      ).status,
      200,
    )
    const lateCode = await finish(pending)
    const phone = await begin(targets[1].newClientId, 'PHONE_OTP'),
      sent = await call(
        phone.path + '/challenges',
        { channel: 'SMS', address: '+8613800001101' },
        phone.proof,
      )
    assert.equal(sent.status, 200)
    const delivery = await db
      .prepare(
        'SELECT m.credential FROM auth_mock_delivery m JOIN auth_verification_challenge c ON c.delivery_id=m.delivery_id WHERE c.id=?',
      )
      .bind(sent.data.challengeId)
      .first()
    const verified = await call(
      phone.path + '/challenges/' + sent.data.challengeId + '/verify',
      { credential: delivery.credential },
      phone.proof,
    )
    assert.equal(verified.status, 200)
    assert.equal(
      (
        await call(
          phone.path + '/phone',
          { verificationProof: verified.data.verificationProof },
          phone.proof,
        )
      ).status,
      200,
    )
    const phoneTokens = await exchange(await finish(phone))
    const phoneUser = (
      await call('/api/v2/users/me', undefined, undefined, phoneTokens.accessToken)
    ).data.user.userId
    const rollback = await rollbackRehearsal(db, plan)
    assert.deepEqual(await rollbackRehearsal(db, plan), rollback)
    assert.equal((await db.prepare('SELECT count(*) n FROM auth_user').first()).n, 4)
    assert.ok(await db.prepare('SELECT id FROM auth_user WHERE id=?').bind(phoneUser).first())
    assert.equal(
      (
        await db
          .prepare('SELECT count(*) n FROM auth_user_email WHERE user_id=?')
          .bind(phoneUser)
          .first()
      ).n,
      0,
    )
    assert.equal((await db.prepare('SELECT count(*) n FROM auth_managed_tenant').first()).n, 0)
    assert.equal(
      (
        await db
          .prepare("SELECT revoked_at FROM auth_authentication WHERE id='shared-root'")
          .first()
      ).revoked_at,
      null,
    )
    assert.equal(
      (
        await call(
          '/api/v1/users/me',
          undefined,
          undefined,
          seed.accesses['synthetic-other-product'],
        )
      ).status,
      200,
    )
    assert.equal(
      (await call('/api/v2/users/me', undefined, undefined, unrelated.accessToken)).status,
      200,
    )
    for (const target of targets) {
      assert.equal(
        (await call('/api/v1/users/me', undefined, undefined, seed.accesses[target.legacyClientId]))
          .status,
        401,
      )
      assert.equal(
        (
          await call('/oauth2/token', {
            grant_type: 'refresh_token',
            client_id: target.legacyClientId,
            refresh_token: seed.refreshes[target.legacyClientId],
          })
        ).status,
        400,
      )
      assert.equal(
        (
          await call('/oauth2/token', {
            grant_type: 'authorization_code',
            client_id: target.legacyClientId,
            code: seed.codes[target.legacyClientId],
            code_verifier: seed.verifiers[target.legacyClientId],
            redirect_uri: origin + '/old/callback',
          })
        ).status,
        400,
      )
    }
    // Re-enabling after a new review still cannot resurrect tokens or a delayed authorization code.
    await applyRehearsal(db, {
      ...plan,
      runId: crypto.randomUUID(),
      inventoryDigest: (await inventory(db, 'AUTH')).sourceDigest,
    })
    for (const tokens of [work, club, phoneTokens])
      assert.equal(
        (await call('/api/v2/users/me', undefined, undefined, tokens.accessToken)).status,
        401,
      )
    assert.equal((await call('/api/v2/auth/token', lateCode)).status, 401)
    assert.equal(
      (await call('/api/v2/users/me', undefined, undefined, unrelated.accessToken)).status,
      200,
    )
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, [])
  } finally {
    await p.dispose()
  }
})
