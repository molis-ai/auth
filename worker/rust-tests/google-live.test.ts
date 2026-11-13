import test from 'node:test'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge } from './fixtures.ts'

test('T-03 Google LIVE adapter on WASM and D1', async (suite) => {
  const origin = 'https://auth-staging.molis.ai'
  const callback = origin + '/api/v2/auth/external/google/callback'
  const issuer = 'https://accounts.google.com'
  const key = secret()
  const codes = new Map<string, { challenge: string; subject: number; nonce: string }>()
  const pair = await generateKeyPair('RS256')
  const wrongPair = await generateKeyPair('RS256')
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: 'google-test-key',
    alg: 'RS256',
    use: 'sig',
  }
  let mutation: Record<string, unknown> = {}
  let wrongSignature = false
  let beforeToken: (() => Promise<void>) | undefined
  let exchanges = 0
  const p = await getRustProxy(
    {
      AUTH_ORIGIN: origin,
      PROVIDER_STATE_KEY: secret(),
      UNIFIED_GOOGLE_CLIENT_ID: 'google-test-client.apps.googleusercontent.com',
      UNIFIED_GOOGLE_CLIENT_SECRET: key,
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
        environmentId: 'unified-staging',
        kind: 'TEST',
        authOrigin: origin,
        deliveryMode: 'MOCK',
        providerMode: 'LIVE',
      }),
    },
    async (request: Request) => {
      if (request.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return Response.json({ keys: [jwk] })
      }
      assert.equal(request.url, 'https://oauth2.googleapis.com/token')
      exchanges++
      assert.equal(request.method, 'POST')
      const form = new URLSearchParams(await request.text())
      assert.equal(form.get('client_id'), 'google-test-client.apps.googleusercontent.com')
      assert.equal(form.get('client_secret'), key)
      assert.equal(form.get('redirect_uri'), callback)
      assert.equal(form.get('grant_type'), 'authorization_code')
      const code = form.get('code')!
      const authorization = codes.get(code)
      assert.ok(authorization)
      assert.equal(challenge(form.get('code_verifier')!), authorization.challenge)
      codes.delete(code)
      await beforeToken?.()
      const now = Math.floor(Date.now() / 1000)
      const jwt = await new SignJWT({
        iss: issuer,
        aud: 'google-test-client.apps.googleusercontent.com',
        sub: String(authorization.subject),
        nonce: authorization.nonce,
        iat: now,
        exp: now + 300,
        name: 'Google Test User',
        email: 'google-user@example.test',
        email_verified: true,
        picture: 'https://lh3.googleusercontent.com/test-avatar',
        ...mutation,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'google-test-key' })
        .sign(wrongSignature ? wrongPair.privateKey : pair.privateKey)
      return Response.json({ id_token: jwt, access_token: 'unused' })
    },
  )
  try {
    await initializeLocalRuntime(p, false)
    const db = p.env.DB
    const seed = readFileSync(new URL('../deploy/staging/seed.sql', import.meta.url), 'utf8')
    for (const sql of seed
      .replace(/^--[^\n]*$/gm, '')
      .split(';')
      .map((sql) => sql.trim())
      .filter(Boolean)) {
      await db.prepare(sql).run()
    }

    function api(path: string, body?: unknown, proof?: string, accessToken?: string) {
      return p.fetch(
        new Request(origin + '/api/v2' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': secret(),
            ...(proof ? { 'X-Auth-Initiator-Proof': proof } : {}),
            ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}),
          },
          body: JSON.stringify(body),
        }),
      )
    }
    type Intent =
      | { purpose: 'LOGIN' }
      | { purpose: 'BIND'; accessToken: string }
      | { purpose: 'REPLACE'; accessToken: string; bindingId: string }
      | {
          purpose: 'REAUTH'
          accessToken: string
          operation: 'BIND_METHOD' | 'REPLACE_METHOD'
          target: { method: 'GOOGLE' } | { bindingId: string }
        }
    async function start(
      product: 'work' | 'club',
      provider = 'google',
      subject = 1234567,
      intent: Intent = { purpose: 'LOGIN' },
    ) {
      const redirectUri =
        product === 'work'
          ? 'http://127.0.0.1:44207/account/callback'
          : 'https://club-staging.molis.ai/account/callback'
      const proof = secret()
      const verifier = secret()
      const clientId = 'molis-' + product + '-staging'
      const { purpose, ...details } = intent
      const accessToken = 'accessToken' in details ? details.accessToken : undefined
      const response = await api(
        purpose === 'REAUTH' ? '/users/me/reauthentications' : '/auth/transactions',
        {
          clientId,
          ...(purpose !== 'REAUTH' ? { purpose } : {}),
          ...('bindingId' in details ? { bindingId: details.bindingId } : {}),
          ...('operation' in details
            ? { operation: details.operation, target: details.target }
            : {}),
          method: provider.toUpperCase(),
          redirectUri,
          state: secret(),
          codeChallenge: challenge(verifier),
          codeChallengeMethod: 'S256',
          initiatorChallenge: challenge(proof),
        },
        undefined,
        accessToken,
      )
      assert.equal(response.status, 200, await response.clone().text())
      const id = (await response.json()).data.transactionId
      const opened = await api(
        '/auth/transactions/' + id + '/providers/' + provider + '/start',
        {},
        proof,
        accessToken,
      )
      assert.equal(opened.status, 200, await opened.clone().text())
      const entry = await p.fetch(new Request((await opened.json()).data.browserStartUrl))
      assert.equal(entry.status, 303)
      const cookie = entry.headers.get('Set-Cookie')!.split(';')[0]
      assert.match(entry.headers.get('Set-Cookie')!, /HttpOnly; SameSite=Lax; Max-Age=600; Secure/)
      const location = new URL(entry.headers.get('Location')!)
      assert.equal(
        location.origin + location.pathname,
        'https://accounts.google.com/o/oauth2/v2/auth',
      )
      assert.equal(location.searchParams.get('redirect_uri'), callback)
      assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(location.searchParams.get('prompt'), 'select_account')
      assert.equal(location.searchParams.has('login_hint'), false)
      assert.equal(
        location.searchParams.get('client_id'),
        'google-test-client.apps.googleusercontent.com',
      )
      const code = secret()
      codes.set(code, {
        challenge: location.searchParams.get('code_challenge')!,
        subject,
        nonce: location.searchParams.get('nonce')!,
      })
      assert.equal(location.searchParams.get('scope'), 'openid email profile')
      const state = location.searchParams.get('state')!
      const query = new URLSearchParams({
        code,
        state,
        scope: 'openid email profile',
        authuser: '0',
        prompt: 'select_account',
      })
      return {
        url: callback + '?' + query,
        state,
        cookie,
        redirectUri,
        clientId,
        id,
        proof,
        verifier,
        accessToken,
      }
    }
    type Flow = NonNullable<Awaited<ReturnType<typeof start>>>
    async function complete(flow: Flow) {
      const completed = await api(
        '/auth/transactions/' + flow.id + '/complete',
        {},
        flow.proof,
        flow.accessToken,
      )
      assert.equal(completed.status, 200, await completed.clone().text())
      return (await completed.json()).data
    }
    async function finish(flow: Flow) {
      const { code } = await complete(flow)
      const token = await api('/auth/token', {
        grantType: 'authorization_code',
        clientId: flow.clientId,
        code,
        redirectUri: flow.redirectUri,
        codeVerifier: flow.verifier,
      })
      assert.equal(token.status, 200)
      const { accessToken } = (await token.json()).data
      const me = await p.fetch(
        new Request(origin + '/api/v2/users/me', {
          headers: { Authorization: 'Bearer ' + accessToken },
        }),
      )
      assert.equal(me.status, 200)
      const { user, loginMethods } = (await me.json()).data
      assert.equal(user.displayName, 'Google Test User')
      assert.equal(user.email, 'google-user@example.test')
      assert.equal(user.avatarUrl, 'https://lh3.googleusercontent.com/test-avatar')
      assert.equal(loginMethods[0].maskedLabel, 'google-user@example.test')
      assert.equal(loginMethods.length, 1)
      assert.equal(loginMethods[0].type, 'GOOGLE')
      assert.equal(loginMethods[0].usableForLogin, true)
      return { userId: user.userId, accessToken }
    }
    async function sendCallback(flow: Flow) {
      return p.fetch(new Request(flow.url, { headers: { Cookie: flow.cookie } }))
    }
    async function verify(flow: Flow) {
      const response = await sendCallback(flow)
      assert.equal(response.status, 303, await response.clone().text())
      const location = new URL(response.headers.get('Location')!)
      assert.equal(location.origin + location.pathname, flow.redirectUri)
      assert.equal(location.searchParams.get('result'), 'VERIFIED')
      assert.equal(location.searchParams.has('code'), false)
    }
    const work = (await start('work'))!
    const bad = await p.fetch(new Request(work.url))
    assert.equal(bad.status, 401)
    assert.equal(exchanges, 0)
    const wrongIssuer = new URL(work.url)
    wrongIssuer.searchParams.set('iss', 'https://other.example.test/oauth')
    for (const url of [wrongIssuer]) {
      const rejected = await p.fetch(new Request(url, { headers: { Cookie: work.cookie } }))
      assert.equal(rejected.status, 400)
      assert.equal(exchanges, 0)
    }
    const fakePage = await p.fetch(
      new Request(origin + '/api/v2/auth/mock/google/authorize?state=' + work.state, {
        headers: { Cookie: work.cookie },
      }),
    )
    assert.equal(fakePage.status, 503)
    assert.equal(exchanges, 0)

    const signedInUsers = []
    for (const flow of [work, (await start('club'))!]) {
      await verify(flow)
      signedInUsers.push(await finish(flow))
      assert.equal((await sendCallback(flow)).status, 401)
    }
    assert.equal(new Set(signedInUsers.map(({ userId }) => userId)).size, 1)
    assert.equal(exchanges, 2)
    const identity = await db.prepare('SELECT issuer, subject FROM auth_external_identity').all()
    assert.deepEqual(identity.results, [
      { issuer: 'https://accounts.google.com', subject: '1234567' },
    ])
    const users = await db
      .prepare(
        "SELECT COUNT(DISTINCT user_id) AS count FROM auth_product_transaction WHERE status='CONSUMED'",
      )
      .first()
    assert.equal(users!.count, 1)

    const cancel = (await start('club'))!
    const params = new URLSearchParams({
      state: cancel.state,
      iss: issuer,
      error: 'access_denied',
      error_description: 'user cancelled',
    })
    const cancelled = await p.fetch(
      new Request(callback + '?' + params, { headers: { Cookie: cancel.cookie } }),
    )
    assert.equal(cancelled.status, 303)
    assert.equal(
      new URL(cancelled.headers.get('Location')!).searchParams.get('result'),
      'CANCELLED',
    )
    assert.equal(exchanges, 2)

    await suite.test(
      'binds and replaces Google identities with action-scoped, one-use reauthentication',
      async () => {
        const { accessToken, userId } = signedInUsers[0]
        const newSubject = 2345678
        const replacementSubject = 3456789
        async function me() {
          const response = await api('/users/me', undefined, undefined, accessToken)
          assert.equal(response.status, 200)
          return (await response.json()).data
        }
        const before = await me()
        const originalBinding = before.loginMethods[0].bindingId
        const authorizeBind = (await start('work', 'google', 1234567, {
          purpose: 'REAUTH',
          accessToken,
          operation: 'BIND_METHOD',
          target: { method: 'GOOGLE' },
        }))!
        await verify(authorizeBind)
        const { operationProof: bindProof } = await complete(authorizeBind)
        const bindFlow = (await start('work', 'google', newSubject, {
          purpose: 'BIND',
          accessToken,
        }))!
        await verify(bindFlow)
        const { newIdentityProof: bindIdentity } = await complete(bindFlow)
        const bindPath = '/users/me/login-methods/bind'
        const bound = await api(
          bindPath,
          {
            operationProof: bindProof,
            newIdentityProof: bindIdentity,
            expectedVersion: before.user.version,
          },
          undefined,
          accessToken,
        )
        assert.equal(bound.status, 200, await bound.clone().text())
        const { loginMethods, version } = (await bound.json()).data
        assert.equal(loginMethods.length, 2)
        const binding = loginMethods.find(
          (method: { bindingId: string }) => method.bindingId !== originalBinding,
        )
        assert.equal(binding?.usableForLogin, true)
        const replay = await api(
          bindPath,
          {
            operationProof: bindProof,
            newIdentityProof: bindIdentity,
            expectedVersion: version,
          },
          undefined,
          accessToken,
        )
        assert.equal(replay.status, 401)

        const bindingId = binding.bindingId
        const authorizeReplace = (await start('work', 'google', newSubject, {
          purpose: 'REAUTH',
          accessToken,
          operation: 'REPLACE_METHOD',
          target: { bindingId },
        }))!
        await verify(authorizeReplace)
        const { operationProof: replaceProof } = await complete(authorizeReplace)
        const replaceFlow = (await start('work', 'google', replacementSubject, {
          purpose: 'REPLACE',
          accessToken,
          bindingId,
        }))!
        await verify(replaceFlow)
        const { newIdentityProof: replacement } = await complete(replaceFlow)
        const replaced = await api(
          '/users/me/login-methods/' + bindingId + '/replace',
          {
            operationProof: replaceProof,
            newIdentityProof: replacement,
            expectedVersion: version,
          },
          undefined,
          accessToken,
        )
        assert.equal(replaced.status, 200, await replaced.clone().text())
        const after = await me()
        assert.equal(after.user.userId, userId)
        assert.deepEqual(
          after.loginMethods.map(
            ({ usableForLogin }: { usableForLogin: boolean }) => usableForLogin,
          ),
          [true, true],
        )
        assert.ok(
          after.loginMethods.some(
            ({ bindingId }: { bindingId: string }) => bindingId === originalBinding,
          ),
        )
        assert.ok(
          after.loginMethods.every(
            (method: { bindingId: string }) => method.bindingId !== bindingId,
          ),
        )
        assert.deepEqual(
          (
            await db
              .prepare('SELECT user_id, subject FROM auth_external_identity ORDER BY subject')
              .all()
          ).results,
          [
            { user_id: userId, subject: '1234567' },
            { user_id: userId, subject: String(replacementSubject) },
          ],
        )

        const removed = (await start('work', 'google', newSubject, {
          purpose: 'REAUTH',
          accessToken,
          operation: 'BIND_METHOD',
          target: { method: 'GOOGLE' },
        }))!
        assert.equal((await sendCallback(removed)).status, 409)
      },
    )
    await suite.test(
      'rejects invalid signed claims and signatures without creating identities',
      async () => {
        const before = await db.prepare('SELECT COUNT(*) n FROM auth_external_identity').first()
        for (const claims of [
          { iss: 'https://evil.example' },
          { aud: 'other-client' },
          { azp: 'other-client' },
          { nonce: 'wrong-nonce' },
          { exp: 1 },
          { iat: Math.floor(Date.now() / 1000) + 3600 },
          { sub: '' },
        ]) {
          mutation = claims
          const flow = await start('work', 'google', 999999)
          assert.equal((await sendCallback(flow)).status, 401)
          assert.equal((await completeRejected(flow)).status, 409)
        }
        mutation = {}
        wrongSignature = true
        assert.equal((await sendCallback(await start('work', 'google', 999999))).status, 401)
        wrongSignature = false
        const after = await db.prepare('SELECT COUNT(*) n FROM auth_external_identity').first()
        assert.deepEqual(after, before)
      },
    )
    await suite.test('cancellation during token exchange blocks late identity writes', async () => {
      const flow = await start('work', 'google', 888888)
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const resume = new Promise<void>((resolve) => {
        release = resolve
      })
      beforeToken = async () => {
        entered()
        await resume
      }
      const before = await db.prepare('SELECT COUNT(*) n FROM auth_external_identity').first()
      const pending = sendCallback(flow)
      try {
        await started
        const cancelled = await api('/auth/transactions/' + flow.id + '/cancel', {}, flow.proof)
        assert.equal(cancelled.status, 200)
      } finally {
        release()
        beforeToken = undefined
      }
      assert.equal((await pending).status, 409)
      assert.deepEqual(
        await db.prepare('SELECT COUNT(*) n FROM auth_external_identity').first(),
        before,
      )
    })
    await suite.test(
      'Google profile fills existing empty accounts but preserves user edits and removed avatars',
      async () => {
        const { accessToken, userId } = signedInUsers[0]
        const me = async () =>
          (await (await api('/users/me', undefined, undefined, accessToken)).json()).data
        const before = await me()
        const edited = await p.fetch(
          new Request(origin + '/api/v2/users/me/profile', {
            method: 'PATCH',
            headers: {
              Authorization: 'Bearer ' + accessToken,
              'Content-Type': 'application/json',
              'Idempotency-Key': secret(),
            },
            body: JSON.stringify({
              displayName: 'My own name',
              avatarDataUrl: null,
              expectedVersion: before.user.version,
            }),
          }),
        )
        assert.equal(edited.status, 200, await edited.clone().text())
        await verify(await start('work', 'google', 1234567))
        const after = await me()
        assert.equal(after.user.displayName, 'My own name')
        assert.equal(after.user.avatarUrl, null)
        assert.equal(after.user.email, 'google-user@example.test')
        assert.equal(
          (
            await db
              .prepare('SELECT COUNT(*) n FROM auth_user_email WHERE user_id=?')
              .bind(userId)
              .first()
          ).n,
          0,
        )
        // Existing accounts created before profile support get metadata on next login.
        await db
          .prepare(
            "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES ('old-google-user','Molis 用户','ACTIVE',0,0)",
          )
          .run()
        await db
          .prepare(
            "INSERT INTO auth_external_identity VALUES ('old-google-binding','old-google-user','GOOGLE','https://accounts.google.com','777777',0)",
          )
          .run()
        await verify(await start('work', 'google', 777777))
        const old = await db
          .prepare("SELECT display_name,avatar_data FROM auth_user WHERE id='old-google-user'")
          .first()
        assert.equal(old.display_name, 'Google Test User')
        assert.equal(old.avatar_data, 'https://lh3.googleusercontent.com/test-avatar')
      },
    )
    await suite.test('unverified email and non-Google avatar are not imported', async () => {
      mutation = { email_verified: false, picture: 'https://attacker.example/avatar' }
      try {
        await verify(await start('work', 'google', 666666))
        const row = await db
          .prepare("SELECT email,avatar_url FROM auth_external_profile WHERE subject='666666'")
          .first()
        assert.equal(row.email, null)
        assert.equal(row.avatar_url, null)
      } finally {
        mutation = {}
      }
    })
    async function completeRejected(flow: Flow) {
      return api('/auth/transactions/' + flow.id + '/complete', {}, flow.proof)
    }
  } finally {
    await p.dispose()
  }
})
