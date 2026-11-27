import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'

test('V2U-01 V2U-07 V2C-01 current pages retain security headers; retired entries reject without effects', async () => {
  const origin = 'http://127.0.0.1:8787',
    p = await getRustProxy(
      { AUTH_ORIGIN: origin, MOLIS_LOCAL_GENERATION: 'fixture-health' },
      undefined,
      (r) => {
        const path = new URL(r.url).pathname
        return new Response(path === '/index.html' ? '<head></head>' + path : path, {
          headers: { 'Content-Type': path === '/index.html' ? 'text/html' : 'text/javascript' },
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
    for (const path of ['/', '/login', '/console']) {
      const r = await p.fetch(new Request(origin + path))
      assert.equal(r.status, 200)
      assert.equal(
        await r.text(),
        '<head><meta name="molis-tenant-invite-channels" content="EMAIL"></head>/index.html',
      )
      assert.equal(r.headers.get('Cache-Control'), 'no-store')
      assert.equal(r.headers.get('X-Frame-Options'), 'DENY')
      assert.match(r.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/)
    }
    assert.equal(
      await (await p.fetch(new Request(origin + '/auth-ui/assets/test.js'))).text(),
      '/auth-ui/assets/test.js',
    )
    const before = await p.env.DB.prepare('SELECT count(*) n FROM auth_user').first()
    for (const path of [
      '/api/v2/health',
      '/api/v2/auth/transactions',
      '/api/v2/users/me',
      '/api/v2/spaces',
      '/api/v2/platform/applications',
      '/api/v2/authorization/check',
      '/api/v2/authorization/allowed-actions',
      '/api/v2/platform/services',
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

test('P0-5 only successful hashed Vite assets are immutable', async () => {
  const origin = 'http://127.0.0.1:8787'
  const revalidate = 'public, max-age=0, must-revalidate'
  const p = await getRustProxy({ AUTH_ORIGIN: origin }, undefined, (request) => {
    const path = new URL(request.url).pathname
    const status = path.startsWith('/auth-ui/assets/missing-')
      ? 404
      : path.startsWith('/auth-ui/assets/partial-')
        ? 206
        : 200
    const type = path.startsWith('/auth-ui/assets/fallback-')
      ? 'text/html; charset=utf-8'
      : path.endsWith('.css')
        ? 'text/css'
        : path.endsWith('.png')
          ? 'image/png'
          : 'text/javascript; charset=utf-8'
    return new Response(request.method === 'HEAD' ? null : path, {
      status,
      headers: { 'Content-Type': type, 'Cache-Control': revalidate },
    })
  })
  try {
    for (const method of ['GET', 'HEAD']) {
      for (const [asset, status, cache] of [
        ['index-CWLYDLyw.js', 200, 'public, max-age=31536000, immutable'],
        ['TenantPage-D_MFHYQ-.css', 200, 'public, max-age=31536000, immutable'],
        ['molis-logo-CkY8qvMq.png', 200, 'public, max-age=31536000, immutable'],
        ['test.js', 200, revalidate],
        ['test-short.js', 200, revalidate],
        ['partial-CWLYDLyw.js', 206, revalidate],
        ['missing-CWLYDLyw.js', 404, 'no-store'],
        ['fallback-CWLYDLyw.js', 404, 'no-store'],
      ]) {
        const response = await p.fetch(new Request(origin + '/auth-ui/assets/' + asset, { method }))
        assert.equal(response.status, status, method + ' ' + asset)
        assert.equal(response.headers.get('Cache-Control'), cache, method + ' ' + asset)
        assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
      }
    }
  } finally {
    await p.dispose()
  }
})

test('the real Assets router preserves hashed asset responses and the Worker method contract', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'auth-route-assets-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const assets = join(directory, 'auth-ui/assets')
  mkdirSync(assets, { recursive: true })
  copyFileSync(new URL('../../web/public/_headers', import.meta.url), join(directory, '_headers'))
  writeFileSync(join(directory, 'index.html'), '<head></head><body>Auth UI</body>')
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
      ['/login', 200, 200, 'no-store', /text\/html/, null],
      ['/auth-ui/index.html', 404, 404, 'no-store', /application\/json/, null],
      ['/index.html', 404, 404, 'no-store', /application\/json/, null],
      ['/api/v1/health', 200, 501, 'no-store', /application\/json/, null],
    ] as const) {
      const response = await proxy.fetch(new Request(origin + path, { method }))
      const label = `${method} ${path}`
      assert.equal(response.status, method === 'GET' ? get : head, label)
      assert.ok(response.headers.get('X-Request-ID'), label)
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
        path.startsWith('/auth-ui/assets/') ? 'max-age=31536000' : null,
        label,
      )
      if (type) assert.match(response.headers.get('Content-Type') ?? '', type, label)
      const body = await response.text()
      if (method === 'HEAD') assert.equal(body, '', label)
      else if (entity !== null) assert.equal(body, entity, label)
      if (method === 'GET' && path === '/login') {
        assert.match(body, /<meta name="molis-tenant-invite-channels" content="EMAIL">/, label)
        assert.match(body, /<meta name="molis-environment" content="DEV · 本地数据">/, label)
      }
      t.diagnostic(`${label} ${response.status}; Worker called`)
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

  for (const [method, asset] of [
    ['POST', 'index-Abcd_123.js'],
    ['POST', 'index-Abcd_123.css'],
    ['PUT', 'index-Abcd_123.js'],
    ['PATCH', 'index-Abcd_123.js'],
    ['DELETE', 'index-Abcd_123.js'],
    ['OPTIONS', 'index-Abcd_123.js'],
    ['REPORT', 'index-Abcd_123.js'],
    ['PROPFIND', 'index-Abcd_123.js'],
    ['MKCOL', 'index-Abcd_123.js'],
    ['POST', 'missing-Abcd_123.js'],
  ]) {
    const path = `/auth-ui/assets/${asset}`
    const label = `${method} ${path}`
    const response = await proxy.fetch(
      new Request(origin + path, { method, body: method === 'POST' ? '{}' : undefined }),
    )
    assert.equal(response.status, 405, label)
    assert.match(response.headers.get('Content-Type') ?? '', /application\/json/, label)
    assert.equal(response.headers.get('Cache-Control'), 'no-store', label)
    const requestId = response.headers.get('X-Request-ID')
    assert.ok(requestId, label)
    assert.deepEqual(
      await response.json(),
      { error: { code: 'METHOD_NOT_ALLOWED' }, requestId },
      label,
    )
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', label)
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY', label)
    t.diagnostic(`${label} 405 METHOD_NOT_ALLOWED; Worker called`)
  }
})
