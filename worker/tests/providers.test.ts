import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getPlatformProxy } from 'wrangler'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import worker, { type Env } from '../src/app.ts'
import { secret, challenge, hash } from '../src/shared/http.ts'

test('provider callback: verified identity, browser binding, nonce and one-use state', async () => {
  const proxy = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
    persist: false,
    remoteBindings: false,
  })
  const originalFetch = globalThis.fetch
  try {
    const db = proxy.env.DB,
      origin = 'https://auth.example.test'
    for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
      const sql = readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8').replace(
        /--[^\n]*/g,
        '',
      )
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(statement).run()
    }
    await db
      .prepare("INSERT INTO auth_application(id,name) VALUES ('test-app','Provider test')")
      .run()
    await db
      .prepare(
        "INSERT INTO auth_client(id,client_id,application_id,client_type,scopes,redirects) VALUES ('test-client','test-client','test-app','WEB',?,?)",
      )
      .bind('["account"]', JSON.stringify([origin + '/callback']))
      .run()
    const env = {
      ...proxy.env,
      AUTH_ORIGIN: origin,
      GOOGLE_CLIENT_ID: 'synthetic-google',
      GOOGLE_CLIENT_SECRET: 'synthetic-secret',
      PROVIDER_STATE_KEY: secret(),
    }
    const keys = await generateKeyPair('RS256'),
      jwk = { ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'RS256' }
    let nonce = '',
      calls = 0
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === 'https://www.googleapis.com/oauth2/v3/certs')
        return Response.json({ keys: [jwk] })
      assert.equal(url, 'https://oauth2.googleapis.com/token')
      assert.equal(new URLSearchParams(String(init?.body)).get('client_id'), env.GOOGLE_CLIENT_ID)
      calls++
      const jwt = await new SignJWT({
        nonce,
        email: 'provider-fixture@example.test',
        email_verified: true,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .setIssuer('https://accounts.google.com')
        .setAudience(env.GOOGLE_CLIENT_ID)
        .setSubject('synthetic-provider-subject')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey)
      return Response.json({ id_token: jwt })
    }
    async function start() {
      const r = await worker.fetch(
        new Request(origin + '/api/v1/auth/transactions', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: 'test-client',
            redirectUri: origin + '/callback',
            codeChallenge: await challenge(secret()),
            codeChallengeMethod: 'S256',
            state: secret(),
            scopes: ['account'],
          }),
        }),
        env,
      )
      assert.equal(r.status, 200)
      const { data } = (await r.json()) as { data: { transaction: string } }
      const result = await worker.fetch(
        new Request(origin + '/api/v1/auth/providers/google/start', {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            'X-Auth-Transaction': data.transaction,
          },
          body: '{}',
        }),
        env,
      )
      assert.equal(result.status, 200)
      const authorization = new URL(
        ((await result.json()) as { data: { authorizationUrl: string } }).data.authorizationUrl,
      )
      return {
        transaction: data.transaction,
        state: authorization.searchParams.get('state')!,
        nonce: authorization.searchParams.get('nonce')!,
        cookie: result.headers.get('Set-Cookie')!.split(';')[0],
      }
    }
    const flow = await start()
    nonce = flow.nonce
    const callbackUrl =
      origin + '/oauth2/callback/google?state=' + flow.state + '&code=synthetic-code'
    // No browser cookie: reject before exchanging the authorization code.
    assert.equal((await worker.fetch(new Request(callbackUrl), env)).status, 400)
    assert.equal(calls, 0)
    const success = await worker.fetch(
      new Request(callbackUrl, { headers: { Cookie: flow.cookie } }),
      env,
    )
    assert.equal(success.status, 303)
    assert.equal(
      success.headers.get('Location'),
      origin + '/complete#transaction=' + flow.transaction,
    )
    assert.equal(
      (
        await db
          .prepare('SELECT status FROM auth_transaction WHERE token_hash=?')
          .bind(await hash(flow.transaction))
          .first<{ status: string }>()
      )?.status,
      'AUTHENTICATED',
    )
    assert.equal(
      (await worker.fetch(new Request(callbackUrl, { headers: { Cookie: flow.cookie } }), env))
        .status,
      400,
    )
    assert.equal(calls, 1)
    const bad = await start()
    nonce = 'wrong-nonce'
    const rejected = await worker.fetch(
      new Request(origin + '/oauth2/callback/google?state=' + bad.state + '&code=synthetic-code', {
        headers: { Cookie: bad.cookie },
      }),
      env,
    )
    assert.match(rejected.headers.get('Location')!, /provider-error=PROVIDER_REJECTED$/)
    assert.equal(
      (
        await db
          .prepare('SELECT status FROM auth_transaction WHERE token_hash=?')
          .bind(await hash(bad.transaction))
          .first<{ status: string }>()
      )?.status,
      'READY',
    )
  } finally {
    globalThis.fetch = originalFetch
    await proxy.dispose()
  }
})
