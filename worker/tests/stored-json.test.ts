import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { captureAuthFailures, hash, secret } from './fixtures.ts'

test('AC-AUTH-05 stored JSON read failures keep the error response and request trace', async (t) => {
  const origin = 'http://127.0.0.1:8787'
  const access = secret()
  const failures = captureAuthFailures()
  const p = await getRustProxy(
    {
      AUTH_ORIGIN: origin,
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
    {
      ...failures,
      passwordKdf: false,
      fixtureEntrypoint: readFileSync(
        new URL('./fixtures/stored-json.mjs', import.meta.url),
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
      .map((sql) => sql.trim())
      .filter(Boolean)) {
      await db.prepare(sql).run()
    }
    const now = Date.now()
    const statement = (sql: string, ...values: (string | number)[]) =>
      db.prepare(sql).bind(...values)
    await db
      .prepare('CREATE TABLE fixture_stored_json(field TEXT PRIMARY KEY, raw TEXT NOT NULL)')
      .run()
    await db.batch([
      statement(
        "INSERT INTO auth_user(id,display_name,status,avatar_data,created_at,updated_at) VALUES ('admin','Admin','ACTIVE',NULL,?,?)",
        now,
        now,
      ),

      statement(
        "INSERT INTO auth_security_sequence(seq,kind,created_at) VALUES (1,'TRANSACTION',?)",
        now,
      ),
      statement(
        "INSERT INTO auth_login_session(id,user_id,client_id,authenticated_at,last_active_at,absolute_expires_at,user_epoch,created_seq) VALUES ('admin-session','admin','molis-work-unified-local',?,?,?,0,1)",
        now,
        now,
        now + 7776000000,
      ),
      statement(
        "INSERT INTO auth_login_access_token VALUES (?,'admin-session',0,0,?)",
        hash(access),
        now + 600000,
      ),
      statement(
        "INSERT INTO auth_platform_permission(user_id,permission,status,granted_by,granted_at) VALUES ('admin',?,'ACTIVE','admin',?)",
        'CLIENT_READ',
        now,
      ),
      statement(
        "INSERT INTO auth_platform_permission(user_id,permission,status,granted_by,granted_at) VALUES ('admin',?,'ACTIVE','admin',?)",
        'AUDIT_READ',
        now,
      ),
      statement(
        "INSERT INTO auth_management_audit(id,actor_user_id,client_id,operation,target_type,target_id,outcome,request_id,occurred_at) VALUES ('fixture-audit','admin','molis-work-unified-local','fixture.operation','TENANT','fixture-tenant','DENIED','fixture-request-id',?)",
        now,
      ),
    ])

    const get = (path: string) =>
      p.fetch(new Request(origin + path, { headers: { Authorization: 'Bearer ' + access } }))
    async function successful(path: string) {
      const response = await get(path)
      const payload = await response.json()
      assert.equal(response.status, 200, JSON.stringify(payload))
      return payload.data
    }
    async function unavailable(path: string, route: string) {
      const response = await get(path)
      assert.equal(response.status, 503)
      assert.match(response.headers.get('Content-Type') ?? '', /^application\/json\b/)
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
      const requestId = response.headers.get('X-Request-ID')
      assert.ok(requestId)
      assert.deepEqual(await response.json(), { error: { code: 'AUTH_UNAVAILABLE' }, requestId })
      const logs = await failures.forRequest(requestId, ['dispatch'])
      assert.equal(logs.length, 1)
      const [log] = logs
      assert.equal(log.event, 'auth.request.failure')
      assert.equal(log.route, route)
      assert.equal(log.code, 'AUTH_UNAVAILABLE')
      assert.equal(log.status, 503)
    }

    await t.test('audit projection preserves a null summary and rejects corrupt JSON', async () => {
      const path = '/api/v1/platform/audit-events'
      const baseline = await successful(path)
      assert.equal(baseline.items[0].auditEventId, 'fixture-audit')
      assert.equal(baseline.items[0].changes, null)
      assert.equal(baseline.items[0].requestId, 'fixture-request-id')
      assert.equal(baseline.items[0].reason, null)
      assert.deepEqual(await successful(path + '?result=DENIED'), baseline)
      assert.deepEqual((await successful(path + '?result=SUCCEEDED')).items, [])
      await statement('INSERT INTO fixture_stored_json VALUES (?,?)', 'change_summary', '{').run()
      await unavailable(path, path)
    })

    await t.test(
      'client detail and page reject malformed redirects and invalid origins',
      async () => {
        const path = '/api/v1/platform/clients/molis-club-unified-local'
        const collection = '/api/v1/platform/applications/molis-club-unified-local-app/clients'
        const client = await successful(path)
        assert.equal(client.clientId, 'molis-club-unified-local')
        assert.deepEqual((await successful(collection)).items, [client])
        await statement(
          'UPDATE auth_client SET redirects=? WHERE client_id=?',
          '{',
          client.clientId,
        ).run()
        await unavailable(path, '/api/v1/platform/clients/{clientId}')
        await unavailable(collection, '/api/v1/platform/applications/{applicationId}/clients')
        await statement(
          'UPDATE auth_client SET redirects=? WHERE client_id=?',
          JSON.stringify(client.redirectAllowlist),
          client.clientId,
        ).run()
        await statement(
          'UPDATE auth_client SET allowed_origins=? WHERE client_id=?',
          '[42]',
          client.clientId,
        ).run()
        await unavailable(path, '/api/v1/platform/clients/{clientId}')
      },
    )
  } finally {
    await p.dispose()
  }
})
