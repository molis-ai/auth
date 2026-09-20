import test from 'node:test'
import assert from 'node:assert/strict'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'

test('Rust routes: static aliases, protected APIs, disabled mail and security headers', async () => {
  const origin = 'http://127.0.0.1:8787'
  const proxy = await getRustProxy(
    { AUTH_ORIGIN: origin },
    undefined,
    (request: Request) =>
      new Response(new URL(request.url).pathname, { headers: { 'Content-Type': 'text/html' } }),
  )
  try {
    const failed = await proxy.fetch(new Request(origin + '/api/v1/health'))
    assert.equal(failed.status, 503)
    assert.equal((await failed.json()).error.code, 'AUTH_UNAVAILABLE')
    await initializeLocalRuntime(proxy)
    for (const path of ['/login', '/console', '/complete', '/console/callback']) {
      const page = await proxy.fetch(new Request(origin + path))
      assert.equal(page.status, 200)
      assert.equal(await page.text(), '/index.html')
      assert.equal(page.headers.get('Cache-Control'), 'no-store')
      assert.equal(page.headers.get('X-Frame-Options'), 'DENY')
    }
    assert.equal(
      await (await proxy.fetch(new Request(origin + '/auth-ui/assets/test.js'))).text(),
      '/assets/test.js',
    )
    for (const path of ['/api/v1/spaces', '/oauth2/token', '/.well-known/openid-configuration']) {
      const denied = await proxy.fetch(
        new Request(origin + path, { headers: { Accept: 'text/html' } }),
      )
      assert.equal(denied.status, 401)
      assert.equal((await denied.json()).error.code, 'INVALID_TOKEN')
    }
    const mail = await proxy.fetch(
      new Request(origin + '/api/v1/auth/transactions/mailbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    )
    assert.equal(mail.status, 409)
    assert.equal((await mail.json()).error.code, 'EMAIL_FLOW_UNAVAILABLE')
  } finally {
    await proxy.dispose()
  }
})
