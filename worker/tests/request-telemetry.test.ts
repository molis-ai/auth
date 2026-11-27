import assert from 'node:assert/strict'
import test from 'node:test'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { captureAuthLogs, hash, secret } from './fixtures.ts'

test('AC-AUTH-01/03 external requests log one sanitized outcome, including early failures', async () => {
  const origin = 'http://127.0.0.1:8787'
  const transactionId = crypto.randomUUID()
  const token = secret()
  const cookie = secret()
  const query = secret()
  const extensionMethod = 'PROPFIND'
  const ip = '198.51.100.42'
  const logs = captureAuthLogs()
  const proxy = await getRustProxy(
    {
      AUTH_ORIGIN: origin,
      MOLIS_ENVIRONMENT: 'dev',
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
        environmentId: 'unified-local',
        authOrigin: origin,
        kind: 'LOCAL',
        deliveryMode: 'MOCK',
        providerMode: 'MOCK',
      }),
    },
    undefined,
    async (request: Request) =>
      new Response('fixture', {
        status: new URL(request.url).pathname === '/auth-ui/assets/missing-Abcd_123.js' ? 404 : 200,
      }),
    logs,
  )
  try {
    await initializeLocalRuntime(proxy)
    await proxy.env.DB.prepare('INSERT INTO auth_rate_bucket VALUES (?, 120, ?)')
      .bind(hash('v2-token:' + ip), Date.now() + 60_000)
      .run()
    const health = await proxy.fetch(new Request(origin + '/api/v2/health'))
    const asset = await proxy.fetch(new Request(origin + '/auth-ui/assets/logo-Abcd_123.js'))
    assert.equal(health.status, 200)
    assert.equal(asset.status, 200)
    const skipped = [health, asset].map((response) => response.headers.get('X-Request-ID'))
    assert.ok(skipped.every(Boolean))

    async function check(
      path: string,
      status: number,
      route: string,
      errorCode: string,
      {
        method = 'GET',
        logMethod = method,
        env = 'dev',
        body,
      }: {
        method?: string
        logMethod?: string
        env?: string
        body?: object
      } = {},
    ) {
      const response = await proxy.fetch(
        new Request(origin + path, {
          method,
          headers: {
            Authorization: 'Bearer ' + token,
            Cookie: 'private=' + cookie,
            'CF-Connecting-IP': ip,
            'Content-Type': 'application/json',
            'X-Request-ID': token,
          },
          body: body && JSON.stringify(body),
        }),
      )
      assert.equal(response.status, status)
      const requestId = response.headers.get('X-Request-ID')
      assert.match(requestId ?? '', /^[0-9a-f-]{36}$/)
      const match = (log: (typeof logs.records)[number]) =>
        log.event === 'auth.http.request' && log.request_id === requestId
      const { duration_ms, ...event } = await logs.waitFor(match)
      assert.ok(Number.isInteger(duration_ms) && duration_ms >= 0)
      assert.deepEqual(event, {
        schema: 1,
        service: 'molis-auth',
        env,
        event: 'auth.http.request',
        request_id: requestId,
        method: logMethod,
        route,
        status,
        error_code: errorCode,
      })
      assert.equal(logs.records.filter(match).length, 1)
    }

    await check('/login', 200, '/', 'none')
    await check('/auth-ui/assets/missing-Abcd_123.js', 404, '/auth-ui/{asset}', 'http_error')
    await check('/api/v2/health', 501, '/api/v2/health', 'UNIFIED_ACCOUNT_NOT_IMPLEMENTED', {
      method: 'POST',
    })
    await check('/api/v2/auth/token', 429, '/api/v2/auth/token', 'RATE_LIMITED', {
      method: 'POST',
      body: { grantType: 'refresh_token', clientId: 'molis-auth-web-local', refreshToken: token },
    })
    await check('/api/private-' + query, 404, 'unmatched', 'NOT_FOUND', {
      method: extensionMethod,
      logMethod: 'OTHER',
    })
    await proxy.updateBindings({
      MOLIS_ENVIRONMENT: query,
      UNIFIED_ACCOUNT_CONFIG: 'invalid config ' + query,
    })
    await check(
      '/api/v2/auth/transactions/' + transactionId + '?query=' + query,
      503,
      '/api/v2/auth/transactions/{transactionId}',
      'UNIFIED_CONFIGURATION_INVALID',
      { env: 'unknown' },
    )
    const initialization = await logs.waitFor((log) => log.phase === 'initialize')
    assert.equal(initialization.env, 'unknown')
    assert.equal(initialization.code, 'UNIFIED_CONFIGURATION_INVALID')
    assert.ok(skipped.every((id) => logs.records.every((event) => event.request_id !== id)))
    for (const line of logs.lines.filter((line) => line.includes('"auth.'))) {
      assert.doesNotMatch(line, /[\r\n]/)
      for (const sensitive of [transactionId, query, token, cookie, ip, extensionMethod])
        assert.equal(line.includes(sensitive), false)
    }
  } finally {
    await proxy.dispose()
  }
})
