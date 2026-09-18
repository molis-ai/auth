import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { copy } from '../src/copy.ts'
import { isDirectLoginEntry, readFragment } from '../src/protocol.ts'
import { checkedConsole } from '../src/console-api.ts'
import { AuthClient } from '../../sdk/browser/src/index.ts'
import { webcrypto } from 'node:crypto'

test('missing login requests offer an explicit same-origin recovery link', () => {
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(app, /class="login-recovery-link" href="\/login"/)
  assert.equal(copy['zh-CN'].noTransaction + copy['zh-CN'].signInAgain, '当前页面没有有效的登录请求，请重新登录')
})

test('login branding is concise and uses the bundled logo across account pages', () => {
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  const consolePage = readFileSync(new URL('../src/Console.vue', import.meta.url), 'utf8')
  assert.equal(copy['zh-CN'].headline, '一站式账号')
  assert.doesNotMatch(app, /<footer|t\.foot\b/)
  assert.match(app, /class="shell auth-entry"/)
  assert.doesNotMatch(app, /t\.(private|bound|local)\b|MOLIS ACCOUNT|01 \/ IDENTITY/)
  for (const page of [app, consolePage]) {
    assert.match(page, /import molisLogo from '\.\/assets\/molis-logo\.png'/)
    assert.match(page, /:src="molisLogo"/)
  }
})

test('only clean Auth entry points start a default login, never malformed application or provider callbacks', () => {
  for (const pathname of ['/', '/login']) assert.equal(isDirectLoginEntry({ pathname, search: '', hash: '' }), true)
  for (const url of ['/login#transaction=invalid', '/login#provider-error=PROVIDER_CANCELLED', '/login?redirect=https://evil.example', '/complete', '/verify-email', '/provider']) {
    assert.equal(isDirectLoginEntry(new URL(url, 'http://localhost:8080')), false)
  }
})

test('direct login uses registered console configuration and saves SDK PKCE state without navigating away', async () => {
  const origin = 'http://localhost:8080', storage = new Map<string, string>(), transaction = 't'.repeat(43)
  const options = checkedConsole({ authOrigin: origin, console: { enabled: true, clientId: 'molis-auth-console', redirectUri: origin + '/console/callback' } }, origin)!
  const client = new AuthClient({ ...options, environment: {
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } },
    crypto: webcrypto as unknown as Crypto, now: () => Date.now(), currentUrl: () => origin + '/login',
    navigate: () => assert.fail('Direct entry must stay on the login page'), replaceUrl: () => {},
    fetch: async (url, request) => {
      assert.equal(String(url), origin + '/api/v1/auth/transactions')
      const body = JSON.parse(String(request?.body))
      assert.equal(body.clientId, 'molis-auth-console'); assert.equal(body.redirectUri, origin + '/console/callback')
      assert.equal(body.forceLogin, true); assert.equal(body.codeChallengeMethod, 'S256')
      assert.match(body.codeChallenge, /^[A-Za-z0-9_-]{43}$/)
      return new Response(JSON.stringify({ data: { transaction, loginUrl: origin + '/login#transaction=' + transaction } }))
    },
  } })
  const started = await client.beginLogin({ forceLogin: true })
  assert.equal(readFragment(new URL(started.loginUrl).hash, 'login')?.transaction, transaction)
  const pending = [...storage.entries()].find(([key]) => key.endsWith(':pending'))
  assert.ok(pending); assert.match(JSON.parse(pending[1]).verifier, /^[A-Za-z0-9_-]{43}$/)
})

test('authentication pages do not display connection host banners', () => {
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /t\.target|class="target"|context\.redirectUri\)\.host/)
  for (const locale of ['zh-CN', 'en'] as const) {
    assert.equal('target' in copy[locale], false)
    assert.doesNotMatch(copy[locale].confirmAccountNotice, /上方应用|app above/)
  }
})

test('registration requires matching passwords and never depends on email delivery', () => {
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(app, /v-model="confirmPassword"/)
  assert.match(app, /password.value !== confirmPassword.value/)
  assert.match(app, /transactions\/signup/)
  assert.doesNotMatch(app, /t\.send|t\.sent|switchMode\('forgot-password'\)/)
  assert.match(app, /t\.finishRegister/)
  assert.equal(copy['zh-CN'].finishRegister, '创建账号')
})
