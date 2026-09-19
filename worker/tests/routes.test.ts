import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { type Env } from '../src/app.ts'

function environment(): Env {
  return {
    AUTH_ORIGIN: 'http://127.0.0.1:8787',
    DB: { prepare: () => ({ all: async () => ({ results: [] }), first: async () => null }) },
    ASSETS: {
      fetch: async (request: Request) =>
        new Response(new URL(request.url).pathname, { headers: { 'Content-Type': 'text/html' } }),
    },
  } as unknown as Env
}
test('disabled mailbox flow keeps its response contract after module extraction', async () => {
  const result = await worker.fetch(
    new Request('http://127.0.0.1:8787/api/v1/auth/transactions/mailbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
    environment(),
  )
  assert.equal(result.status, 409)
  assert.equal((await result.json()).error.code, 'EMAIL_FLOW_UNAVAILABLE')
})
test('page aliases preserve the existing frontend asset prefix', async () => {
  for (const path of ['/login', '/console', '/console/callback', '/complete']) {
    const result = await worker.fetch(new Request('http://localhost' + path), environment())
    assert.equal(await result.text(), '/index.html')
    assert.equal(result.headers.get('Cache-Control'), 'no-store')
  }
  const asset = await worker.fetch(
    new Request('http://localhost/auth-ui/assets/index.js'),
    environment(),
  )
  assert.equal(await asset.text(), '/assets/index.js')
})
test('protected APIs fail closed even for browser navigation requests', async () => {
  for (const path of ['/api/v1/spaces', '/oauth2/token', '/.well-known/openid-configuration']) {
    const response = await worker.fetch(
      new Request('http://localhost' + path, { headers: { Accept: 'text/html' } }),
      environment(),
    )
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'INVALID_TOKEN')
  }
})
test('no fake login capability, safe error response and security headers', async () => {
  const config = await worker.fetch(
    new Request('http://localhost/api/v1/auth/ui-configuration'),
    environment(),
  )
  assert.equal((await config.json()).data.console.enabled, false)
  assert.equal(config.headers.get('X-Frame-Options'), 'DENY')
  const env = environment()
  env.DB = {
    prepare: () => {
      throw new Error('private database details')
    },
  } as unknown as D1Database
  const failed = await worker.fetch(new Request('http://localhost/api/v1/health'), env)
  assert.equal(failed.status, 503)
  assert.equal((await failed.json()).error.code, 'AUTH_UNAVAILABLE')
})
