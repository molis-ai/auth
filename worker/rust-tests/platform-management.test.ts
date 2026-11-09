import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { hash, secret } from './fixtures.ts'
import { bootstrapPlatform } from '../scripts/platform-bootstrap.mjs'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

test('V2U-04 V2 platform applications and clients require explicit current authority', async () => {
  const origin = 'http://127.0.0.1:8787'
  const p = await getRustProxy({
    AUTH_ORIGIN: origin,
    PLATFORM_ADMIN_IDS: 'admin',
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
    const n = Date.now(),
      access = secret()
    const statement = (sql: string, ...values: (string | number)[]) =>
      db.prepare(sql).bind(...values)
    await db.batch([
      statement("INSERT INTO auth_user VALUES ('admin','Admin','ACTIVE',NULL,?,?)", n, n),
      statement("INSERT INTO auth_user_security(user_id,updated_at) VALUES ('admin',?)", n),
      statement(
        "INSERT INTO auth_security_sequence(seq,kind,created_at) VALUES (1,'TRANSACTION',?)",
        n,
      ),
      statement(
        "INSERT INTO auth_login_session(id,user_id,client_id,authenticated_at,last_active_at,absolute_expires_at,user_epoch,created_seq) VALUES ('admin-session','admin','molis-work-unified-local',?,?,?,0,1)",
        n,
        n,
        n + 7776000000,
      ),
      statement(
        "INSERT INTO auth_login_access_token VALUES (?,'admin-session',0,0,?)",
        hash(access),
        n + 900000,
      ),
    ])
    async function call(
      path: string,
      body?: unknown,
      method = body === undefined ? 'GET' : 'POST',
      key = secret(),
      token: string | null = access,
    ) {
      const response = await p.fetch(
        new Request(origin + '/api/v2/platform' + path, {
          method,
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
    function ok(value: any, schema: string) {
      assert.equal(value.status, 200, JSON.stringify(value))
      assert.ok(validateNamed(schema, value.data), schema + JSON.stringify(value))
      return value.data
    }
    async function grant(permission: string) {
      await statement(
        "INSERT INTO auth_platform_permission(user_id,permission,status,granted_by,granted_at) VALUES ('admin',?,'ACTIVE','admin',?)",
        permission,
        n,
      ).run()
    }
    assert.equal((await call('/applications', undefined, 'GET', secret(), null)).status, 401)
    assert.equal((await call('/applications')).status, 403) // V1 admin configuration is not V2 authority.
    assert.equal((await call('/applications', { name: 'Denied' })).status, 403)
    await grant('APPLICATION_WRITE')
    assert.equal((await call('/applications')).status, 403)
    assert.equal((await call('/applications', { name: 'Forged', platformAdmin: true })).status, 400)
    const key = secret()
    const pair = await Promise.all([
      call('/applications', { name: 'Managed' }, 'POST', key),
      call('/applications', { name: 'Managed' }, 'POST', key),
    ])
    const app = ok(pair[0], 'PlatformApplication')
    assert.deepEqual(ok(pair[1], 'PlatformApplication'), app)
    assert.equal((await call('/applications', { name: 'Different' }, 'POST', key)).status, 409)
    await grant('APPLICATION_READ')
    const page = ok(await call('/applications?limit=1'), 'PlatformApplicationPage')
    assert.ok(page.nextCursor)
    ok(await call('/applications?limit=1&cursor=' + page.nextCursor), 'PlatformApplicationPage')
    assert.equal((await call('/applications?actor=other')).status, 400)
    ok(await call('/applications/' + app.applicationId), 'PlatformApplication')
    assert.equal(
      (
        await call(
          '/applications/' + app.applicationId,
          { name: 'Stale', status: 'ACTIVE', expectedVersion: 99 },
          'PATCH',
        )
      ).status,
      409,
    )
    const updated = ok(
      await call(
        '/applications/' + app.applicationId,
        { name: 'Updated', status: 'ACTIVE', expectedVersion: 0 },
        'PATCH',
      ),
      'PlatformApplication',
    )
    assert.equal(updated.version, 1)
    assert.equal(
      (
        await call(
          '/applications/molis-work-unified-local-app',
          { name: 'Self', status: 'DISABLED', expectedVersion: 0 },
          'PATCH',
        )
      ).status,
      403,
    )
    const clientBody = {
      clientId: 'managed-client',
      clientType: 'WEB',
      environmentId: 'unified-local',
      allowedOrigins: ['http://127.0.0.1:4208'],
      redirectAllowlist: ['http://127.0.0.1:4208/account/callback'],
      product: 'WORK',
    }
    assert.equal(
      (await call('/applications/' + app.applicationId + '/clients', clientBody)).status,
      403,
    )
    await grant('CLIENT_WRITE')
    assert.equal(
      (
        await call('/applications/' + app.applicationId + '/clients', {
          ...clientBody,
          redirectAllowlist: ['https://evil.example/callback'],
        })
      ).status,
      400,
    )
    const clientKey = secret()
    const client = ok(
      await call('/applications/' + app.applicationId + '/clients', clientBody, 'POST', clientKey),
      'PlatformLoginClient',
    )
    assert.equal(client.policyVersion, 0)
    assert.equal(
      (
        await db
          .prepare("SELECT policy_profile FROM auth_client_policy WHERE client_id='managed-client'")
          .first()
      ).policy_profile,
      'unified-account-v2',
    )
    assert.equal((await call('/clients/managed-client')).status, 403)
    await grant('CLIENT_READ')
    ok(await call('/clients/managed-client'), 'PlatformLoginClient')
    assert.equal(
      ok(await call('/applications/' + app.applicationId + '/clients'), 'PlatformLoginClientPage')
        .items.length,
      1,
    )
    const edit = {
      status: 'DISABLED',
      allowedOrigins: clientBody.allowedOrigins,
      redirectAllowlist: clientBody.redirectAllowlist,
      expectedVersion: 0,
      expectedPolicyVersion: 0,
    }
    assert.equal(
      (await call('/clients/managed-client', { ...edit, expectedPolicyVersion: 4 }, 'PATCH'))
        .status,
      409,
    )
    const disabled = ok(await call('/clients/managed-client', edit, 'PATCH'), 'PlatformLoginClient')
    assert.equal(disabled.version, 1)
    assert.equal(disabled.policyVersion, 1)
    await statement(
      "UPDATE auth_platform_permission SET status='REVOKED',revoked_at=?,version=version+1 WHERE user_id='admin' AND permission='CLIENT_WRITE'",
      Date.now(),
    ).run()
    assert.equal(
      (await call('/applications/' + app.applicationId + '/clients', clientBody, 'POST', clientKey))
        .status,
      403,
    )
    // Failed domain writes, audit and receipt must roll back together.
    await db
      .prepare(
        "CREATE TRIGGER fail_client_insert BEFORE INSERT ON auth_client BEGIN SELECT RAISE(ABORT,'injected failure'); END",
      )
      .run()
    await statement(
      "UPDATE auth_platform_permission SET status='ACTIVE',revoked_at=NULL,version=version+1 WHERE user_id='admin' AND permission='CLIENT_WRITE'",
    ).run()
    const before = (await db.prepare('SELECT count(*) n FROM auth_audit_event').first()).n
    assert.ok(
      (
        await call('/applications/' + app.applicationId + '/clients', {
          ...clientBody,
          clientId: 'failed-client',
        })
      ).status >= 400,
    )
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM auth_client_policy WHERE client_id='failed-client'")
          .first()
      ).n,
      0,
    )
    assert.equal((await db.prepare('SELECT count(*) n FROM auth_audit_event').first()).n, before)
    // Bootstrap refuses existing grants and rolls back without adding authority.
    await assert.rejects(() => bootstrapPlatform(db, 'admin'))
    await db.prepare('DELETE FROM auth_platform_permission').run()
    await assert.rejects(() => bootstrapPlatform(db, 'missing-user'))
    assert.equal((await db.prepare('SELECT count(*) n FROM auth_platform_permission').first()).n, 0)
    const initialized = await bootstrapPlatform(db, 'admin')
    const meResponse = await p.fetch(
      new Request(origin + '/api/v2/users/me', { headers: { Authorization: 'Bearer ' + access } }),
    )
    assert.equal(meResponse.status, 200)
    const me = await meResponse.json()
    assert.ok(validateNamed('MeView', me.data))
    assert.equal(me.data.platformCapabilities.length, initialized.capabilities.length)

    assert.ok(initialized.capabilities.includes('APPLICATION_WRITE'))
    assert.ok(initialized.capabilities.includes('CLIENT_WRITE'))
    await assert.rejects(() => bootstrapPlatform(db, 'admin'))

    await statement(
      "INSERT INTO auth_user VALUES ('target','Target','ACTIVE',NULL,?,?)",
      n,
      n,
    ).run()
    await statement(
      "INSERT INTO auth_user_security(user_id,updated_at) VALUES ('target',?)",
      n,
    ).run()
    ok(await call('/users'), 'PlatformUserPage')
    const user = ok(await call('/users/target'), 'PlatformUser')
    const granted = ok(
      await call(
        '/users/target/permissions/CLIENT_READ',
        { enabled: true, expectedVersion: null, reason: 'Synthetic grant' },
        'PATCH',
      ),
      'PlatformPermission',
    )
    assert.equal(granted.status, 'ACTIVE')
    assert.equal(
      ok(await call('/users/target/permissions'), 'PlatformPermissionPage').items.length,
      1,
    )
    assert.equal(
      (
        await call(
          '/users/admin/permissions/PLATFORM_PERMISSION_WRITE',
          { enabled: false, expectedVersion: 0, reason: 'Reject last administrator' },
          'PATCH',
        )
      ).status,
      409,
    )
    const stopped = ok(
      await call(
        '/users/target/status',
        { status: 'DISABLED', expectedVersion: user.version, reason: 'Synthetic disable' },
        'PATCH',
      ),
      'PlatformUser',
    )
    assert.equal(stopped.status, 'DISABLED')
    assert.equal(
      (
        await call(
          '/users/admin/status',
          { status: 'DISABLED', expectedVersion: 0, reason: 'Self lockout' },
          'PATCH',
        )
      ).status,
      403,
    )
    const started = ok(
      await call(
        '/users/target/status',
        { status: 'ACTIVE', expectedVersion: stopped.version, reason: 'Synthetic enable' },
        'PATCH',
      ),
      'PlatformUser',
    )
    assert.equal(started.version, 2)
    // V2C-01: an authenticated operator cannot resurrect retired service administration.
    const beforeRetired = (await db.prepare('SELECT count(*) n FROM auth_audit_event').first()).n
    assert.equal((await call('/applications/' + app.applicationId + '/services')).status, 404)
    assert.equal(
      (await call('/applications/' + app.applicationId + '/services', { name: 'Retired' })).status,
      404,
    )
    for (const capability of ['SERVICE_READ', 'SERVICE_WRITE'])
      assert.equal(
        (
          await call(
            '/users/target/permissions/' + capability,
            { enabled: true, expectedVersion: null, reason: 'Retired' },
            'PATCH',
          )
        ).status,
        400,
      )
    assert.equal(
      (await db.prepare('SELECT count(*) n FROM auth_audit_event').first()).n,
      beforeRetired,
    )
    await statement(
      "UPDATE auth_login_session SET revoked_at=? WHERE id='admin-session'",
      Date.now(),
    ).run()
    assert.equal((await call('/applications', { name: 'After revocation' })).status, 401)
  } finally {
    await p.dispose()
  }
})
