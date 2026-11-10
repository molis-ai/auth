import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge, hash } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

test('AUTH-SESSION active session authorization and operation proof isolation', async (suite) => {
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
    const a = await phoneLogin('+8613800000991');
    const b = await phoneLogin('+8613800000992');
    const fresh = await db.prepare('SELECT identity_verified_at t FROM auth_login_session WHERE id=?').bind(a.session.loginSessionId).first();
    const options = {operation:'BIND_METHOD',target:{method:'PHONE'},useSession:true};
    const recent = await begin('REAUTH','EMAIL_PASSWORD',a,options);
    const ready = ok(await call(recent.path,undefined,a,recent.proof));
    assert.equal(ready.status,'VERIFIED');
    const proof = await complete(recent);
    assert.equal(proof.kind,'OPERATION_PROOF');
    assert.ok(Date.parse(proof.expiresAt)>Date.now());
    assert.equal((await db.prepare('SELECT identity_verified_at t FROM auth_login_session WHERE id=?').bind(a.session.loginSessionId).first()).t,fresh.t);
    const bView=await me(b);
    assert.equal((await call('/users/me/password/change',{operationProof:proof.operationProof,newPassword:'Synthetic-Recent-Jupiter-94',expectedVersion:bView.user.version},b)).status,401);
    const aView=await me(a);
    assert.equal((await call('/users/me/password/change',{operationProof:proof.operationProof,newPassword:'Synthetic-Recent-Jupiter-94',expectedVersion:aView.user.version},a)).status,403);
    const expiresDuring = await begin('REAUTH','EMAIL_PASSWORD',a,options);
    await db.prepare('UPDATE auth_login_session SET identity_verified_at=? WHERE id=?').bind(Date.now()-300001,a.session.loginSessionId).run();
    assert.equal((await call(expiresDuring.path+'/complete',{},a,expiresDuring.proof)).status,200);
    const expired = await begin('REAUTH','PHONE_OTP',a,options);
    assert.equal(ok(await call(expired.path,undefined,a,expired.proof)).status,'VERIFIED');
    await complete(expired);
    const renewed = await begin('REAUTH','EMAIL_PASSWORD',a,options);
    assert.equal(ok(await call(renewed.path,undefined,a,renewed.proof)).status,'VERIFIED');
    await db.prepare('UPDATE auth_login_session SET authenticated_at=authenticated_at-7776000001,last_active_at=last_active_at-7776000001,absolute_expires_at=absolute_expires_at-7776000001 WHERE id=?').bind(b.session.loginSessionId).run();
    assert.equal((await call('/users/me',undefined,b)).status,401);
    ok(await call('/sessions/current/logout',{},a));
    assert.equal((await call(renewed.path+'/complete',{},a,renewed.proof)).status,401);
  } finally { await p.dispose(); }
});
