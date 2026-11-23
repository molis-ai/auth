import test from 'node:test'
import assert from 'node:assert/strict'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'

test('V2U-01 V2U-07 V2C-01 current pages retain security headers; removed V1 entries reject without effects', async () => {
  const origin = 'http://127.0.0.1:8787',
    p = await getRustProxy(
      { AUTH_ORIGIN: origin, MOLIS_LOCAL_GENERATION: 'fixture-health' },
      undefined,
      (r) => {
        const path = new URL(r.url).pathname
        return new Response(path === '/index.html' ? '<head></head>' + path : path, {
          headers: { 'Content-Type': 'text/html' },
        })
      },
    )
  try {
    const health = await p.fetch(new Request(origin + '/api/v2/health'))
    assert.equal(health.status, 200)
    assert.equal(health.headers.get('Cache-Control'), 'no-store')
    assert.equal((await health.json()).data.status, 'UP')
    assert.equal((await p.fetch(new Request(origin + '/api/v2/readiness'))).status, 503)
    await initializeLocalRuntime(p)
    assert.equal((await p.fetch(new Request(origin + '/api/v2/readiness'))).status, 200)
    await p.env.DB.prepare('DROP INDEX ix_logout_receipt_proof_expiry').run()
    assert.equal((await p.fetch(new Request(origin + '/api/v2/readiness'))).status, 503)
    assert.equal((await p.fetch(new Request(origin + '/api/v2/health'))).status, 200)
    for (const path of ['/', '/login', '/console']) {
      const r = await p.fetch(new Request(origin + path))
      assert.equal(r.status, 200)
      assert.equal(
        await r.text(),
        '<head><meta name="molis-tenant-invite-channels" content="USER"></head>/index.html',
      )
      assert.equal(r.headers.get('Cache-Control'), 'no-store')
      assert.equal(r.headers.get('X-Frame-Options'), 'DENY')
      assert.match(r.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/)
    }
    assert.equal(
      await (await p.fetch(new Request(origin + '/auth-ui/assets/test.js'))).text(),
      '/assets/test.js',
    )
    const before = await p.env.DB.prepare('SELECT count(*) n FROM auth_user').first()
    for (const path of [
      '/api/v1/health',
      '/api/v1/auth/transactions',
      '/api/v1/users/me',
      '/api/v1/spaces',
      '/api/v1/platform/applications',
      '/api/v1/authorization/check',
      '/api/v1/authorization/allowed-actions',
      '/api/v1/platform/services',
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
    for (const path of ['/complete', '/provider', '/console/callback'])
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
      const channels = deliveryMode === 'MOCK' ? 'EMAIL PHONE USER' : 'USER'
      assert.ok(
        (await r.text()).includes(`name="molis-tenant-invite-channels" content="${channels}"`),
      )
    }
  } finally {
    await p.dispose()
  }
})
