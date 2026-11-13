import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge } from './fixtures.ts'

test('T-03 GitHub LIVE adapter on WASM and D1', async (suite) => {
  const origin = process.env.GITHUB_TEST_ORIGIN || 'https://auth-staging.molis.ai'
  const callback = origin + '/api/v2/auth/external/github/callback'
  const issuer = 'https://github.com/login/oauth'
  const key = secret()
  const codes = new Map<string, { challenge: string; subject: number }>()
  const tokens = new Map<string, number>()
  let exchanges = 0
  const p = await getRustProxy(
    {
      AUTH_ORIGIN: origin,
      PROVIDER_STATE_KEY: secret(),
      UNIFIED_GITHUB_CLIENT_ID: 'github-test-client',
      UNIFIED_GITHUB_CLIENT_SECRET: key,
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
        environmentId: 'unified-staging',
        kind: 'TEST',
        authOrigin: origin,
        deliveryMode: 'MOCK',
        providerMode: 'LIVE',
      }),
    },
    async (request: Request) => {
      if (request.url === 'https://github.com/login/oauth/access_token') {
        exchanges++
        assert.equal(request.method, 'POST')
        const form = new URLSearchParams(await request.text())
        assert.equal(form.get('client_id'), 'github-test-client')
        assert.equal(form.get('client_secret'), key)
        assert.equal(form.get('redirect_uri'), callback)
        const code = form.get('code')!
        const authorization = codes.get(code)
        assert.ok(authorization)
        assert.equal(challenge(form.get('code_verifier')!), authorization.challenge)
        codes.delete(code)
        const accessToken = secret()
        tokens.set(accessToken, authorization.subject)
        return Response.json({ access_token: accessToken, token_type: 'bearer' })
      }
      assert.equal(request.url, 'https://api.github.com/user')
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '')
      const subject = token && tokens.get(token)
      assert.ok(subject)
      tokens.delete(token)
      return Response.json({
        id: subject,
        email: 'public@example.test',
        login: 'synthetic-github',
        name: 'GitHub Test User',
        avatar_url: 'https://avatars.githubusercontent.com/u/1234567?v=4',
      })
    },
  )
  try {
    await initializeLocalRuntime(p, false)
    const db = p.env.DB
    const seed = readFileSync(
      new URL('../deploy/staging/seed.sql', import.meta.url),
      'utf8',
    ).replaceAll('https://auth-staging.molis.ai', origin)
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
          target: { method: 'GITHUB' } | { bindingId: string }
        }
    async function start(
      product: 'work' | 'club',
      provider = 'github',
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
      if (provider === 'google') {
        assert.equal(opened.status, 503)
        return
      }
      assert.equal(opened.status, 200, await opened.clone().text())
      const entry = await p.fetch(new Request((await opened.json()).data.browserStartUrl))
      assert.equal(entry.status, 303)
      const cookie = entry.headers.get('Set-Cookie')!.split(';')[0]
      assert.match(entry.headers.get('Set-Cookie')!, /HttpOnly; SameSite=Lax; Max-Age=600/)
      assert.equal(
        entry.headers.get('Set-Cookie')!.includes('; Secure'),
        origin.startsWith('https:'),
      )
      const location = new URL(entry.headers.get('Location')!)
      assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize')
      assert.equal(location.searchParams.get('redirect_uri'), callback)
      assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(location.searchParams.get('prompt'), 'select_account')
      assert.equal(location.searchParams.has('login_hint'), false)
      assert.equal(location.searchParams.get('client_id'), 'github-test-client')
      const code = secret()
      codes.set(code, { challenge: location.searchParams.get('code_challenge')!, subject })
      const state = location.searchParams.get('state')!
      const query = new URLSearchParams({ code, state, iss: issuer })
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
      assert.equal(loginMethods.length, 1)
      assert.equal(loginMethods[0].type, 'GITHUB')
      assert.equal(loginMethods[0].usableForLogin, true)
      assert.equal(loginMethods[0].maskedLabel, '@synthetic-github')
      assert.equal(user.displayName, 'GitHub Test User')
      assert.equal(user.avatarUrl, 'https://avatars.githubusercontent.com/u/1234567?v=4')
      assert.equal(user.email, null)
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
      new Request(origin + '/api/v2/auth/mock/github/authorize?state=' + work.state, {
        headers: { Cookie: work.cookie },
      }),
    )
    assert.equal(fakePage.status, 503)
    assert.equal(exchanges, 0)

    // GitHub's documented callback is code + state; issuer is optional but checked if present.
    const withoutIssuer = new URL(work.url)
    withoutIssuer.searchParams.delete('iss')
    work.url = withoutIssuer.toString()
    const signedInUsers = []
    for (const flow of [work, (await start('club'))!]) {
      await verify(flow)
      signedInUsers.push(await finish(flow))
      assert.equal((await sendCallback(flow)).status, 401)
    }
    assert.equal(new Set(signedInUsers.map(({ userId }) => userId)).size, 1)
    assert.equal(exchanges, 2)
    const identity = await db.prepare('SELECT issuer, subject FROM auth_external_identity').all()
    assert.deepEqual(identity.results, [{ issuer: 'https://github.com', subject: '1234567' }])
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
    await start('club', 'google')
    assert.equal(exchanges, 2)

    await suite.test(
      'binds and replaces GitHub identities with action-scoped, one-use reauthentication',
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
        const authorizeBind = (await start('work', 'github', 1234567, {
          purpose: 'REAUTH',
          accessToken,
          operation: 'BIND_METHOD',
          target: { method: 'GITHUB' },
        }))!
        await verify(authorizeBind)
        const { operationProof: bindProof } = await complete(authorizeBind)
        const bindFlow = (await start('work', 'github', newSubject, {
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
        const authorizeReplace = (await start('work', 'github', newSubject, {
          purpose: 'REAUTH',
          accessToken,
          operation: 'REPLACE_METHOD',
          target: { bindingId },
        }))!
        await verify(authorizeReplace)
        const { operationProof: replaceProof } = await complete(authorizeReplace)
        const replaceFlow = (await start('work', 'github', replacementSubject, {
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

        const removed = (await start('work', 'github', newSubject, {
          purpose: 'REAUTH',
          accessToken,
          operation: 'BIND_METHOD',
          target: { method: 'GITHUB' },
        }))!
        assert.equal((await sendCallback(removed)).status, 409)
      },
    )
    await suite.test(
      'GitHub profile fills older accounts and preserves edited profiles',
      async () => {
        const { accessToken, userId } = signedInUsers[0]
        const before = (await (await api('/users/me', undefined, undefined, accessToken)).json())
          .data
        const edited = await p.fetch(
          new Request(origin + '/api/v2/users/me/profile', {
            method: 'PATCH',
            headers: {
              Authorization: 'Bearer ' + accessToken,
              'Content-Type': 'application/json',
              'Idempotency-Key': secret(),
            },
            body: JSON.stringify({
              displayName: 'My chosen name',
              avatarDataUrl: null,
              expectedVersion: before.user.version,
            }),
          }),
        )
        assert.equal(edited.status, 200)
        await verify((await start('work'))!)
        const after = (await (await api('/users/me', undefined, undefined, accessToken)).json())
          .data
        assert.equal(after.user.displayName, 'My chosen name')
        assert.equal(after.user.avatarUrl, null)
        assert.equal(
          (
            await db
              .prepare('SELECT COUNT(*) n FROM auth_user_email WHERE user_id=?')
              .bind(userId)
              .first()
          ).n,
          0,
        )
        await db
          .prepare(
            "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES ('old-github','Molis 用户','ACTIVE',0,0)",
          )
          .run()
        await db
          .prepare(
            "INSERT INTO auth_external_identity VALUES ('old-github-binding','old-github','GITHUB','https://github.com','777777',0)",
          )
          .run()
        await verify((await start('work', 'github', 777777))!)
        const old = await db
          .prepare("SELECT display_name,avatar_data FROM auth_user WHERE id='old-github'")
          .first()
        assert.equal(old.display_name, 'GitHub Test User')
        assert.equal(old.avatar_data, 'https://avatars.githubusercontent.com/u/1234567?v=4')
      },
    )
  } finally {
    await p.dispose()
  }
})
