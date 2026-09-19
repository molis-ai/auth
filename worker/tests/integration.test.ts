import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getPlatformProxy } from 'wrangler'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import worker, { type Env } from '../src/app.ts'
import { hash, secret } from '../src/shared/http.ts'
import { Store } from '../src/infrastructure/database.ts'
import { PNG } from 'pngjs'
import { Buffer } from 'node:buffer'
import { avatar } from '../src/security/avatar.ts'

test('isolated D1: platform, permissions, service boundaries, atomic guards and avatar sanitization', async () => {
  const proxy = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
    persist: false,
    remoteBindings: false,
  })
  try {
    const db = proxy.env.DB,
      s = new Store(db),
      origin = 'http://127.0.0.1:8787'
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
    for (const statement of readFileSync(new URL('../local-seed.sql', import.meta.url), 'utf8')
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run()
    const admin = crypto.randomUUID(),
      member = crypto.randomUUID(),
      now = Date.now()
    async function session(id: string, client = 'molis-auth-console') {
      const root = crypto.randomUUID(),
        grant = crypto.randomUUID(),
        access = secret()
      const scope = (await s.one<{ scopes: string }>(
        'SELECT scopes FROM auth_client WHERE client_id=?',
        client,
      ))!.scopes
      await db.batch([
        s.statement(
          "INSERT OR IGNORE INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,?,'ACTIVE',?,?)",
          id,
          'Synthetic ' + id,
          now,
          now,
        ),
        s.statement(
          'INSERT INTO auth_authentication(id,user_id,created_at,activity_at) VALUES (?,?,?,?)',
          root,
          id,
          now,
          now,
        ),
        s.statement(
          'INSERT INTO auth_grant(id,authentication_id,client_id,scopes,created_at) VALUES (?,?,?, ?,?)',
          grant,
          root,
          client,
          scope,
          now,
        ),
        s.statement(
          'INSERT INTO auth_access_token VALUES (?,?,?)',
          await hash(access),
          grant,
          now + 900000,
        ),
      ])
      return access
    }
    const adminAccess = await session(admin),
      memberAccess = await session(member)
    const env = { ...proxy.env, AUTH_ORIGIN: origin, PLATFORM_ADMIN_IDS: admin }
    async function request(
      path: string,
      data?: unknown,
      method = data === undefined ? 'GET' : 'POST',
      access = adminAccess,
      expected = 200,
      extra: Record<string, string> = {},
    ) {
      const r = await worker.fetch(
        new Request(origin + path, {
          method,
          headers: {
            Origin: origin,
            Authorization: 'Bearer ' + access,
            ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...extra,
          },
          body: data === undefined ? undefined : JSON.stringify(data),
        }),
        env,
      )
      const result = (await r.json()) as any
      assert.equal(r.status, expected, path + ': ' + JSON.stringify(result))
      return result.data ?? result
    }
    assert.equal(
      (await request('/api/v1/platform/me', undefined, 'GET', memberAccess, 403)).error.code,
      'PLATFORM_ADMIN_REQUIRED',
    )
    assert.equal((await request('/api/v1/platform/me')).platformAdministrator, true)
    const app = await request('/api/v1/platform/applications', {
      name: 'Synthetic App',
      actions: ['project.read', 'project.update'],
    })
    const matrix = await request('/api/v1/platform/applications/' + app.id + '/permission-matrix')
    assert.ok(matrix.roles.find((x: any) => x.role === 'VIEWER').actions.includes('project.read'))
    await request(
      '/api/v1/platform/applications/' + app.id + '/permission-matrix',
      { version: 0, grants: ['OWNER:project.read', 'MEMBER:project.read'] },
      'PUT',
    )
    await request(
      '/api/v1/platform/applications/' + app.id + '/permission-matrix',
      { version: 0, grants: [] },
      'PUT',
      adminAccess,
      409,
    )
    const consoleApp = '00000000-0000-4000-8000-000000000001'
    await request(
      '/api/v1/platform/applications/' + consoleApp + '/permission-matrix',
      { version: 0, grants: [] },
      'PUT',
      adminAccess,
      403,
    )
    const client = await request('/api/v1/platform/applications/' + app.id + '/clients', {
      clientId: 'synthetic-client',
      clientType: 'WEB',
      scopes: ['account'],
      redirects: ['https://app.example.test/callback'],
    })
    assert.equal(client.clientId, 'synthetic-client')
    const preflight = await worker.fetch(
      new Request(origin + '/api/v1/auth/transactions', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.test',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      }),
      env,
    )
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://app.example.test')
    const denied = await worker.fetch(
      new Request(origin + '/api/v1/auth/ui-configuration', {
        headers: { Origin: 'https://evil.example' },
      }),
      env,
    )
    assert.equal(denied.status, 403)
    const team = await request(
      '/api/v1/spaces',
      { name: 'Synthetic member-owned' },
      'POST',
      memberAccess,
    )
    const detail = await request('/api/v1/spaces/' + team.id)
    assert.equal(detail.role, null)
    assert.equal(detail.canInspectManagement, true)
    await request('/api/v1/spaces/' + team.id + '/members?page=1&limit=10')
    await request(
      '/api/v1/spaces/' + team.id,
      { name: 'Forbidden', version: 0 },
      'PUT',
      adminAccess,
      409,
    )
    assert.equal((await request('/api/v1/spaces/' + team.id)).name, 'Synthetic member-owned')
    const service = await request('/api/v1/platform/applications/' + app.id + '/services', {
      name: 'Synthetic Backend',
    })
    async function serviceToken() {
      const r = await worker.fetch(
        new Request(origin + '/oauth2/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + btoa(service.clientId + ':' + service.secret),
          },
          body: 'grant_type=client_credentials',
        }),
        env,
      )
      assert.equal(r.status, 200)
      return ((await r.json()) as any).access_token
    }
    const svc = await serviceToken(),
      userToken = await session(member, 'synthetic-client')
    async function decision(token: string, expected: number, user = userToken) {
      const r = await worker.fetch(
        new Request(origin + '/api/v1/authorization/check', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
            'X-User-Token': user,
          },
          body: JSON.stringify({ spaceId: team.id, action: 'project.read' }),
        }),
        env,
      )
      const result = (await r.json()) as any
      assert.equal(r.status, expected, JSON.stringify(result))
      return result
    }
    assert.equal((await decision(svc, 200)).data.allowed, true)
    await decision(svc, 403, memberAccess)
    await request('/api/v1/platform/services/' + service.clientId + '/rotate', {})
    await decision(svc, 401)
    await request('/api/v1/platform/services/' + service.clientId + '/disable', {})
    assert.equal(
      (
        await request(
          '/api/v1/platform/services/' + service.clientId + '/rotate',
          {},
          'POST',
          adminAccess,
          409,
        )
      ).error.code,
      'SERVICE_DISABLED',
    )
    // D1 batch rolls back early writes when a later guard fails.
    await assert.rejects(
      s.batch([
        s.statement("UPDATE auth_space SET name='must roll back' WHERE id=?", team.id),
        s.guard('0'),
      ]),
    )
    assert.equal((await request('/api/v1/spaces/' + team.id)).name, 'Synthetic member-owned')
    const png = new PNG({ width: 1, height: 1 })
    png.data.fill(255)
    const image = 'data:image/png;base64,' + Buffer.from(PNG.sync.write(png)).toString('base64')
    assert.ok((await avatar(image))?.startsWith('data:image/png;base64,'))
    await assert.rejects(avatar('data:image/png;base64,bad'))
    await request(
      '/api/v1/users/me/profile',
      { displayName: 'Updated', avatarUrl: image },
      'POST',
      memberAccess,
    )
    assert.equal(
      (await request('/api/v1/users/me', undefined, 'GET', memberAccess)).displayName,
      'Updated',
    )
  } finally {
    await proxy.dispose()
  }
})
