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
    for (const path of ['/api/v2', '/api/v2/auth/providers', '/api/v2/me']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await proxy.fetch(new Request(origin + path, { method }))
        assert.equal(response.status, 501, method + ' ' + path)
        assert.equal((await response.json()).error.code, 'UNIFIED_ACCOUNT_NOT_IMPLEMENTED')
      }
    }
    for (const path of [
      '/api/v2/entitlements/check',
      '/api/v2/tenants',
      '/api/v2/platform/tenants',
      '/api/v2/invitations',
      '/api/v2/ownership-transfers',
      '/api/v2/catalog/plans',
      '/api/v2/platform/catalog/features',
      '/api/v2/platform/subscriptions',
      '/api/v2/users/me/subscriptions',
      '/api/v2/platform/audit-events',
      '/api/v2/tenants/missing/seat-assignments',
    ]) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await proxy.fetch(new Request(origin + path, { method }))
        assert.equal(response.status, 401, method + ' ' + path)
      }
    }
    for (const table of [
      'auth_user',
      'auth_product_transaction',
      'auth_space',
      'auth_managed_tenant',
    ]) {
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
      const response = await proxy.fetch(new Request(origin + '/api/v2/health'))
      assert.equal(response.status, 503)
      assert.equal((await response.json()).error.code, 'UNIFIED_CONFIGURATION_INVALID')
    } finally {
      await proxy.dispose()
    }
  }
})
