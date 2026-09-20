import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getRustProxy } from '../scripts/local-runtime.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

import { secret, challenge, hash } from './fixtures.ts'

for (const provider of ['google', 'apple'])
  test(`Rust WASM ${provider} callback: verified identity, browser binding, nonce and one-use state`, async () => {
    const google = provider === 'google'
    const prefix = provider.toUpperCase()
    const client = 'synthetic-' + provider
    const issuer = google ? 'https://accounts.google.com' : 'https://appleid.apple.com'
    const keysUrl = google
      ? 'https://www.googleapis.com/oauth2/v3/certs'
      : 'https://appleid.apple.com/auth/keys'
    const tokenUrl = google
      ? 'https://oauth2.googleapis.com/token'
      : 'https://appleid.apple.com/auth/token'
    let outbound: (request: Request) => Promise<Response>
    const config = {
      AUTH_ORIGIN: 'https://auth.example.test',
      [prefix + '_CLIENT_ID']: client,
      [prefix + '_CLIENT_SECRET']: 'synthetic-secret',
      PROVIDER_STATE_KEY: secret(),
    }
    const proxy = await getRustProxy(config, (request: Request) => outbound(request))
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
        PROVIDER_STATE_KEY: config.PROVIDER_STATE_KEY,
      }
      const worker = { fetch: (request: Request, env: any) => proxy.fetch(request, env) }
      const keys = await generateKeyPair('RS256'),
        jwk = { ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'RS256' }
      let nonce = '',
        calls = 0
      outbound = async (request) => {
        const url = request.url
        if (url === keysUrl) return Response.json({ keys: [jwk] })
        assert.equal(url, tokenUrl)
        assert.equal(new URLSearchParams(await request.text()).get('client_id'), client)
        calls++
        const jwt = await new SignJWT({
          nonce,
          email: 'provider-fixture@example.test',
          email_verified: true,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
          .setIssuer(issuer)
          .setAudience(client)
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
          new Request(origin + '/api/v1/auth/providers/' + provider + '/start', {
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
      function callback(flow: { state: string; cookie: string }, withCookie = true) {
        const params = new URLSearchParams({ state: flow.state, code: 'synthetic-code' })
        return new Request(origin + '/oauth2/callback/' + provider + (google ? '?' + params : ''), {
          method: google ? 'GET' : 'POST',
          headers: {
            ...(withCookie ? { Cookie: flow.cookie } : {}),
            ...(!google
              ? {
                  Origin: 'https://appleid.apple.com',
                  'Content-Type': 'application/x-www-form-urlencoded',
                }
              : {}),
          },
          body: google ? undefined : params,
        })
      }
      // No browser cookie: reject before exchanging the authorization code.
      assert.equal((await worker.fetch(callback(flow, false), env)).status, 400)
      assert.equal(calls, 0)
      const success = await worker.fetch(callback(flow), env)
      assert.equal(success.status, 303)
      assert.equal(calls, 1, 'callback must reach token exchange before validating identity')
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
      assert.equal((await worker.fetch(callback(flow), env)).status, 400)
      assert.equal(calls, 1)
      const bad = await start()
      nonce = 'wrong-nonce'
      const rejected = await worker.fetch(callback(bad), env)
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
      await proxy.dispose()
    }
  })
