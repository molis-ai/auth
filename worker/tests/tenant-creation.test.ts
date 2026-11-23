import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { hash, secret } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

for (const mode of [undefined, 'SELF_SERVICE', 'PLATFORM_ONLY', 'UNKNOWN']) {
  test(`V2U-09 tenant creation policy ${mode ?? 'default'} preserves ownership and platform boundaries`, async () => {
    const origin = 'http://127.0.0.1:8787'
    const proxy = await getRustProxy({
      AUTH_ORIGIN: origin,
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
        environmentId: 'unified-local',
        kind: 'LOCAL',
        authOrigin: origin,
        deliveryMode: 'MOCK',
        providerMode: 'MOCK',
      }),
      ...(mode === undefined ? {} : { TENANT_CREATION_POLICY: mode }),
    })
    try {
      await initializeLocalRuntime(proxy)
      const db = proxy.env.DB
      for (const sql of readFileSync(
        new URL('../unified-account-local-seed.sql', import.meta.url),
        'utf8',
      )
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((v) => v.trim())
        .filter(Boolean))
        await db.prepare(sql).run()
      const now = Date.now(),
        access = secret()
      const statement = (sql: string, ...values: (string | number)[]) =>
        db.prepare(sql).bind(...values)
      // Trusted fixture issues a live V2 session, not a public claimed-user endpoint.
      await db.batch([
        statement("INSERT INTO auth_user VALUES ('creator','Creator','ACTIVE',NULL,?,?)", now, now),
        statement("INSERT INTO auth_user VALUES ('other','Other','ACTIVE',NULL,?,?)", now, now),
        statement("INSERT INTO auth_user_security(user_id,updated_at) VALUES ('creator',?)", now),
        statement(
          "INSERT INTO auth_security_sequence(seq,kind,created_at) VALUES (1,'TRANSACTION',?)",
          now,
        ),
        statement(
          "INSERT INTO auth_login_session(id,user_id,client_id,authenticated_at,last_active_at,absolute_expires_at,user_epoch,created_seq) VALUES ('session','creator','molis-work-unified-local',?,?,?,0,1)",
          now,
          now,
          now + 7776000000,
        ),
        statement(
          "INSERT INTO auth_login_access_token VALUES (?,'session',0,0,?)",
          hash(access),
          now + 900000,
        ),
        // Existing organizations remain readable under both creation strategies.
        statement(
          "INSERT INTO auth_space(id,name,space_type,status,created_at,updated_at) VALUES ('existing','Existing','TEAM','ACTIVE',0,0)",
        ),
        statement(
          "INSERT INTO auth_managed_tenant(space_id,status,managed_by,managed_at,updated_at) VALUES ('existing','ACTIVE','creator',?,?)",
          now,
          now,
        ),
        statement(
          "INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at) VALUES ('existing-owner','existing','creator','OWNER','ACTIVE',?)",
          now,
        ),
      ])
      async function call(
        path: string,
        body?: unknown,
        key = secret(),
        token: string | null = access,
      ) {
        const response = await proxy.fetch(
          new Request(origin + '/api/v2' + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': key,
              ...(token ? { Authorization: 'Bearer ' + token } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return { status: response.status, ...(await response.json()) }
      }
      assert.equal((await call('/tenant-creation-policy', undefined, secret(), null)).status, 401)
      assert.equal((await call('/tenants', { name: 'Anonymous' }, secret(), null)).status, 401)
      assert.equal(
        (await call('/tenants', { name: 'Forged owner', ownerUserId: 'other' })).status,
        400,
      )
      assert.equal(
        (await call('/tenants', { name: 'Forged policy', mode: 'SELF_SERVICE' })).status,
        400,
      )
      const existing = await call('/tenants/existing')
      assert.equal(existing.status, 200)
      assert.equal(existing.data.myRole, 'OWNER')
      const policy = await call('/tenant-creation-policy')
      const key = secret(),
        created = await call('/tenants', { name: 'My tenant' }, key)
      if (mode === 'UNKNOWN') {
        assert.equal(policy.status, 503)
        assert.equal(created.status, 503)
        assert.equal(created.error.code, 'UNIFIED_CONFIGURATION_INVALID')
      } else {
        assert.equal(policy.status, 200)
        assert.ok(validateNamed('TenantCreationPolicyView', policy.data))
        assert.equal(policy.data.mode, mode ?? 'SELF_SERVICE')
        if (mode === 'PLATFORM_ONLY') {
          assert.equal(created.status, 403)
          assert.equal(created.error.code, 'FORBIDDEN')
        } else {
          assert.equal(created.status, 200, JSON.stringify(created))
          assert.ok(validateNamed('TenantView', created.data))
          assert.equal(created.data.myRole, 'OWNER')
          const repeated = await call('/tenants', { name: 'My tenant' }, key)
          assert.equal(repeated.status, 200)
          assert.deepEqual(repeated.data, created.data)
          const raceKey = secret()
          const racing = await Promise.all([
            call('/tenants', { name: 'Concurrent tenant' }, raceKey),
            call('/tenants', { name: 'Concurrent tenant' }, raceKey),
          ])
          assert.deepEqual(
            racing.map((r) => r.status),
            [200, 200],
          )
          assert.deepEqual(racing[0].data, racing[1].data)
          assert.equal((await call('/tenants', { name: 'Changed' }, key)).status, 409)
          const membership = await db
            .prepare('SELECT user_id,role FROM auth_tenant_membership WHERE tenant_id=?')
            .bind(created.data.tenantId)
            .first()
          assert.deepEqual(membership, { user_id: 'creator', role: 'OWNER' })
        }
      }
      assert.equal(
        (await db.prepare('SELECT count(*) n FROM auth_managed_tenant').first()).n,
        mode === undefined || mode === 'SELF_SERVICE' ? 3 : 1,
      )
      assert.equal((await db.prepare('SELECT count(*) n FROM billing_subscription').first()).n, 0)
      const platformBody = {
        name: 'Assigned tenant',
        ownerUserId: 'other',
        reason: 'Synthetic acceptance',
      }
      assert.equal((await call('/platform/tenants', platformBody)).status, 403)
      await statement(
        "INSERT INTO auth_platform_permission(user_id,permission,status,granted_by,granted_at) VALUES ('creator','TENANT_CREATE','ACTIVE','creator',?)",
        now,
      ).run()
      const assigned = await call('/platform/tenants', platformBody)
      assert.equal(assigned.status, 200)
      assert.equal(assigned.data.ownerUserId, 'other')
      assert.equal(
        (
          await db
            .prepare("SELECT count(*) n FROM auth_platform_permission WHERE user_id='other'")
            .first()
        ).n,
        0,
      )
      const beforeRevocation = (
        await db.prepare('SELECT count(*) n FROM auth_managed_tenant').first()
      ).n
      await statement(
        "UPDATE auth_login_session SET revoked_at=? WHERE id='session'",
        Date.now(),
      ).run()
      assert.equal((await call('/tenants', { name: 'After revocation' })).status, 401)
      assert.equal(
        (await db.prepare('SELECT count(*) n FROM auth_managed_tenant').first()).n,
        beforeRevocation,
      )
    } finally {
      await proxy.dispose()
    }
  })
}
