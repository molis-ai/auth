import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { compatibilityDate } from '../scripts/environment.mjs'
import { initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret } from './fixtures.ts'

// Only the Billing operations are fixtures. Both the browser login and Billing's
// per-request Auth verification run through the compiled Auth Worker and D1.
const billingFixture = `
import { WorkerEntrypoint } from 'cloudflare:workers'

export class BillingInternal extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url)
    const headers = request.headers
    const shared = this.env.MOLIS_INTERNAL_SECRET
    const requestId = headers.get('X-Request-Id')
    if (url.origin !== 'https://billing.internal' || request.redirect !== 'manual' ||
        headers.get('X-Molis-Internal-Secret') !== shared || !requestId ||
        headers.has('Origin') || headers.has('Cookie') || headers.has('X-CSRF-Token')) {
      return new Response('Unexpected private request', { status: 500 })
    }
    const path = url.pathname
    const error = (status, code, message = shared) =>
      Response.json({ error: { code, message } }, { status })
    if (path === '/api/v1/future-resource' && request.method === 'PATCH') {
      return Response.json({ data: { query: url.search.slice(1), body: await request.text() } })
    }
    const allowedPaths = /^[/]api[/]v1[/](credits[/](balance|ledger)|catalog[/]plans|subscriptions|entitlements[/]check|orders([/][A-Za-z0-9.-]+([/](mock-pay|refund))?)?)$/
    if (!allowedPaths.test(path)) return error(404, 'NOT_FOUND')
    const keys = [...url.searchParams.keys()]
    const page = request.method === 'GET' &&
      (path === '/api/v1/orders' || path === '/api/v1/credits/ledger')
    if (new Set(keys).size !== keys.length || keys.some(key =>
      !['product', 'ownerKind', 'ownerId'].includes(key) && !(page && ['limit', 'cursor'].includes(key))
    ) || (url.searchParams.get('ownerKind') === 'TENANT' && !url.searchParams.get('ownerId'))) {
      return error(400, 'INVALID_REQUEST')
    }
    const subject = {
      product: url.searchParams.get('product') ?? 'WORK',
      owner: { kind: url.searchParams.get('ownerKind') ?? 'USER' },
    }
    if (url.searchParams.has('ownerId')) subject.owner.id = url.searchParams.get('ownerId')
    const assertion = await this.env.AUTH.fetch('https://auth.internal/internal/v1/subjects/verify', {
      method: 'POST',
      headers: {
        'Authorization': headers.get('Authorization'),
        'Content-Type': 'application/json',
        'X-Molis-Internal-Secret': shared,
        'X-Request-Id': requestId,
      },
      body: JSON.stringify(subject),
    })
    if (assertion.headers.get('X-Request-Id') !== requestId) {
      return new Response('Request ID was lost at Auth', { status: 500 })
    }
    if (!assertion.ok) return assertion
    const { data: { owner, role } } = await assertion.json()
    const reply = (data, status = 200) => Response.json({ data }, {
      status,
      headers: {
        'Set-Cookie': 'billing-fixture=1',
        'Access-Control-Allow-Origin': '*',
        'X-Molis-Internal-Secret': shared,
        'X-Request-Id': 'untrusted-response-header',
      },
    })
    if (path.startsWith('/api/v1/orders') && role === 'MEMBER') return error(403, 'FORBIDDEN')
    if (path === '/api/v1/orders/order.expired/mock-pay') return error(409, 'ORDER_EXPIRED')
    if (path === '/api/v1/orders/order.started/refund') return error(409, 'ORDER_NOT_REFUNDABLE')
    if (path === '/api/v1/orders/down') throw Error('Fixture Billing unavailable')
    if (path === '/api/v1/orders/auth-down') return error(503, 'AUTH_UNAVAILABLE')
    if (path === '/api/v1/orders/unknown') return error(500, 'UNDECLARED_CODE', 'A new upstream error')
    if (path === '/api/v1/orders/invalid-code') return error(500, 'invalid code')
    if (path === '/api/v1/orders/malformed') {
      return new Response('{', { headers: { 'Content-Type': 'application/json' } })
    }
    const ownerFields = { product: subject.product, ownerKind: owner.kind, ownerId: owner.id }
    if (path === '/api/v1/credits/balance') {
      const available = owner.kind === 'USER' ? 100 : owner.id === 'team-one' ? 500 : 250
      return reply({ ...ownerFields, available, currentCreditPeriod: null })
    }
    if (path === '/api/v1/orders' && request.method === 'POST') {
      const body = await request.json()
      if (!headers.has('Idempotency-Key') || Object.keys(body).some(key =>
        !['planId', 'interval', 'billingTimeZone'].includes(key)
      )) return error(400, 'INVALID_REQUEST')
      if (body.billingTimeZone === 'Invalid/Zone') return error(400, 'INVALID_TIMEZONE')
      return reply({ ...ownerFields, ...body, id: headers.get('Idempotency-Key'), requestId }, 201)
    }
    if (path === '/api/v1/orders/order.active/mock-pay') {
      return reply({ ...ownerFields, id: 'order.active', hadBody: (await request.text()) !== '' })
    }
    if (path === '/api/v1/orders' || path === '/api/v1/credits/ledger') {
      return reply({ items: [], nextCursor: url.searchParams.get('cursor'), limit: url.searchParams.get('limit') })
    }
    return reply({ ...ownerFields, path })
  }
}
export default { fetch: () => new Response('Private fixture', { status: 404 }) }
`

test('account Billing routes reuse HttpOnly login and enforce current Auth identity', async (t) => {
  const origin = 'https://auth.localhost'
  const shared = secret()
  const root = new URL('../rust/', import.meta.url)
  const modulePath = (path: string) => fileURLToPath(new URL(path, root))
  const auth = {
    compatibilityDate,
    modulesRoot: modulePath('.'),
    modules: [
      { type: 'ESModule' as const, path: modulePath('src/runtime/entrypoint.js') },
      { type: 'ESModule' as const, path: modulePath('src/runtime/internal-transport.js') },
      { type: 'ESModule' as const, path: modulePath('build/index.js') },
      { type: 'CompiledWasm' as const, path: modulePath('build/index_bg.wasm') },
    ],
    d1Databases: { DB: 'account-billing' },
    bindings: {
      MOLIS_ENVIRONMENT: 'test',
      MOLIS_INTERNAL_SECRET: shared,
      AUTH_ORIGIN: origin,
      AUTH_WEB_CLIENT_ID: 'molis-auth-web-local',
      AUTH_WEB_SESSION_KEY: secret(),
      AUTH_TEST_ADMISSION: JSON.stringify({
        emails: ['buyer@billing.example', 'other@billing.example'],
        phones: [],
      }),
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
        environmentId: 'unified-local',
        kind: 'TEST',
        authOrigin: origin,
        deliveryMode: 'MOCK',
        providerMode: 'MOCK',
      }),
    },
  }
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          ...auth,
          name: 'auth',
          serviceBindings: { BILLING: { name: 'billing-fixture', entrypoint: 'BillingInternal' } },
        },
        { ...auth, name: 'without-billing' },
        {
          name: 'billing-fixture',
          compatibilityDate,
          script: billingFixture,
          modules: true,
          bindings: { MOLIS_INTERNAL_SECRET: shared },
          serviceBindings: { AUTH: { name: 'auth', entrypoint: 'AuthInternal' } },
        },
      ],
    }),
  )
  t.after(() => mf.dispose())
  const db = await mf.getD1Database('DB', 'auth')
  const run = (sql: string, ...params: (string | number)[]) =>
    db
      .prepare(sql)
      .bind(...params)
      .run()
  await initializeLocalRuntime({ env: { DB: db } })
  await run("UPDATE auth_environment SET kind='TEST',auth_origin=?", origin)
  await run('UPDATE auth_client_policy SET allowed_origins=?', JSON.stringify([origin]))
  await run('UPDATE auth_client SET redirects=?', JSON.stringify([origin + '/account/callback']))

  const direct = await mf.getWorker('auth')
  const unavailable = await mf.getWorker('without-billing')
  type Browser = { cookie: string; csrf: string }
  async function call(
    browser: Browser,
    path: string,
    {
      body,
      method,
      rawBody,
      headers,
      upstream = direct,
    }: {
      body?: unknown
      rawBody?: string
      method?: string
      headers?: Record<string, string>
      upstream?: typeof direct
    } = {},
  ) {
    const response = await upstream.fetch(origin + '/api/account' + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        ...(browser.cookie ? { Cookie: browser.cookie } : {}),
        ...(browser.csrf ? { 'X-CSRF-Token': browser.csrf } : {}),
        ...(body !== undefined || rawBody !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...headers,
      },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    })
    const raw = await response.text()
    const reply = JSON.parse(raw)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
    assert.equal(response.headers.get('X-Molis-Internal-Secret'), null)
    assert.equal(response.headers.get('Authorization'), null)
    assert.equal(response.headers.get('X-Request-Id'), reply.requestId)
    assert.equal(raw.includes(shared), false)
    assert.doesNotMatch(raw, /accessToken|refreshToken|Bearer /)
    const cookie = response.headers.get('Set-Cookie')
    if (path.startsWith('/billing')) assert.equal(cookie, null)
    if (cookie) {
      assert.match(cookie, /; HttpOnly; SameSite=Lax;/)
      assert.match(cookie, /; Secure/)
      browser.cookie = cookie.split(';')[0]
    }
    browser.csrf = response.headers.get('X-CSRF-Token') ?? browser.csrf
    return { status: response.status, ...reply }
  }

  const expectError = async (response: ReturnType<typeof call>, status: number, code: string) => {
    const result = await response
    assert.equal(result.status, status)
    assert.equal(result.error.code, code)
    assert.equal(result.data, undefined)
    assert.equal(typeof result.error.message, 'string')
  }
  async function login(label: string) {
    const browser = { cookie: '', csrf: '' }
    assert.equal((await call(browser, '/session')).data.state, 'ANONYMOUS')
    const anonymousCookie = browser.cookie
    const sent = await call(browser, '/auth/verification-codes', {
      body: { purpose: 'LOGIN', channel: 'EMAIL', address: label + '@billing.example' },
    })
    assert.equal(sent.status, 200)
    const code = await db
      .prepare(
        'SELECT m.credential FROM auth_mock_delivery m JOIN auth_verification_challenge c ON c.delivery_id=m.delivery_id WHERE c.id=?',
      )
      .bind(sent.data.verificationId)
      .first('credential')
    const done = await call(browser, '/auth/login/code', {
      body: { verificationId: sent.data.verificationId, code },
    })
    assert.equal(done.status, 200)
    assert.equal(done.data.account.state, 'AUTHENTICATED')
    assert.notEqual(browser.cookie, anonymousCookie)
    return {
      browser,
      user: done.data.account.user.userId,
      login: done.data.account.session.loginSessionId,
    }
  }

  const balance = '/billing/credits/balance'
  const orders = '/billing/orders'
  const teamOne = '?product=WORK&ownerKind=TENANT&ownerId=team-one'
  const teamTwo = '?ownerKind=TENANT&ownerId=team-two'
  const anonymous = { cookie: '', csrf: '' }
  await expectError(call(anonymous, balance), 401, 'UNAUTHENTICATED')
  assert.equal((await call(anonymous, '/session')).data.state, 'ANONYMOUS')
  await expectError(call(anonymous, balance), 401, 'UNAUTHENTICATED')

  const { browser, user, login: loginId } = await login('buyer')
  const other = await login('other')
  const at = Date.now()
  for (const team of ['team-one', 'team-two']) {
    await run(
      "INSERT INTO auth_tenant(id,name,created_at,status,managed_by,managed_at,updated_at) VALUES (?,?,?,'ACTIVE',?,?,?)",
      team,
      team,
      at,
      user,
      at,
      at,
    )
    await run(
      "INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at) VALUES (?,?,?,?,'ACTIVE',?)",
      team + '-member',
      team,
      user,
      team === 'team-one' ? 'ADMIN' : 'MEMBER',
      at,
    )
  }
  const activity = () =>
    db
      .prepare('SELECT last_active_at FROM auth_login_session WHERE id=?')
      .bind(loginId)
      .first('last_active_at')
  const initialActivity = await activity()

  const self = await call(browser, balance)
  assert.match(self.requestId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(self.data, {
    product: 'WORK',
    ownerKind: 'USER',
    ownerId: user,
    available: 100,
    currentCreditPeriod: null,
  })
  const first = await call(browser, balance + teamOne, {
    headers: { 'X-Request-Id': 'browse.one', 'X-Molis-Internal-Secret': 'forged' },
  })
  assert.equal(first.requestId, 'browse.one')
  assert.equal(first.data.ownerId, 'team-one')
  assert.equal(first.data.available, 500)
  const second = await call(browser, balance + teamTwo)
  assert.equal(second.data.ownerId, 'team-two')
  assert.equal(second.data.available, 250)
  assert.equal((await call(browser, balance)).data.ownerId, user)
  assert.equal((await call(other.browser, balance)).data.ownerId, other.user)
  for (const path of ['/catalog/plans', '/subscriptions']) {
    const result = await call(browser, '/billing' + path + teamTwo, {
      headers: { 'X-Request-Id': 'invalid request id' },
    })
    assert.equal(result.data.path, '/api/v1' + path)
    assert.match(result.requestId, /^[0-9a-f-]{36}$/)
  }
  assert.deepEqual((await call(browser, '/billing/credits/ledger' + teamTwo + '&limit=3')).data, {
    items: [],
    nextCursor: null,
    limit: '3',
  })
  assert.equal(
    (await call(browser, '/billing/entitlements/check' + teamTwo, { body: {} })).data.path,
    '/api/v1/entitlements/check',
  )
  assert.equal(await activity(), initialActivity)
  assert.deepEqual(
    (await call(browser, orders + teamOne + '&limit=2&cursor=1700000000000%3Ao.1')).data,
    { items: [], nextCursor: '1700000000000:o.1', limit: '2' },
  )
  assert.equal(
    (await call(browser, orders + '/order.one' + teamOne)).data.path,
    '/api/v1/orders/order.one',
  )
  await expectError(call(browser, orders + teamTwo), 403, 'FORBIDDEN')
  await expectError(call(other.browser, balance + teamOne), 404, 'NOT_FOUND')
  await expectError(call(browser, balance + '?ownerId=' + other.user), 403, 'FORBIDDEN')

  const rawBody = '{"value": 1, "value": 2}'
  const rawQuery = 'future=a%2Fb&future=two'
  assert.deepEqual(
    (await call(browser, '/billing/future-resource?' + rawQuery, { method: 'PATCH', rawBody }))
      .data,
    { query: rawQuery, body: rawBody },
  )

  const body = { planId: 'work-team-test', interval: 'YEAR', billingTimeZone: 'Asia/Shanghai' }
  const purchase = {
    body,
    headers: { 'Idempotency-Key': 'order.one', 'X-Request-Id': 'request.one' },
  }
  const created = await call(browser, orders + teamOne, purchase)
  assert.equal(created.status, 201)
  assert.equal(created.requestId, 'request.one')
  assert.deepEqual(created.data, {
    ...body,
    id: 'order.one',
    requestId: 'request.one',
    product: 'WORK',
    ownerKind: 'TENANT',
    ownerId: 'team-one',
  })
  await expectError(call(browser, orders + teamTwo, purchase), 403, 'FORBIDDEN')
  await expectError(call(browser, orders + teamOne, { body }), 400, 'INVALID_REQUEST')
  await expectError(
    call(browser, orders + teamOne, {
      ...purchase,
      body: { ...body, actorUserId: other.user },
    }),
    400,
    'INVALID_REQUEST',
  )
  await expectError(
    call(browser, orders + teamOne, {
      ...purchase,
      body: { ...body, billingTimeZone: 'Invalid/Zone' },
    }),
    400,
    'INVALID_TIMEZONE',
  )
  for (const headers of [
    { 'X-CSRF-Token': '' },
    { 'X-CSRF-Token': other.browser.csrf },
    { Origin: 'https://untrusted.localhost' },
    { Origin: '' },
  ]) {
    await expectError(
      call(browser, orders + teamOne, {
        ...purchase,
        headers: { ...purchase.headers, ...headers },
      }),
      403,
      'FORBIDDEN',
    )
  }
  await expectError(
    call(browser, balance, { headers: { 'Sec-Fetch-Site': 'same-site' } }),
    403,
    'FORBIDDEN',
  )
  await expectError(
    call(browser, balance, { headers: { Authorization: 'Bearer ' + secret() } }),
    400,
    'INVALID_REQUEST',
  )
  await expectError(call(browser, balance + '?ownerKind=TENANT'), 400, 'INVALID_REQUEST')
  await expectError(call(browser, balance + teamOne + '&ownerId=team-two'), 400, 'INVALID_REQUEST')
  await expectError(call(browser, balance + '?limit=1'), 400, 'INVALID_REQUEST')
  await expectError(call(browser, '/billing/internal/v1/credits/holds', purchase), 404, 'NOT_FOUND')
  await expectError(call(browser, '/billing/internal/v1/audit-events'), 404, 'NOT_FOUND')
  await expectError(call(browser, '/billing/audit-events'), 404, 'NOT_FOUND')
  await expectError(call(browser, '/billing/credits/consume', purchase), 404, 'NOT_FOUND')
  await expectError(call(browser, '/billing/webhooks/mock', purchase), 404, 'NOT_FOUND')
  await expectError(call(browser, orders + '/order%2Fone'), 404, 'NOT_FOUND')
  await expectError(call(browser, balance, { method: 'OPTIONS' }), 405, 'METHOD_NOT_ALLOWED')

  const action = { method: 'POST', headers: { 'Idempotency-Key': 'action.one' } }
  assert.equal(
    (await call(browser, orders + '/order.active/mock-pay' + teamOne, action)).data.hadBody,
    false,
  )
  assert.equal(
    (await call(browser, orders + '/order.active/mock-pay' + teamOne, { ...action, body: {} })).data
      .hadBody,
    true,
  )
  await expectError(
    call(browser, orders + '/order.expired/mock-pay' + teamOne, action),
    409,
    'ORDER_EXPIRED',
  )
  await expectError(
    call(browser, orders + '/order.started/refund' + teamOne, action),
    409,
    'ORDER_NOT_REFUNDABLE',
  )

  await run("UPDATE auth_tenant_membership SET role='MEMBER' WHERE tenant_id='team-one'")
  await expectError(call(browser, orders + teamOne, purchase), 403, 'FORBIDDEN')
  assert.equal((await call(browser, balance + teamOne)).status, 200)
  await run(
    "UPDATE auth_tenant_membership SET status='LEFT',ended_at=? WHERE tenant_id='team-one'",
    at + 1,
  )
  await expectError(call(browser, balance + teamOne), 404, 'NOT_FOUND')
  assert.equal((await call(browser, balance + teamTwo)).status, 200)
  await run("UPDATE auth_tenant SET status='DISABLED' WHERE id='team-two'")
  await expectError(call(browser, balance + teamTwo), 403, 'TENANT_DISABLED')
  assert.equal((await call(browser, balance)).status, 200)

  await expectError(call(browser, balance, { upstream: unavailable }), 503, 'BILLING_UNAVAILABLE')
  for (const id of ['down', 'malformed', 'invalid-code']) {
    await expectError(call(browser, orders + '/' + id), 503, 'BILLING_UNAVAILABLE')
  }
  await expectError(call(browser, orders + '/auth-down'), 503, 'AUTH_UNAVAILABLE')
  const customError = await call(browser, orders + '/unknown')
  assert.equal(customError.status, 500)
  assert.deepEqual(customError.error, { code: 'UNDECLARED_CODE', message: 'A new upstream error' })
  assert.equal(
    (await call(browser, '/session', { upstream: unavailable })).data.state,
    'AUTHENTICATED',
  )
  assert.equal((await call(browser, '/tenants', { upstream: unavailable })).status, 200)

  await run('UPDATE auth_login_session SET revoked_at=? WHERE id=?', at, other.login)
  await expectError(call(other.browser, balance), 401, 'SESSION_EXPIRED')
  await expectError(call(other.browser, balance), 401, 'UNAUTHENTICATED')
  assert.equal(
    (
      await call(browser, '/logout', {
        body: { scope: 'CURRENT_LOGIN' },
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
    ).data.localCleared,
    true,
  )
  await expectError(call(browser, balance), 401, 'UNAUTHENTICATED')
})
