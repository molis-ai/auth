import test from 'node:test'
import assert from 'node:assert/strict'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'

test('AUTH-02/07/08/09/10: v2 boundaries reject unavailable routes and unauthenticated management requests without effects', async () => {
  const origin = 'http://127.0.0.1:8787'
  const config = {
    environmentId: 'unified-local',
    kind: 'LOCAL',
    authOrigin: origin,
    deliveryMode: 'MOCK',
    providerMode: 'MOCK',
  }
  const proxy = await getRustProxy({
    AUTH_ORIGIN: origin,
    UNIFIED_ACCOUNT_CONFIG: JSON.stringify(config),
  })
  try {
    await initializeLocalRuntime(proxy)
    assert.equal((await proxy.fetch(new Request(origin + '/api/v1/readiness'))).status, 404)
    for (const path of ['/api/v1', '/api/v1/auth/providers', '/api/v1/me']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await proxy.fetch(new Request(origin + path, { method }))
        assert.equal(response.status, 501, method + ' ' + path)
        assert.equal((await response.json()).error.code, 'UNIFIED_ACCOUNT_NOT_IMPLEMENTED')
      }
    }
    for (const path of [
      '/api/v1/tenants',
      '/api/v1/platform/tenants',
      '/api/v1/invitations',
      '/api/v1/ownership-transfers',
      '/api/v1/platform/audit-events',
    ]) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await proxy.fetch(new Request(origin + path, { method }))
        assert.equal(response.status, 401, method + ' ' + path)
      }
    }
    for (const path of [
      '/api/v1/entitlements/check',
      '/api/v1/catalog/plans',
      '/api/v1/platform/catalog/features',
      '/api/v1/platform/subscriptions',
    ]) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await proxy.fetch(new Request(origin + path, { method }))
        assert.equal(response.status, 501, method + ' ' + path)
        assert.equal((await response.json()).error.code, 'UNIFIED_ACCOUNT_NOT_IMPLEMENTED')
      }
    }
    for (const table of ['auth_user', 'auth_product_transaction', 'auth_tenant']) {
      assert.equal((await proxy.env.DB.prepare(`SELECT count(*) n FROM ${table}`).first()).n, 0)
    }
  } finally {
    await proxy.dispose()
  }
})

test('UAS-40: runtime itself rejects production mock, even when deployment checks are bypassed', async () => {
  const origin = 'https://auth.example.test'
  for (const config of [
    {
      environmentId: 'production',
      kind: 'PRODUCTION',
      authOrigin: origin,
      deliveryMode: 'MOCK',
      providerMode: 'LIVE',
    },
    {
      environmentId: 'production',
      kind: 'PRODUCTION',
      authOrigin: origin,
      deliveryMode: 'LIVE',
      providerMode: 'MOCK',
    },
    {
      environmentId: 'production',
      kind: 'UNKNOWN',
      authOrigin: origin,
      deliveryMode: 'LIVE',
      providerMode: 'LIVE',
    },
  ]) {
    const proxy = await getRustProxy({
      AUTH_ORIGIN: origin,
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify(config),
    })
    try {
      const health = await proxy.fetch(new Request(origin + '/api/v1/health'))
      assert.equal(health.status, 200)
      const response = await proxy.fetch(
        new Request(origin + '/api/v1/auth/capabilities?clientId=fixture'),
      )
      assert.equal(response.status, 503)
      assert.equal((await response.json()).error.code, 'UNIFIED_CONFIGURATION_INVALID')
    } finally {
      await proxy.dispose()
    }
  }
})
