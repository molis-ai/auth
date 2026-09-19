import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { PNG } from 'pngjs'
const origin = 'http://127.0.0.1:8787',
  clientId = 'molis-auth-console',
  redirectUri = origin + '/console/callback'
const salt = Date.now().toString(36),
  password = 'Synthetic-only ' + randomBytes(24).toString('base64url')
const users = [0, 1, 2].map((i) => `migration-${salt}-${i}@example.test`)
class Browser {
  cookies = new Map<string, string>()
  access = ''
  refresh = ''
  async request(
    path: string,
    b?: unknown,
    transaction?: string,
    status = 200,
    method = b === undefined ? 'GET' : 'POST',
  ) {
    const headers: Record<string, string> = {
      Origin: origin,
      Cookie: [...this.cookies].map(([k, v]) => k + '=' + v).join('; '),
    }
    if (b !== undefined)
      headers['Content-Type'] =
        b instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json'
    if (transaction) headers['X-Auth-Transaction'] = transaction
    if (this.access && path !== '/oauth2/token') headers.Authorization = 'Bearer ' + this.access
    const r = await fetch(origin + path, {
      method,
      headers,
      body: b === undefined ? undefined : b instanceof URLSearchParams ? b : JSON.stringify(b),
    })
    for (const v of r.headers.getSetCookie()) {
      const [pair] = v.split(';')
      const at = pair.indexOf('=')
      this.cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    const result = await r.json()
    assert.equal(r.status, status, path + ': ' + JSON.stringify(result))
    return result.data ?? result
  }
  async login(email: string, signup = false, restore = false) {
    const verifier = randomBytes(32).toString('base64url'),
      state = randomBytes(32).toString('base64url')
    const start = await this.request('/api/v1/auth/transactions', {
      clientId,
      redirectUri,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
      state,
      scopes: ['account', 'profile'],
    })
    const transaction = start.transaction
    await this.request(
      '/api/v1/auth/transactions/' + (restore ? 'restore' : signup ? 'signup' : 'password'),
      restore ? {} : signup ? { email, password, confirmPassword: password } : { email, password },
      transaction,
    )
    const proof = await this.request('/api/v1/auth/transactions/confirmation', {}, transaction)
    const complete = await this.request(
      '/api/v1/auth/transactions/complete',
      { confirmation: proof.confirmation, confirmed: true },
      transaction,
    )
    const callback = new URL(complete.redirectTo)
    assert.equal(callback.searchParams.get('state'), state)
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code: callback.searchParams.get('code')!,
      code_verifier: verifier,
    })
    const tokens = await this.request('/oauth2/token', form)
    this.access = tokens.access_token
    this.refresh = tokens.refresh_token
    await this.request('/oauth2/token', form, undefined, 400)
    return this.request('/api/v1/users/me')
  }
}
const owner = new Browser(),
  member = new Browser(),
  outsider = new Browser()
const o = await owner.login(users[0], true),
  m = await member.login(users[1], true)
await outsider.login(users[2], true)
console.log('PASS signup, PKCE, browser-bound confirmation, code replay rejection')
const picture = new PNG({ width: 128, height: 128 })
picture.data.fill(160)
const image = 'data:image/png;base64,' + PNG.sync.write(picture).toString('base64')
await owner.request('/api/v1/users/me/profile', { displayName: 'Avatar E2E', avatarUrl: image })
const profile = await owner.request('/api/v1/users/me')
assert.ok(profile.avatarUrl.startsWith('data:image/png;base64,'))
await owner.request(
  '/api/v1/users/me/profile',
  { displayName: 'Must not save', avatarUrl: 'data:image/png;base64,bad' },
  undefined,
  400,
)
assert.equal((await owner.request('/api/v1/users/me')).avatarUrl, profile.avatarUrl)
const team = await owner.request('/api/v1/spaces', {
  name: 'Migration E2E ' + salt,
  description: 'Synthetic local migration test',
  avatarUrl: image,
})
assert.ok(team.avatarUrl.startsWith('data:image/png;base64,'))
picture.data.fill(220)
const replacement = 'data:image/png;base64,' + PNG.sync.write(picture).toString('base64')
await owner.request(
  '/api/v1/spaces/' + team.id,
  { name: team.name, version: team.version, avatarUrl: replacement },
  undefined,
  200,
  'PUT',
)
const savedTeam = await owner.request('/api/v1/spaces/' + team.id)
assert.notEqual(savedTeam.avatarUrl, team.avatarUrl)
assert.equal(PNG.sync.read(Buffer.from(savedTeam.avatarUrl.split(',')[1], 'base64')).data[0], 220)
await owner.request(
  '/api/v1/spaces/' + team.id,
  { name: team.name, version: savedTeam.version, avatarUrl: 'data:image/png;base64,bad' },
  undefined,
  400,
  'PUT',
)
assert.equal((await owner.request('/api/v1/spaces/' + team.id)).avatarUrl, savedTeam.avatarUrl)
console.log('PASS real HTTP profile/team avatar save, read-back and invalid-upload preservation')
await outsider.request('/api/v1/spaces/' + team.id, undefined, undefined, 403)
await owner.request('/api/v1/platform/me', undefined, undefined, 403)
const invitation = await owner.request('/api/v1/spaces/' + team.id + '/invitations', {
  email: users[1],
  locale: 'zh-CN',
})
const inbox = await member.request('/api/v1/invitations')
assert.ok(inbox.items.some((x: { id: string }) => x.id === invitation.id))
await outsider.request('/api/v1/invitations/' + invitation.id + '/accept', {}, undefined, 403)
await member.request('/api/v1/invitations/' + invitation.id + '/accept', {})
await member.request('/api/v1/invitations/' + invitation.id + '/accept', {}, undefined, 409)
await member.request(
  '/api/v1/spaces/' + team.id + '/members/' + o.userId + '/remove',
  {},
  undefined,
  403,
)
await owner.request(
  '/api/v1/spaces/' + team.id + '/members/' + m.userId + '/role',
  { role: 'VIEWER' },
  undefined,
  200,
  'PUT',
)
const page = await owner.request(
  '/api/v1/spaces/' + team.id + '/members?page=1&limit=1&sort=role&order=desc',
)
assert.equal(page.total, 2)
assert.equal(page.items[0].id, o.userId)
await owner.request('/api/v1/spaces/' + team.id + '/audit?page=1&limit=10')
await owner.request('/api/v1/spaces/' + team.id + '/invitations?page=1&limit=10')
console.log(
  'PASS team creation, member pagination, invitation ownership/replay, role protection, audit',
)
await owner.login(users[0], false, true)
const previous = owner.refresh
const refreshed = await owner.request(
  '/oauth2/token',
  new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: previous,
  }),
)
owner.access = refreshed.access_token
await owner.request(
  '/oauth2/token',
  new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: previous,
  }),
  undefined,
  400,
)
await owner.request('/api/v1/users/me', undefined, undefined, 401)
await owner.login(users[0])
await owner.request('/api/v1/sessions/current/logout', {})
await owner.request('/api/v1/users/me', undefined, undefined, 401)
console.log('PASS restore, refresh rotation/replay revocation, logout invalidation')
console.log(
  'Synthetic test accounts and team retained in LOCAL D1 only; no existing users modified.',
)
