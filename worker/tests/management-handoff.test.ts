import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { validateNamed } from '../../contracts/unified-account/validate.ts'
import { captureAuthFailures, challenge, hash, secret } from './fixtures.ts'

const origin = 'http://127.0.0.1:8787'
const redirectUri = 'http://127.0.0.1:4207/account/callback'
const api = '/api/v1/auth/management-handoffs'
const lifetime = 90 * 86_400_000

function cookie(response: Response, name: string) {
  const matches = response.headers.getSetCookie().filter((line) => line.startsWith(name + '='))
  assert.equal(matches.length, 1, name)
  assert.match(matches[0], /; HttpOnly; SameSite=Lax;/)
  return { pair: matches[0].split(';')[0], header: matches[0] }
}

function cookieHash(pair: string) {
  return hash(pair.slice(pair.indexOf('=') + 1))
}

async function success(response: Response, schema: string) {
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.ok(validateNamed(schema, body.data), schema)
  return body.data
}

async function apiError(response: Response, status: number, code: string) {
  const body = await response.json()
  assert.equal(response.status, status, JSON.stringify(body))
  assert.equal(body.error.code, code)
  assert.ok(body.requestId)
  assert.deepEqual(response.headers.getSetCookie(), [])
}

async function rejectedNavigation(response: Response) {
  assert.equal(response.status, 400)
  assert.match(response.headers.get('Content-Type') ?? '', /^text\/html\b/)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get('Location'), null)
  assert.deepEqual(response.headers.getSetCookie(), [])
  assert.match(await response.text(), /暂时无法打开账号管理/)
}

async function fixture(t: TestContext) {
  const failures = captureAuthFailures()
  const proxy = await getRustProxy(
    {
      AUTH_ORIGIN: origin,
      AUTH_WEB_SESSION_KEY: secret(),
      AUTH_WEB_CLIENT_ID: 'auth-web',
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
    failures,
  )
  t.after(() => proxy.dispose())
  await initializeLocalRuntime(proxy)
  const db = proxy.env.DB
  for (const sql of readFileSync(
    new URL('../unified-account-local-seed.sql', import.meta.url),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)) {
    await db.prepare(sql).run()
  }
  await db
    .prepare(
      "INSERT INTO auth_client(id,client_id,application_id,client_type,redirects,environment_id,allowed_origins) VALUES ('auth-web','auth-web','molis-work-unified-local-app','WEB',?,'unified-local',?)",
    )
    .bind(JSON.stringify([origin + '/account/callback']), JSON.stringify([origin]))
    .run()

  async function source(account = crypto.randomUUID()) {
    const id = crypto.randomUUID()
    const bearer = secret()
    const now = Date.now()
    const authenticated = now - 8 * 86_400_000 - 321
    const verified = authenticated + 123_456
    await db
      .prepare(
        "INSERT OR IGNORE INTO auth_user(id,display_name,status,avatar_data,created_at,updated_at) VALUES (?,?,'ACTIVE',NULL,?,?)",
      )
      .bind(account, 'Handoff User', authenticated, authenticated)
      .run()
    await db
      .prepare('UPDATE auth_user SET session_epoch=3,updated_at=? WHERE id=?')
      .bind(now, account)
      .run()
    const sequence = await db
      .prepare(
        "INSERT INTO auth_security_sequence(kind,created_at) VALUES ('TRANSACTION',?) RETURNING seq",
      )
      .bind(authenticated)
      .first()
    assert.ok(sequence)
    await db
      .prepare(
        "INSERT INTO auth_login_session(id,user_id,client_id,authenticated_at,last_active_at,absolute_expires_at,user_epoch,created_seq,identity_verified_at) VALUES (?,?,'molis-work-unified-local',?,?,?,?,?,?)",
      )
      .bind(id, account, authenticated, now, authenticated + lifetime, 3, sequence.seq, verified)
      .run()
    await db
      .prepare('INSERT INTO auth_login_access_token VALUES (?,?,0,3,?)')
      .bind(hash(bearer), id, now + 900_000)
      .run()
    return { id, account, bearer }
  }

  function post(path: string, bearer: string, body: unknown) {
    return proxy.fetch(
      new Request(origin + path, {
        method: 'POST',
        headers: {
          Origin: 'http://127.0.0.1:4207',
          Authorization: 'Bearer ' + bearer,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    )
  }

  function navigate(path: string, cookies?: string, bearer?: string) {
    const url = new URL(path, origin)
    assert.equal(url.origin, origin)
    const headers = new Headers({ 'Sec-Fetch-Mode': 'navigate' })
    if (cookies) headers.set('Cookie', cookies)
    if (bearer) headers.set('Authorization', 'Bearer ' + bearer)
    return proxy.fetch(new Request(url, { headers }))
  }

  async function create(bearer: string) {
    const proof = secret()
    const data = await success(
      await post(api, bearer, {
        redirectUri,
        initiatorChallenge: challenge(proof),
      }),
      'ManagementHandoffView',
    )
    return { id: data.handoffId as string, startUrl: data.redirectUrl as string, proof }
  }

  async function start(path: string) {
    const response = await navigate(path)
    assert.equal(response.status, 303)
    return { response, bound: cookie(response, 'molis-auth-handoff').pair }
  }

  function approve(id: string, proof: string, bearer: string) {
    return post(api + '/approve', bearer, { handoffId: id, initiatorProof: proof })
  }

  async function approved(bearer: string) {
    const handoff = await create(bearer)
    const { bound } = await start(handoff.startUrl)
    const approval = await success(
      await approve(handoff.id, handoff.proof, bearer),
      'ManagementHandoffView',
    )
    assert.equal(approval.handoffId, handoff.id)
    return { ...handoff, bound, finishUrl: approval.redirectUrl as string }
  }

  function row(id: string) {
    return db.prepare('SELECT * FROM auth_management_handoff WHERE id=?').bind(id).first()
  }

  async function targetCounts() {
    const counts = await db
      .prepare(
        `SELECT
      (SELECT count(*) FROM auth_login_session WHERE client_id='auth-web') sessions,
      (SELECT count(*) FROM auth_login_access_token t JOIN auth_login_session s ON s.id=t.login_session_id WHERE s.client_id='auth-web') access,
      (SELECT count(*) FROM auth_login_refresh_token t JOIN auth_login_session s ON s.id=t.login_session_id WHERE s.client_id='auth-web') refresh,
      (SELECT count(*) FROM auth_management_audit WHERE operation='account.management-handoff' AND outcome='SUCCESS') audits,
      (SELECT count(*) FROM auth_web_session) web`,
      )
      .first()
    assert.ok(counts)
    return counts
  }

  async function session(webCookie: string) {
    return success(await navigate('/api/account/session', webCookie), 'AccountView')
  }

  return {
    db,
    failures,
    source,
    post,
    create,
    start,
    approve,
    approved,
    navigate,
    row,
    targetCounts,
    session,
  }
}

test('management handoff completes all four steps and the browser inherits the source user', async (t) => {
  const f = await fixture(t)
  const source = await f.source()
  const before = Date.now()
  const handoff = await f.create(source.bearer)
  const after = Date.now()
  assert.equal(handoff.startUrl, origin + '/account/handoff/start?id=' + handoff.id)
  const pending = await f.row(handoff.id)
  assert.ok(pending && Number(pending.expires_at) >= before + 60_000)
  assert.ok(Number(pending.expires_at) <= after + 60_000)
  const { response, bound } = await f.start(handoff.startUrl)
  assert.equal(response.headers.get('Location'), redirectUri + '?handoff=' + handoff.id)
  assert.match(cookie(response, 'molis-auth-handoff').header, /; Max-Age=60$/)
  const approval = await success(
    await f.approve(handoff.id, handoff.proof, source.bearer),
    'ManagementHandoffView',
  )
  const finishUrl = new URL(approval.redirectUrl)
  assert.equal(finishUrl.pathname, '/account/handoff/finish')
  assert.equal(finishUrl.searchParams.get('id'), handoff.id)
  assert.ok(finishUrl.searchParams.get('code'))
  const finished = await f.navigate(finishUrl.href, bound)
  assert.equal(finished.status, 303)
  assert.equal(finished.headers.get('Location'), origin + '/')
  assert.equal(finished.headers.getSetCookie().length, 2)
  const web = cookie(finished, 'molis-auth-web')
  assert.match(
    cookie(finished, 'molis-auth-handoff').header,
    /^molis-auth-handoff=; .*; Max-Age=0$/,
  )
  const account = await f.session(web.pair)
  assert.equal(account.state, 'AUTHENTICATED')
  assert.equal(account.user.userId, source.account)
  assert.equal(account.session.clientId, 'auth-web')
  assert.notEqual(account.session.loginSessionId, source.id)
})

test('management handoff start, approve and concurrent finish consume exactly once', async (t) => {
  const f = await fixture(t)
  const source = await f.source()
  const handoff = await f.approved(source.bearer)
  await rejectedNavigation(await f.navigate(handoff.startUrl))
  await apiError(await f.approve(handoff.id, handoff.proof, source.bearer), 403, 'FORBIDDEN')
  assert.deepEqual(await f.targetCounts(), {
    sessions: 0,
    access: 0,
    refresh: 0,
    audits: 0,
    web: 0,
  })
  const finished = await Promise.all([
    f.navigate(handoff.finishUrl, handoff.bound),
    f.navigate(handoff.finishUrl, handoff.bound),
  ])
  assert.deepEqual(finished.map((response) => response.status).sort(), [303, 400])
  await rejectedNavigation(finished.find((response) => response.status === 400)!)
  assert.equal(
    finished.find((response) => response.status === 303)!.headers.getSetCookie().length,
    2,
  )
  await rejectedNavigation(await f.navigate(handoff.finishUrl, handoff.bound))
  assert.ok((await f.row(handoff.id))?.consumed_at)
  assert.deepEqual(await f.targetCounts(), {
    sessions: 1,
    access: 1,
    refresh: 1,
    audits: 1,
    web: 1,
  })
})

test('management handoff refuses source revocation and revision changes without consumption', async (t) => {
  const f = await fixture(t)
  const source = await f.source()
  const handoff = await f.create(source.bearer)
  await f.start(handoff.startUrl)
  await f.db
    .prepare('UPDATE auth_login_session SET revoked_at=? WHERE id=?')
    .bind(Date.now(), source.id)
    .run()
  await apiError(await f.approve(handoff.id, handoff.proof, source.bearer), 401, 'SESSION_EXPIRED')
  const unapproved = await f.row(handoff.id)
  assert.equal(unapproved?.code_hash, null)
  assert.equal(unapproved?.consumed_at, null)

  for (const update of [
    'UPDATE auth_login_session SET revoked_at=? WHERE id=?',
    'UPDATE auth_login_session SET session_revision=? WHERE id=?',
  ]) {
    const active = await f.source()
    const approved = await f.approved(active.bearer)
    await f.db
      .prepare(update)
      .bind(update.includes('revoked_at') ? Date.now() : 1, active.id)
      .run()
    await rejectedNavigation(await f.navigate(approved.finishUrl, approved.bound))
    assert.equal((await f.row(approved.id))?.consumed_at, null)
    assert.deepEqual(await f.targetCounts(), {
      sessions: 0,
      access: 0,
      refresh: 0,
      audits: 0,
      web: 0,
    })
  }
})

test('management handoff rotates a previous browser identity and clears the binding cookie', async (t) => {
  const f = await fixture(t)
  const previous = await f.source()
  const first = await f.approved(previous.bearer)
  const oldWeb = cookie(await f.navigate(first.finishUrl, first.bound), 'molis-auth-web')
  assert.equal((await f.session(oldWeb.pair)).user.userId, previous.account)
  const next = await f.source()
  const second = await f.approved(next.bearer)
  const finished = await f.navigate(second.finishUrl, oldWeb.pair + '; ' + second.bound)
  assert.equal(finished.status, 303)
  assert.equal(finished.headers.getSetCookie().length, 2)
  const newWeb = cookie(finished, 'molis-auth-web')
  assert.notEqual(newWeb.pair, oldWeb.pair)
  assert.match(
    cookie(finished, 'molis-auth-handoff').header,
    /^molis-auth-handoff=; .*; Max-Age=0$/,
  )
  const webRow = (pair: string) =>
    f.db.prepare('SELECT * FROM auth_web_session WHERE id_hash=?').bind(cookieHash(pair)).first()
  assert.equal(await webRow(oldWeb.pair), null)
  assert.ok(await webRow(newWeb.pair))
  assert.equal((await f.session(newWeb.pair)).user.userId, next.account)
  const oldJar = await f.session(oldWeb.pair)
  assert.equal(oldJar.state, 'ANONYMOUS')
  assert.equal(oldJar.user, undefined)
})

test('management handoff inherits authentication age, verification, epoch, sequence and expiry', async (t) => {
  const f = await fixture(t)
  const source = await f.source()
  const handoff = await f.approved(source.bearer)
  const finished = await f.navigate(handoff.finishUrl, handoff.bound)
  assert.equal(finished.status, 303)
  const web = cookie(finished, 'molis-auth-web')
  const fields = 'authenticated_at,identity_verified_at,absolute_expires_at,user_epoch,created_seq'
  const original = await f.db
    .prepare('SELECT ' + fields + ' FROM auth_login_session WHERE id=?')
    .bind(source.id)
    .first()
  assert.ok(original)
  assert.equal(Number(original.absolute_expires_at) - Number(original.authenticated_at), lifetime)
  assert.ok(Date.now() - Number(original.authenticated_at) > 7 * 86_400_000)
  assert.ok(Number(original.identity_verified_at) > Number(original.authenticated_at))
  const target = await f.db
    .prepare('SELECT ' + fields + " FROM auth_login_session WHERE client_id='auth-web'")
    .first()
  assert.deepEqual(target, original)
  const row = await f.db
    .prepare('SELECT expires_at FROM auth_web_session WHERE id_hash=?')
    .bind(cookieHash(web.pair))
    .first()
  assert.equal(row?.expires_at, original.absolute_expires_at)
  const consumedAt = (await f.row(handoff.id))?.consumed_at
  assert.equal(typeof consumedAt, 'number')
  const remaining = Number(original.absolute_expires_at) - Number(consumedAt)
  assert.equal(Number(/; Max-Age=(\d+)$/.exec(web.header)?.[1]), Math.floor(remaining / 1000))
})

test('management handoff rejects tampering and expiry without consuming or creating sessions', async (t) => {
  const f = await fixture(t)
  const source = await f.source()
  const other = await f.source(source.account)
  await apiError(
    await f.post(api, source.bearer, {
      redirectUri: 'http://127.0.0.1:4207/unregistered',
      initiatorChallenge: challenge(secret()),
    }),
    403,
    'FORBIDDEN',
  )
  assert.equal((await f.db.prepare('SELECT count(*) n FROM auth_management_handoff').first())?.n, 0)
  const h = await f.create(source.bearer)
  const original = await f.row(h.id)
  await apiError(await f.approve(h.id, h.proof, source.bearer), 403, 'FORBIDDEN')
  for (const [path, bearer] of [
    [h.startUrl + '&id=' + h.id, undefined],
    [h.startUrl + '&extra=1', undefined],
    [h.startUrl, source.bearer],
  ]) {
    await rejectedNavigation(await f.navigate(path!, undefined, bearer))
    assert.deepEqual(await f.row(h.id), original)
  }
  const { bound } = await f.start(h.startUrl)
  const started = await f.row(h.id)
  await apiError(await f.approve(h.id, h.proof, other.bearer), 403, 'FORBIDDEN')
  await apiError(await f.approve(h.id, secret(), source.bearer), 403, 'FORBIDDEN')
  assert.deepEqual(await f.row(h.id), started)
  const approval = await success(
    await f.approve(h.id, h.proof, source.bearer),
    'ManagementHandoffView',
  )
  const url = new URL(approval.redirectUrl)
  const absent = new URL(url)
  absent.searchParams.delete('code')
  const wrong = new URL(url)
  wrong.searchParams.set('code', secret())
  const snapshot = await f.row(h.id)
  assert.equal(snapshot?.consumed_at, null)
  for (const [path, cookies, bearer] of [
    [absent.href, bound, undefined],
    [wrong.href, bound, undefined],
    [url.href, undefined, undefined],
    [url.href, 'molis-auth-handoff=' + secret(), undefined],
    [url.href, bound + '; ' + bound, undefined],
    [url.href + '&code=' + url.searchParams.get('code'), bound, undefined],
    [url.href + '&extra=1', bound, undefined],
    [url.href, bound, source.bearer],
  ]) {
    await rejectedNavigation(await f.navigate(path!, cookies, bearer))
    assert.deepEqual(await f.row(h.id), snapshot)
    assert.deepEqual(await f.targetCounts(), {
      sessions: 0,
      access: 0,
      refresh: 0,
      audits: 0,
      web: 0,
    })
  }

  const expired = await f.create(source.bearer)
  await f.db
    .prepare('UPDATE auth_management_handoff SET expires_at=expires_at-60000 WHERE id IN (?,?)')
    .bind(h.id, expired.id)
    .run()
  await rejectedNavigation(await f.navigate(expired.startUrl))
  await apiError(await f.approve(expired.id, expired.proof, source.bearer), 401, 'INVALID_GRANT')
  await rejectedNavigation(await f.navigate(url.href, bound))
  assert.equal((await f.row(h.id))?.consumed_at, null)
  const expiredRow = await f.row(expired.id)
  assert.equal(expiredRow?.browser_hash, null)
  assert.equal(expiredRow?.code_hash, null)
  assert.equal(expiredRow?.consumed_at, null)
  assert.deepEqual(await f.targetCounts(), {
    sessions: 0,
    access: 0,
    refresh: 0,
    audits: 0,
    web: 0,
  })
})

test('management handoff distinguishes an invalid link from a D1 outage', async (t) => {
  const f = await fixture(t)
  await rejectedNavigation(await f.navigate('/account/handoff/start?id=missing'))
  const source = await f.source()
  const handoff = await f.approved(source.bearer)
  await f.db.prepare('DROP TABLE auth_management_handoff').run()
  const response = await f.navigate(handoff.finishUrl, handoff.bound)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.match(response.headers.get('Content-Type') ?? '', /^text\/html\b/)
  assert.match(await response.text(), /服务暂时不可用/)
  const logs = await f.failures.forRequest(response.headers.get('X-Request-ID')!, [
    'd1.first',
    'handoff.browser',
  ])
  assert.ok(
    logs.every(({ route, status }) => route === '/account/handoff/finish' && status === 503),
  )
  for (const value of [
    handoff.id,
    handoff.bound,
    new URL(handoff.finishUrl).searchParams.get('code')!,
    source.bearer,
  ]) {
    assert.equal(JSON.stringify(logs).includes(value), false)
  }
})
