import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'

test('AUTH-U-01 AUTH-U-07 AUTH-C-01 current pages retain security headers; retired entries reject without effects', async () => {
  const origin = 'http://127.0.0.1:8787',
    p = await getRustProxy(
      { AUTH_ORIGIN: origin, MOLIS_LOCAL_GENERATION: 'fixture-health' },
      undefined,
      (r) => {
        const path = new URL(r.url).pathname
        return new Response(path === '/account/index.html' ? '<head></head>' + path : path, {
          headers: { 'Content-Type': 'text/html', 'CF-Cache-Status': 'HIT' },
        })
      },
    )
  try {
    const health = await p.fetch(new Request(origin + '/api/v1/health'))
    assert.equal(health.status, 200)
    assert.equal(health.headers.get('Cache-Control'), 'no-store')
    assert.equal((await health.json()).data.status, 'UP')
    assert.equal((await p.fetch(new Request(origin + '/api/v1/readiness'))).status, 503)
    await initializeLocalRuntime(p)
    assert.equal((await p.fetch(new Request(origin + '/api/v1/readiness'))).status, 200)
    await p.env.DB.prepare('DROP INDEX ix_logout_receipt_proof_expiry').run()
    assert.equal((await p.fetch(new Request(origin + '/api/v1/readiness'))).status, 503)
    assert.equal((await p.fetch(new Request(origin + '/api/v1/health'))).status, 200)
    const retired = '/api/v' + 2
    for (const path of ['/', '/login', '/console']) {
      const r = await p.fetch(new Request(origin + path))
      assert.equal(r.status, 200)
      assert.equal(
        await r.text(),
        '<head><meta name="molis-tenant-invite-channels" content="EMAIL"></head>/account/index.html',
      )
      assert.equal(r.headers.get('Cache-Control'), 'no-store')
      assert.equal(r.headers.get('CF-Cache-Status'), null)
      assert.equal(r.headers.get('X-Frame-Options'), 'DENY')
      assert.match(r.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/)
    }
    const before = await p.env.DB.prepare('SELECT count(*) n FROM auth_user').first()
    for (const path of [
      retired + '/health',
      retired + '/auth/transactions',
      retired + '/users/me',
      retired + '/spaces',
      retired + '/platform/applications',
      retired + '/authorization/check',
      retired + '/authorization/allowed-actions',
      retired + '/platform/services',
      '/oauth2/token',
      '/oauth2/callback/apple',
      '/.well-known/openid-configuration',
    ])
      for (const method of ['GET', 'POST', 'PUT', 'OPTIONS']) {
        const r = await p.fetch(
          new Request(origin + path, {
            method,
            headers: {
              Origin: origin,
              'Content-Type': 'application/json',
              Authorization: 'Bearer synthetic-retired-token',
            },
            ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}),
          }),
        )
        assert.equal(r.status, 404, method + ' ' + path)
        assert.equal((await r.json()).error.code, 'NOT_FOUND')
      }
    for (const path of ['/complete', '/provider', '/console/callback', '/auth-ui/index.html'])
      assert.equal((await p.fetch(new Request(origin + path))).status, 404)
    assert.deepEqual(await p.env.DB.prepare('SELECT count(*) n FROM auth_user').first(), before)
    for (const name of ['auth_service', 'auth_service_token'])
      assert.equal(
        await p.env.DB.prepare('SELECT name FROM sqlite_schema WHERE name=?').bind(name).first(),
        null,
      )
    for (const deliveryMode of ['MOCK', 'LIVE']) {
      await p.updateBindings({
        UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
          environmentId: 'unified-local',
          kind: 'LOCAL',
          authOrigin: origin,
          deliveryMode,
          providerMode: 'MOCK',
        }),
      })
      const r = await p.fetch(new Request(origin + '/console'))
      const channels = deliveryMode === 'MOCK' ? 'EMAIL PHONE' : 'EMAIL'
      assert.ok(
        (await r.text()).includes(`name="molis-tenant-invite-channels" content="${channels}"`),
      )
    }
  } finally {
    await p.dispose()
  }
})

test('Assets serve hashed files with security headers and native conditional requests', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'auth-route-assets-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const assets = join(directory, 'auth-ui/assets')
  mkdirSync(assets, { recursive: true })
  copyFileSync(new URL('../../web/public/_headers', import.meta.url), join(directory, '_headers'))
  mkdirSync(join(directory, 'account'))
  writeFileSync(join(directory, 'account/index.html'), '<head></head><body>Auth UI</body>')
  writeFileSync(join(assets, 'index-Abcd_123.js'), 'export {}')
  writeFileSync(join(assets, 'index-Abcd_123.css'), 'body {}')
  const origin = 'http://127.0.0.1:8787'
  const proxy = await getRustProxy(
    { AUTH_ORIGIN: origin, MOLIS_ENVIRONMENT: 'dev' },
    undefined,
    undefined,
    { assetsDirectory: directory },
  )
  t.after(() => proxy.dispose())

  for (const method of ['GET', 'HEAD']) {
    for (const [path, get, head, cache, type, entity] of [
      [
        '/auth-ui/assets/index-Abcd_123.js',
        200,
        200,
        'public, max-age=31536000, immutable',
        /javascript/,
        'export {}',
      ],
      [
        '/auth-ui/assets/index-Abcd_123.css',
        200,
        200,
        'public, max-age=31536000, immutable',
        /text\/css/,
        'body {}',
      ],
      ['/auth-ui/assets/missing-Abcd_123.js', 404, 404, 'no-store', null, null],
      ['/', 200, 200, 'no-store', /text\/html/, null],
      ['/console', 200, 200, 'no-store', /text\/html/, null],
      ['/account/index.html', 404, 404, 'no-store', /application\/json/, null],
      ['/login', 200, 200, 'no-store', /text\/html/, null],
      ['/auth-ui/index.html', 404, 404, 'no-store', /application\/json/, null],
      ['/index.html', 404, 404, 'no-store', /application\/json/, null],
      ['/api/v1/health', 200, 501, 'no-store', /application\/json/, null],
    ] as const) {
      const response = await proxy.fetch(new Request(origin + path, { method }))
      const label = `${method} ${path}`
      assert.equal(response.status, method === 'GET' ? get : head, label)
      const edge = path.startsWith('/auth-ui/assets/') && entity !== null
      assert.equal(response.headers.has('X-Request-ID'), !edge, label)
      assert.equal(response.headers.get('Cache-Control'), cache, label)
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', label)
      assert.equal(response.headers.get('X-Frame-Options'), 'DENY', label)
      assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer', label)
      assert.match(
        response.headers.get('Content-Security-Policy') ?? '',
        /frame-ancestors 'none'/,
        label,
      )
      assert.equal(
        response.headers.get('Strict-Transport-Security'),
        edge ? 'max-age=31536000' : null,
        label,
      )
      if (type) assert.match(response.headers.get('Content-Type') ?? '', type, label)
      const body = await response.text()
      if (method === 'HEAD') assert.equal(body, '', label)
      else if (entity !== null) assert.equal(body, entity, label)
      if (method === 'GET' && ['/', '/login', '/console'].includes(path)) {
        assert.match(body, /<meta name="molis-tenant-invite-channels" content="EMAIL">/, label)
        assert.match(body, /<meta name="molis-environment" content="DEV · 本地数据">/, label)
        assert.equal(response.headers.get('CF-Cache-Status'), null, label)
      }
      t.diagnostic(`${label} ${response.status}; Worker calls: ${edge ? 0 : 1}`)
    }

    const alias = await proxy.fetch(
      new Request('http://localhost:8787/login?from=alias', { method }),
    )
    assert.equal(alias.status, 302)
    assert.equal(alias.headers.get('Location'), origin + '/login?from=alias')
    assert.equal(alias.headers.get('Cache-Control'), 'no-store')
    assert.equal(alias.headers.get('X-Frame-Options'), 'DENY')
    assert.ok(alias.headers.has('X-Request-ID'))
    assert.equal(await alias.text(), '')
    t.diagnostic(`${method} /login on alias ${alias.status}; Worker called`)
  }

  const asset = origin + '/auth-ui/assets/index-Abcd_123.js'
  const first = await proxy.fetch(new Request(asset))
  const etag = first.headers.get('ETag')
  assert.ok(etag)
  const conditional = await proxy.fetch(new Request(asset, { headers: { 'If-None-Match': etag } }))
  assert.equal(conditional.status, 304)
  assert.equal(conditional.headers.has('X-Request-ID'), false)
  assert.equal(await conditional.text(), '')
  t.diagnostic('GET with If-None-Match: 304; Worker calls: 0')
  const range = await proxy.fetch(new Request(asset, { headers: { Range: 'bytes=0-2' } }))
  // Cloudflare Static Assets do not implement byte ranges.
  assert.equal(range.status, 200)
  assert.equal(range.headers.get('Content-Range'), null)
  assert.equal(range.headers.has('X-Request-ID'), false)
  assert.equal(await range.text(), 'export {}')
  t.diagnostic('GET with Range: full 200 response per Static Assets; Worker calls: 0')
  const write = await proxy.fetch(new Request(asset, { method: 'POST', body: '{}' }))
  assert.equal(write.status, 405)
  assert.equal(write.headers.has('X-Request-ID'), false)
  t.diagnostic('POST existing asset: native 405; Worker calls: 0')
})
