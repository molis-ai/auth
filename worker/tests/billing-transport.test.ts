import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { compatibilityDate } from '../scripts/environment.mjs'
import { initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { billingFetch } from '../rust/src/runtime/billing-transport.js'
import { hash, secret } from './fixtures.ts'

const header = 'X-Molis-Internal-Secret'
const shared = secret()
const authOrigin = 'http://127.0.0.1:8787'
const accessToken = secret()
const bridgePaths = ['/internal/v1/sessions/introspect', '/internal/v1/subjects/verify']

async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get(header), null)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
  const body = await response.text()
  assert.equal(JSON.parse(body).error.code, code)
  assert.equal(body.includes(shared), false)
  assert.equal(body.includes(accessToken), false)
}

test('Auth bridge enforces the private channel and reads current Work billing identity', async (t) => {
  const origin = 'https://auth.test.molis.ai'
  const boundOrigin = 'https://auth.internal'
  const clientId = 'molis-auth-web-local'
  const [introspect, verify] = bridgePaths
  const root = new URL('../rust/', import.meta.url)
  const workerPath = (path: string) => fileURLToPath(new URL(path, root))
  const authWorker = {
    compatibilityDate,
    modulesRoot: workerPath('.'),
    modules: [
      { type: 'ESModule' as const, path: workerPath('src/runtime/entrypoint.js') },
      { type: 'ESModule' as const, path: workerPath('src/runtime/billing-transport.js') },
      { type: 'ESModule' as const, path: workerPath('build/index.js') },
      { type: 'CompiledWasm' as const, path: workerPath('build/index_bg.wasm') },
    ],
  }
  const options = convertV4MiniflareOptions({
    workers: [
      {
        name: 'caller',
        compatibilityDate,
        modules: true,
        script: `export default {
          fetch(request, env) {
            const target = request.headers.get('X-Fixture-Auth')
            const binding = target === 'missing-secret' ? env.AUTH_MISSING
              : target === 'missing-config' ? env.AUTH_UNCONFIGURED : env.AUTH
            return binding.fetch(request)
          }
        }`,
        serviceBindings: {
          AUTH: { name: 'auth', entrypoint: 'AuthInternal' },
          AUTH_MISSING: { name: 'missing-secret', entrypoint: 'AuthInternal' },
          AUTH_UNCONFIGURED: { name: 'missing-config', entrypoint: 'AuthInternal' },
        },
      },
      {
        ...authWorker,
        name: 'auth',
        d1Databases: { DB: 'auth-bridge-test' },
        bindings: {
          MOLIS_ENVIRONMENT: 'test',
          MOLIS_INTERNAL_SECRET: shared,
          AUTH_ORIGIN: origin,
          AUTH_WEB_CLIENT_ID: clientId,
          UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
            environmentId: 'unified-local',
            kind: 'TEST',
            authOrigin: origin,
            deliveryMode: 'MOCK',
            providerMode: 'MOCK',
          }),
        },
      },
      { ...authWorker, name: 'missing-secret', bindings: { MOLIS_ENVIRONMENT: 'prod' } },
      {
        ...authWorker,
        name: 'missing-config',
        d1Databases: { DB: 'auth-bridge-test' },
        bindings: { MOLIS_ENVIRONMENT: 'test', MOLIS_INTERNAL_SECRET: shared, AUTH_ORIGIN: origin },
      },
      {
        ...authWorker,
        name: 'local',
        d1Databases: { DB: 'auth-bridge-test' },
        bindings: {
          MOLIS_ENVIRONMENT: 'dev',
          MOLIS_LOCAL_GENERATION: 'fixture',
          AUTH_ORIGIN: authOrigin,
          AUTH_WEB_CLIENT_ID: clientId,
          MOLIS_INTERNAL_SECRET: shared,
          UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
            environmentId: 'unified-local',
            kind: 'LOCAL',
            authOrigin,
            deliveryMode: 'MOCK',
            providerMode: 'MOCK',
          }),
        },
      },
    ],
  })
  const mf = new Miniflare(options)
  t.after(() => mf.dispose())
  const direct = await mf.getWorker('auth')
  const local = await mf.getWorker('local')
  for (const path of [...bridgePaths, '/internal/v1', '/internal/v1/other']) {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      await expectError(
        await direct.fetch(origin + path, {
          method,
          headers: { [header]: shared, Authorization: 'Bearer ' + accessToken },
        }),
        404,
        'NOT_FOUND',
      )
    }
  }
  for (const path of bridgePaths) {
    await expectError(
      await mf.dispatchFetch(boundOrigin + path, {
        headers: { 'X-Fixture-Auth': 'missing-secret' },
      }),
      503,
      'AUTH_UNAVAILABLE',
    )
    await expectError(await mf.dispatchFetch(boundOrigin + path), 404, 'NOT_FOUND')
    await expectError(
      await mf.dispatchFetch(boundOrigin + path, { headers: { [header]: secret() } }),
      404,
      'NOT_FOUND',
    )
    await expectError(
      await mf.dispatchFetch(boundOrigin + path, { headers: { [header]: shared } }),
      405,
      'METHOD_NOT_ALLOWED',
    )
    await expectError(
      await local.fetch(authOrigin + path, { headers: { [header]: shared } }),
      405,
      'METHOD_NOT_ALLOWED',
    )
    await expectError(
      await local.fetch(origin + path, { headers: { [header]: shared } }),
      404,
      'NOT_FOUND',
    )
  }
  const legacyHealth = await direct.fetch(origin + '/api/v2/health')
  assert.equal(legacyHealth.status, 200)

  const db = await mf.getD1Database('DB', 'auth')
  await initializeLocalRuntime({ env: { DB: db } })
  const at = Date.now() - 60_000
  const run = (sql: string, ...parameters: (string | number)[]) =>
    db
      .prepare(sql)
      .bind(...parameters)
      .run()
  await run(
    "UPDATE auth_environment SET kind='TEST',auth_origin=? WHERE id='unified-local'",
    origin,
  )
  await run('UPDATE auth_client_policy SET allowed_origins=?', JSON.stringify([origin]))
  await run('UPDATE auth_client SET redirects=?', JSON.stringify([origin + '/account/callback']))
  await run("INSERT INTO auth_user VALUES ('user-1','Fixture','ACTIVE',NULL,?,?)", at, at)
  await run("INSERT INTO auth_user_security(user_id,updated_at) VALUES ('user-1',?)", at)
  await run(
    "INSERT INTO auth_security_sequence(seq,kind,created_at) VALUES (1,'TRANSACTION',?)",
    at,
  )
  await run(
    "INSERT INTO auth_login_session(id,user_id,client_id,authenticated_at,last_active_at,absolute_expires_at,user_epoch,created_seq) VALUES ('session-1','user-1',?,?,?,?,0,1)",
    clientId,
    at,
    at,
    at + 7_776_000_000,
  )
  const digest = hash(accessToken)
  await run(
    "INSERT INTO auth_login_access_token VALUES (?,'session-1',0,0,?)",
    digest,
    at + 900_000,
  )
  await run(
    "INSERT INTO auth_space(id,name,space_type,status,created_at,updated_at) VALUES ('team-1','Fixture','TEAM','ACTIVE',?,?)",
    at,
    at,
  )
  await run(
    "INSERT INTO auth_managed_tenant(space_id,status,managed_by,managed_at,updated_at) VALUES ('team-1','ACTIVE','user-1',?,?)",
    at,
    at,
  )
  await run(
    "INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at) VALUES ('member-1','team-1','user-1','ADMIN','ACTIVE',?)",
    at,
  )
  assert.equal(
    (await db.prepare('SELECT COUNT(*) count FROM auth_client_product').first()).count,
    0,
  )

  const call = (
    path: string,
    body: unknown,
    authorization = 'Bearer ' + accessToken,
    overrides: Record<string, string> = {},
  ) =>
    mf.dispatchFetch(boundOrigin + path, {
      method: 'POST',
      headers: {
        [header]: shared,
        Authorization: authorization,
        'Content-Type': 'application/json',
        ...overrides,
      },
      body: JSON.stringify(body),
    })
  async function expectData(response: Response, data: unknown) {
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(response.headers.get('Set-Cookie'), null)
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
    assert.deepEqual(await response.json(), { data })
  }
  const self = { product: 'WORK', owner: { kind: 'USER' } }
  const team = { product: 'WORK', owner: { kind: 'TENANT', id: 'team-1' } }
  await expectData(await call(introspect, {}), { userId: 'user-1' })
  await expectData(await call(verify, self), {
    ...self,
    userId: 'user-1',
    owner: { kind: 'USER', id: 'user-1' },
    role: 'SELF',
  })
  for (const role of ['ADMIN', 'MEMBER', 'OWNER']) {
    await run('UPDATE auth_tenant_membership SET role=?', role)
    await expectData(await call(verify, team), { ...team, userId: 'user-1', role })
  }
  await expectError(await call(introspect, []), 400, 'INVALID_REQUEST')
  await expectError(await call(verify, { ...team, product: 'CLUB' }), 400, 'INVALID_REQUEST')
  await expectError(await call(verify, { ...team, role: 'OWNER' }), 400, 'INVALID_REQUEST')
  await expectError(
    await call(verify, { ...self, owner: { kind: 'USER', id: 'other-user' } }),
    403,
    'FORBIDDEN',
  )
  await expectError(
    await call(verify, { ...team, owner: { kind: 'TENANT', id: 'other-team' } }),
    404,
    'NOT_FOUND',
  )
  await run("UPDATE auth_tenant_membership SET status='LEFT',ended_at=?", at + 1)
  await expectError(await call(verify, team), 404, 'NOT_FOUND')
  await run("UPDATE auth_tenant_membership SET status='ACTIVE',ended_at=NULL")
  await run("UPDATE auth_managed_tenant SET status='DISABLED'")
  await expectError(await call(verify, team), 403, 'TENANT_DISABLED')
  await expectData(await call(introspect, {}), { userId: 'user-1' })
  await run("UPDATE auth_managed_tenant SET status='ACTIVE'")
  await expectData(await call(verify, team), { ...team, userId: 'user-1', role: 'OWNER' })

  await expectError(await call(introspect, {}, ''), 401, 'UNAUTHENTICATED')
  await expectError(await call(introspect, {}, 'Bearer ' + secret()), 401, 'SESSION_EXPIRED')
  await expectError(
    await call(introspect, {}, undefined, { 'X-Fixture-Auth': 'missing-config' }),
    503,
    'AUTH_UNAVAILABLE',
  )
  await run("UPDATE auth_client SET status='DISABLED'")
  await expectError(await call(introspect, {}), 403, 'FORBIDDEN')
  await run("UPDATE auth_client SET status='ACTIVE'")
  await run(
    "INSERT INTO auth_client SELECT 'other-client','other-client',application_id,client_type,status,version,scopes,redirects FROM auth_client WHERE client_id=?",
    clientId,
  )
  await run(
    "INSERT INTO auth_client_policy SELECT 'other-client',policy_profile,environment_id,allowed_origins,version,created_at,updated_at FROM auth_client_policy WHERE client_id=?",
    clientId,
  )
  await run("UPDATE auth_login_session SET client_id='other-client'")
  await expectError(await call(introspect, {}), 403, 'FORBIDDEN')
  await expectError(await call(verify, team), 403, 'FORBIDDEN')
  await run('UPDATE auth_login_session SET client_id=?', clientId)
  await run('UPDATE auth_login_access_token SET expires_at=?', at)
  await expectError(await call(introspect, {}), 401, 'SESSION_EXPIRED')
  await run('UPDATE auth_login_access_token SET expires_at=?', at + 900_000)
  await run('UPDATE auth_login_session SET revoked_at=?', at + 1)
  await expectError(await call(verify, team), 401, 'SESSION_EXPIRED')
  await run('UPDATE auth_login_session SET revoked_at=NULL,session_revision=1')
  await expectError(await call(introspect, {}), 401, 'SESSION_EXPIRED')
  await run('UPDATE auth_login_session SET session_revision=0')
  await run('UPDATE auth_user_security SET session_epoch=1')
  await expectError(await call(verify, self), 401, 'SESSION_EXPIRED')
  await run('UPDATE auth_user_security SET session_epoch=0')
  await run("UPDATE auth_user SET status='DISABLED'")
  await expectError(await call(introspect, {}), 401, 'SESSION_EXPIRED')
  await run("UPDATE auth_user SET status='ACTIVE'")
  const idleSince = at - 2_592_000_000
  await run(
    'UPDATE auth_login_session SET authenticated_at=?,last_active_at=?,absolute_expires_at=?',
    idleSince,
    idleSince,
    idleSince + 7_776_000_000,
  )
  await expectError(await call(verify, team), 401, 'SESSION_EXPIRED')
  assert.equal(
    (await db.prepare('SELECT last_active_at FROM auth_login_session').first()).last_active_at,
    idleSince,
  )
  await run(
    'UPDATE auth_login_session SET authenticated_at=?,last_active_at=?,absolute_expires_at=?',
    at,
    at,
    at + 7_776_000_000,
  )

  // Use the separate dev entrypoint with a registration that matches its loopback config.
  await run("UPDATE auth_environment SET kind='LOCAL',auth_origin=?", authOrigin)
  await run('UPDATE auth_client_policy SET allowed_origins=?', JSON.stringify([authOrigin]))
  await expectError(await call(verify, team), 403, 'FORBIDDEN')
  await expectData(
    await local.fetch(authOrigin + verify, {
      method: 'POST',
      headers: {
        [header]: shared,
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(team),
    }),
    { ...team, userId: 'user-1', role: 'OWNER' },
  )
  assert.equal(
    (await db.prepare('SELECT last_active_at FROM auth_login_session').first()).last_active_at,
    at,
  )
  assert.equal(
    (await db.prepare('SELECT COUNT(*) count FROM auth_login_activity').first()).count,
    0,
  )
})

test('Billing outbound uses test/prod service bindings and only dev may use the loopback', async (t) => {
  const path = '/api/v1/orders'
  const input = { method: 'GET', path, accessToken }
  const network = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: {} }))
  const bound = t.mock.fn(async (request: Request) => {
    assert.equal(request.url, 'https://billing.internal/api/v1/orders?product=WORK')
    assert.equal(request.redirect, 'manual')
    assert.equal(request.headers.get(header), shared)
    assert.equal(request.headers.get('Authorization'), 'Bearer ' + accessToken)
    assert.equal(request.headers.get('Cookie'), null)
    assert.equal(request.headers.get('Origin'), null)
    assert.equal(request.headers.get('X-CSRF-Token'), null)
    assert.equal(request.headers.get('Idempotency-Key'), 'fixture-order')
    assert.equal(request.headers.get('X-Request-Id'), 'fixture-request')
    assert.deepEqual(await request.json(), { planId: 'work-personal-test' })
    return Response.json(
      { data: { orderId: 'fixture-order' } },
      { status: 201, headers: { 'Set-Cookie': 'other=1', 'Access-Control-Allow-Origin': '*' } },
    )
  })
  for (const env of ['test', 'prod']) {
    const vars = {
      MOLIS_ENVIRONMENT: env,
      MOLIS_LOCAL_GENERATION: 'fixture',
      AUTH_ORIGIN: authOrigin,
      MOLIS_INTERNAL_SECRET: shared,
    }
    await expectError(await billingFetch(vars, input), 503, 'BILLING_UNAVAILABLE')
    await expectError(
      await billingFetch({ ...vars, MOLIS_INTERNAL_SECRET: '', BILLING: { fetch: bound } }, input),
      503,
      'BILLING_UNAVAILABLE',
    )
    const response = await billingFetch(
      { ...vars, BILLING: { fetch: bound } },
      {
        method: 'POST',
        path,
        query: { product: 'WORK' },
        body: { planId: 'work-personal-test' },
        idempotencyKey: 'fixture-order',
        requestId: 'fixture-request',
        accessToken,
      },
    )
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('Set-Cookie'), null)
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual(await response.json(), { data: { orderId: 'fixture-order' } })
  }
  assert.equal(bound.mock.callCount(), 2)
  assert.equal(network.mock.callCount(), 0)
  const dev = { MOLIS_ENVIRONMENT: 'dev', AUTH_ORIGIN: authOrigin, MOLIS_INTERNAL_SECRET: shared }
  await expectError(await billingFetch(dev, input), 503, 'BILLING_UNAVAILABLE')
  assert.equal(
    (await billingFetch({ ...dev, MOLIS_LOCAL_GENERATION: 'fixture' }, input)).status,
    200,
  )
  const devRequest = network.mock.calls[0].arguments[0] as Request
  assert.equal(devRequest.url, 'http://127.0.0.1:8788/api/v1/orders')
  assert.equal(devRequest.headers.get(header), shared)
  assert.equal(devRequest.headers.get('Authorization'), 'Bearer ' + accessToken)
  assert.equal(devRequest.redirect, 'manual')
  await expectError(
    await billingFetch(
      { ...dev, MOLIS_LOCAL_GENERATION: 'fixture' },
      { ...input, accessToken: '' },
    ),
    401,
    'UNAUTHENTICATED',
  )
  assert.equal(network.mock.callCount(), 1)
})

test('Billing outbound refuses unexpected paths, redirects and upstream transport failures', async () => {
  const goodInput = { method: 'GET', path: '/api/v1/credits/balance', accessToken }
  const outbound = {
    MOLIS_ENVIRONMENT: 'prod',
    MOLIS_INTERNAL_SECRET: shared,
    BILLING: {
      fetch() {
        return Response.redirect('https://elsewhere.invalid/')
      },
    },
  }
  for (const path of [
    'https://elsewhere.invalid/api/v1/orders',
    '//elsewhere.invalid/api/v1/orders',
    '/api/v1/orders/..',
    '/api/v1/orders/%2Ffoo',
    '/internal/v1/credits/holds',
  ]) {
    await expectError(await billingFetch(outbound, { ...goodInput, path }), 400, 'INVALID_REQUEST')
  }
  await expectError(await billingFetch(outbound, goodInput), 503, 'BILLING_UNAVAILABLE')
  outbound.BILLING.fetch = () => {
    throw Error(shared)
  }
  await expectError(await billingFetch(outbound, goodInput), 503, 'BILLING_UNAVAILABLE')
})
