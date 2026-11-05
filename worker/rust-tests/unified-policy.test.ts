import test from 'node:test'
import assert from 'node:assert/strict'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { challenge, hash, secret } from './fixtures.ts'

type Team = { id: string; name: string; version: number; status: string }
type Invitation = { id: string; spaceId: string; status: string }
type Page<T> = { items: T[]; total?: number; nextCursor?: string | null }
type Session = { access: string; refresh: string; root: string; grant: string }
type Envelope = { data?: unknown; error?: { code: string } }

test('UAS-11/14/16/34/35: v1 policy boundaries preserve legacy teams and isolate managed tenants', async (t) => {
  const origin = 'http://127.0.0.1:8787'
  const owner = crypto.randomUUID()
  const member = crypto.randomUUID()
  const invitee = crypto.randomUUID()
  const administrator = crypto.randomUUID()
  const application = crypto.randomUUID()
  const legacyClient = 'policy-legacy-' + crypto.randomUUID()
  const migratingClient = 'policy-migrating-' + crypto.randomUUID()
  const redirect = origin + '/policy/callback'
  const proxy = await getRustProxy({ AUTH_ORIGIN: origin, PLATFORM_ADMIN_IDS: administrator })
  try {
    await initializeLocalRuntime(proxy)
    const db = proxy.env.DB
    const now = Date.now()
    const statement = (sql: string, ...values: (string | number)[]) =>
      db.prepare(sql).bind(...values)
    await db.batch([
      statement(
        'INSERT INTO auth_application(id,name,actions) VALUES (?,?,?)',
        application,
        'Policy fixture',
        JSON.stringify(['project.read', 'space.archive', 'space.restore']),
      ),
      ...[legacyClient, migratingClient].map((client) =>
        statement(
          'INSERT INTO auth_client(id,client_id,application_id,client_type,scopes,redirects) VALUES (?,?,?,?,?,?)',
          crypto.randomUUID(),
          client,
          application,
          'WEB',
          '["account","profile"]',
          JSON.stringify([redirect]),
        ),
      ),
      ...[owner, member, invitee, administrator].map((user) =>
        statement(
          "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,?,'ACTIVE',?,?)",
          user,
          'Policy fixture ' + user,
          now,
          now,
        ),
      ),
      statement(
        'INSERT INTO auth_user_email(id,user_id,canonical_email,created_at) VALUES (?,?,?,?)',
        crypto.randomUUID(),
        invitee,
        'policy-invitee@example.test',
        now,
      ),
      statement(
        "INSERT INTO auth_environment(id,kind,auth_origin,delivery_mode,provider_mode,created_at,updated_at) VALUES (?,'TEST',?,'MOCK','MOCK',?,?)",
        'policy-test',
        origin,
        now,
        now,
      ),
    ])

    async function session(user: string, client = legacyClient): Promise<Session> {
      const root = crypto.randomUUID()
      const grant = crypto.randomUUID()
      const access = secret()
      const refresh = secret()
      await db.batch([
        statement(
          'INSERT INTO auth_authentication(id,user_id,created_at,activity_at) VALUES (?,?,?,?)',
          root,
          user,
          now,
          now,
        ),
        statement(
          'INSERT INTO auth_grant(id,authentication_id,client_id,scopes,created_at) VALUES (?,?,?,?,?)',
          grant,
          root,
          client,
          '["account","profile"]',
          now,
        ),
        statement(
          'INSERT INTO auth_access_token VALUES (?,?,?)',
          hash(access),
          grant,
          now + 900_000,
        ),
        statement(
          'INSERT INTO auth_refresh_token VALUES (?,?,?,NULL)',
          hash(refresh),
          grant,
          now + 86_400_000,
        ),
      ])
      return { access, refresh, root, grant }
    }
    const ownerSession = await session(owner)
    const memberSession = await session(member)
    const inviteeSession = await session(invitee)
    const adminSession = await session(administrator, 'molis-auth-console')
    const migratingSession = await session(owner, migratingClient)

    async function request(
      path: string,
      data?: unknown,
      method = data === undefined ? 'GET' : 'POST',
      access = ownerSession.access,
      extra: Record<string, string> = {},
    ) {
      const response = await proxy.fetch(
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
      )
      return { response, body: (await response.json()) as Envelope }
    }
    async function ok<T>(...args: Parameters<typeof request>): Promise<T> {
      const { response, body } = await request(...args)
      assert.equal(response.status, 200, args[0])
      return body.data as T
    }
    async function denied(
      path: string,
      data?: unknown,
      method = data === undefined ? 'GET' : 'POST',
      access = ownerSession.access,
      code = 'TENANT_API_REQUIRED',
      extra: Record<string, string> = {},
      status = 403,
    ) {
      const result = await request(path, data, method, access, extra)
      assert.equal(result.response.status, status, path)
      assert.equal(result.body.error?.code, code, path)
      assert.equal(result.body.data, undefined, path)
    }
    const createTeam = (name: string) => ok<Team>('/api/v1/spaces', { name })
    const invite = (space: string) =>
      ok<Invitation>('/api/v1/spaces/' + space + '/invitations', {
        email: 'policy-invitee@example.test',
        locale: 'en',
      })
    async function markManaged(space: string, status = 'ACTIVE') {
      await statement(
        'INSERT INTO auth_managed_tenant(space_id,status,managed_by,managed_at,updated_at) VALUES (?,?,?,?,?)',
        space,
        status,
        administrator,
        now,
        now,
      ).run()
    }
    async function snapshot(space: string) {
      const rows = await db.batch([
        statement('SELECT * FROM auth_space WHERE id=?', space),
        statement('SELECT * FROM auth_membership WHERE space_id=? ORDER BY user_id', space),
        statement('SELECT * FROM auth_invitation WHERE space_id=? ORDER BY id', space),
      ])
      return JSON.stringify(rows.map((result) => result.results))
    }

    const legacy = await createTeam('Visible legacy team')
    const active = await createTeam('Hidden managed active')
    const disabled = await createTeam('Hidden managed disabled')
    const archived = await createTeam('Hidden managed legacy archive')
    const activeInvite = await invite(active.id)
    const disabledInvite = await invite(disabled.id)
    const legacyInvite = await invite(legacy.id)
    await db.batch(
      [active, disabled, archived].map((team) =>
        statement("INSERT INTO auth_membership VALUES (?,?,'MEMBER',?)", team.id, member, now),
      ),
    )
    await ok(
      '/api/v1/spaces/' + archived.id + '/archive',
      { archived: true, version: archived.version },
      'PUT',
    )
    await markManaged(active.id)
    await markManaged(disabled.id, 'DISABLED')
    await markManaged(archived.id, 'DISABLED')

    await t.test(
      'legacy list SQL filters managed rows before totals and cursors, including administrators and invitations',
      async () => {
        for (const [path, access] of [
          ['/api/v1/spaces?page=1&limit=1', ownerSession.access],
          ['/api/v1/spaces/teams?page=1&limit=1', adminSession.access],
        ]) {
          const result = await ok<Page<Team>>(path, undefined, 'GET', access)
          assert.equal(result.total, 1)
          assert.deepEqual(
            result.items.map((team) => team.id),
            [legacy.id],
          )
        }
        const cursor = await ok<Page<Team>>('/api/v1/spaces?limit=1')
        assert.deepEqual(
          cursor.items.map((team) => team.id),
          [legacy.id],
        )
        assert.equal(cursor.nextCursor, null)
        const pending = await ok<Page<Invitation>>(
          '/api/v1/invitations?page=1&limit=1',
          undefined,
          'GET',
          inviteeSession.access,
        )
        assert.equal(pending.total, 1)
        assert.deepEqual(
          pending.items.map((entry) => entry.id),
          [legacyInvite.id],
        )
      },
    )

    await t.test(
      'all managed space and invitation routes reject reads and writes without changing business rows',
      async () => {
        for (const [team, invitation] of [
          [active, activeInvite],
          [disabled, disabledInvite],
        ] as const) {
          const before = await snapshot(team.id)
          const base = '/api/v1/spaces/' + team.id
          for (const suffix of ['', '/members', '/invitations', '/audit'])
            await denied(base + suffix)
          await denied(base, { name: 'Must not change', version: team.version }, 'PUT')
          await denied(base + '/invite-candidates', { query: 'policy' })
          await denied(base + '/invitations', {
            email: 'policy-invitee@example.test',
            locale: 'en',
          })
          for (const archived of [true, false])
            await denied(base + '/archive', { archived, version: team.version }, 'PUT')
          await denied(base + '/members/' + member + '/role', { role: 'ADMIN' }, 'PUT')
          await denied(base + '/members/' + member + '/remove', {})
          await denied(base + '/leave', {}, 'POST', memberSession.access)
          await denied(base + '/invitations/' + invitation.id + '/revoke', {})
          await denied(
            '/api/v1/invitations/' + invitation.id,
            undefined,
            'GET',
            inviteeSession.access,
          )
          for (const action of ['accept', 'decline']) {
            await denied(
              '/api/v1/invitations/' + invitation.id + '/' + action,
              {},
              'POST',
              inviteeSession.access,
            )
          }
          await denied(base, undefined, 'GET', adminSession.access)
          await denied(
            base + '/archive',
            { archived: false, version: team.version },
            'PUT',
            adminSession.access,
          )
          assert.equal(await snapshot(team.id), before)
        }
        await denied('/api/v1/spaces/' + archived.id)
        await denied(
          '/api/v1/spaces/' + archived.id + '/archive',
          { archived: false, version: 1 },
          'PUT',
        )
      },
    )

    const service = await ok<{ clientId: string; secret: string }>(
      '/api/v1/platform/applications/' + application + '/services',
      { name: 'Policy backend' },
      'POST',
      adminSession.access,
    )
    const serviceResponse = await proxy.fetch(
      new Request(origin + '/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + btoa(service.clientId + ':' + service.secret),
        },
        // Service credentials intentionally have no user client_id in the body.
        body: 'grant_type=client_credentials',
      }),
    )
    assert.equal(serviceResponse.status, 200)
    const serviceAccess = ((await serviceResponse.json()) as { access_token: string }).access_token
    const serviceHeaders = { Origin: '', 'X-User-Token': ownerSession.access }

    await t.test(
      'service authorization cannot expose or grant managed tenants; legacy checks and activity still work',
      async () => {
        const check = await ok<{ allowed: boolean }>(
          '/api/v1/authorization/check',
          {
            spaceId: legacy.id,
            action: 'project.read',
          },
          'POST',
          serviceAccess,
          serviceHeaders,
        )
        assert.equal(check.allowed, true)
        const allowed = await ok<{ allowedActions: string[] }>(
          '/api/v1/authorization/allowed-actions',
          {
            spaceId: legacy.id,
          },
          'POST',
          serviceAccess,
          serviceHeaders,
        )
        assert.ok(allowed.allowedActions.includes('project.read'))
        const spaces = await ok<{ spaces: Team[]; nextCursor: string | null }>(
          '/api/v1/authorization/spaces',
          {
            action: 'project.read',
            limit: 1,
          },
          'POST',
          serviceAccess,
          serviceHeaders,
        )
        assert.deepEqual(
          spaces.spaces.map((team) => team.id),
          [legacy.id],
        )
        assert.equal(spaces.nextCursor, null)
        await ok('/api/v1/authorization/activity', {}, 'POST', serviceAccess, serviceHeaders)
        for (const team of [active, disabled, archived]) {
          await denied(
            '/api/v1/authorization/check',
            { spaceId: team.id, action: 'project.read' },
            'POST',
            serviceAccess,
            'TENANT_API_REQUIRED',
            serviceHeaders,
          )
          await denied(
            '/api/v1/authorization/allowed-actions',
            { spaceId: team.id },
            'POST',
            serviceAccess,
            'TENANT_API_REQUIRED',
            serviceHeaders,
          )
        }
        await denied(
          '/api/v1/authorization/check',
          { spaceId: legacy.id, action: 'project.read' },
          'POST',
          serviceAccess,
          'APPLICATION_MISMATCH',
          {
            Origin: '',
            'X-User-Token': adminSession.access,
          },
        )
        await denied(
          '/api/v1/authorization/check',
          { spaceId: legacy.id, action: 'project.read' },
          'POST',
          serviceAccess,
          'SERVICE_UNAUTHENTICATED',
          { Origin: '' },
          401,
        )
      },
    )

    await t.test(
      'a later managed transition redacts historical aggregate audit details without losing event metadata',
      async () => {
        type Audit = { id: string; action: string; changeSummary: string | null }
        const control = (await db
          .prepare(
            "SELECT id,change_summary FROM auth_audit_event WHERE action='authorization.spaces' LIMIT 1",
          )
          .first()) as { id: string; change_summary: string }
        assert.ok(control)
        const historical = await createTeam('Historical tenant name must disappear')
        const listed = await ok<{ spaces: Team[] }>(
          '/api/v1/authorization/spaces',
          {
            action: 'project.read',
          },
          'POST',
          serviceAccess,
          serviceHeaders,
        )
        assert.ok(listed.spaces.some((team) => team.id === historical.id))
        const event = (await statement(
          "SELECT id,change_summary FROM auth_audit_event WHERE action='authorization.spaces' AND instr(change_summary,?)>0",
          historical.id,
        ).first()) as { id: string; change_summary: string }
        assert.ok(event)
        const before = await ok<Page<Audit>>(
          '/api/v1/platform/audit?limit=100',
          undefined,
          'GET',
          adminSession.access,
        )
        assert.equal(
          before.items.find((entry) => entry.id === event.id)?.changeSummary,
          event.change_summary,
        )

        await markManaged(historical.id)
        const after = await ok<Page<Audit>>(
          '/api/v1/platform/audit?limit=100',
          undefined,
          'GET',
          adminSession.access,
        )
        const redacted = after.items.find((entry) => entry.id === event.id)
        assert.ok(redacted, 'the audit event itself remains visible')
        assert.equal(redacted.action, 'authorization.spaces')
        assert.equal(redacted.changeSummary, null)
        assert.equal(
          after.items.find((entry) => entry.id === control.id)?.changeSummary,
          control.change_summary,
        )
        assert.ok(!JSON.stringify(after).includes(historical.name))
      },
    )

    await t.test(
      'legacy writes and invitation acceptance remain usable for unmanaged teams',
      async () => {
        const updated = await ok<Team>(
          '/api/v1/spaces/' + legacy.id,
          { name: 'Legacy updated', version: 0 },
          'PUT',
        )
        assert.equal(updated.name, 'Legacy updated')
        await ok(
          '/api/v1/invitations/' + legacyInvite.id + '/accept',
          {},
          'POST',
          inviteeSession.access,
        )
        await ok(
          '/api/v1/spaces/' + legacy.id + '/members/' + invitee + '/role',
          { role: 'ADMIN' },
          'PUT',
        )
        await ok(
          '/api/v1/spaces/' + legacy.id + '/members/' + invitee + '/role',
          { role: 'MEMBER' },
          'PUT',
        )
        await ok('/api/v1/spaces/' + legacy.id + '/leave', {}, 'POST', inviteeSession.access)
        const archived = await ok<Team>(
          '/api/v1/spaces/' + legacy.id + '/archive',
          { archived: true, version: updated.version },
          'PUT',
        )
        assert.equal(archived.status, 'ARCHIVED')
        assert.equal((await ok<Team>('/api/v1/spaces/' + legacy.id)).status, 'ARCHIVED')
        const restored = await ok<Team>(
          '/api/v1/spaces/' + legacy.id + '/archive',
          { archived: false, version: archived.version },
          'PUT',
        )
        assert.equal(restored.status, 'ACTIVE')
      },
    )

    await t.test(
      'managed policy is rechecked in mutation and authorization batches, after request-time reads',
      async () => {
        const target = await createTeam('Concurrent managed transition')
        const invitation = await invite(target.id)
        const before = await snapshot(target.id)
        // This isolated trigger injects the transition at batch admission, after the
        // HTTP handler has read an unmanaged space. Its insert rolls back together
        // with the rejected operation, proving the production guard rejects writes.
        const trigger = `CREATE TRIGGER policy_managed_at_batch BEFORE INSERT ON auth_write_guard
        WHEN NOT EXISTS(SELECT 1 FROM auth_managed_tenant WHERE space_id='${target.id}')
        BEGIN
          INSERT INTO auth_managed_tenant(space_id,status,managed_by,managed_at,updated_at)
          VALUES ('${target.id}','ACTIVE','${administrator}',${now},${now});
        END`
        await db.prepare(trigger).run()
        try {
          await denied(
            '/api/v1/spaces/' + target.id,
            { name: 'Must roll back', version: 0 },
            'PUT',
            ownerSession.access,
            'VERSION_CONFLICT',
            {},
            409,
          )
          await denied(
            '/api/v1/invitations/' + invitation.id + '/accept',
            {},
            'POST',
            inviteeSession.access,
            'INVITATION_NOT_AVAILABLE',
            {},
            409,
          )
          await denied(
            '/api/v1/authorization/check',
            { spaceId: target.id, action: 'project.read' },
            'POST',
            serviceAccess,
            'VERSION_CONFLICT',
            serviceHeaders,
            409,
          )
        } finally {
          await db.prepare('DROP TRIGGER policy_managed_at_batch').run()
        }
        assert.equal(await snapshot(target.id), before)
        assert.equal(
          await statement(
            'SELECT count(*) n FROM auth_managed_tenant WHERE space_id=?',
            target.id,
          ).first('n'),
          0,
        )
      },
    )

    await t.test(
      'UAS-11/29: switching client policy blocks pending v1 transactions and all old token paths',
      async () => {
        const verifier = secret()
        const transactionInput = {
          clientId: migratingClient,
          redirectUri: redirect,
          codeChallenge: challenge(verifier),
          codeChallengeMethod: 'S256',
          state: secret(),
          scopes: ['account', 'profile'],
        }
        const pending = await ok<{ transaction: string }>(
          '/api/v1/auth/transactions',
          transactionInput,
        )
        const code = secret()
        await statement(
          'INSERT INTO auth_code(token_hash,client_id,redirect_uri,challenge,scopes,authentication_id,expires_at) VALUES (?,?,?,?,?,?,?)',
          hash(code),
          migratingClient,
          redirect,
          challenge(verifier),
          '["account","profile"]',
          migratingSession.root,
          now + 60_000,
        ).run()
        await statement(
          "INSERT INTO auth_client_policy(client_id,policy_profile,environment_id,allowed_origins,created_at,updated_at) VALUES (?,'unified-account-v2',?,?,?,?)",
          migratingClient,
          'policy-test',
          JSON.stringify([origin]),
          now,
          now,
        ).run()
        const policyCode = 'CLIENT_POLICY_REQUIRES_V2'
        await denied(
          '/api/v1/auth/transactions',
          transactionInput,
          'POST',
          ownerSession.access,
          policyCode,
        )
        const headers = { 'X-Auth-Transaction': pending.transaction }
        const password = secret()
        for (const [operation, body] of [
          ['password', { email: 'policy-invitee@example.test', password }],
          ['signup', { email: 'new-policy@example.test', password, confirmPassword: password }],
          ['restore', {}],
          ['confirmation', {}],
          ['complete', { confirmation: secret(), confirmed: true }],
          ['cancel', { confirmation: secret() }],
        ] as const) {
          await denied(
            '/api/v1/auth/transactions/' + operation,
            body,
            'POST',
            ownerSession.access,
            policyCode,
            headers,
          )
        }
        await denied(
          '/api/v1/auth/transactions/context',
          undefined,
          'GET',
          ownerSession.access,
          policyCode,
          headers,
        )
        for (const path of [
          '/api/v1/users/me',
          '/api/v1/spaces',
          '/api/v1/spaces/' + active.id,
          '/api/v1/invitations',
        ]) {
          await denied(path, undefined, 'GET', migratingSession.access, policyCode)
        }
        await denied(
          '/api/v1/spaces',
          { name: 'Forbidden legacy creation' },
          'POST',
          migratingSession.access,
          policyCode,
        )
        await denied(
          '/api/v1/spaces/' + legacy.id + '/archive',
          { archived: true, version: 3 },
          'PUT',
          migratingSession.access,
          policyCode,
        )
        await denied(
          '/api/v1/spaces/' + active.id + '/members/' + member + '/role',
          { role: 'ADMIN' },
          'PUT',
          migratingSession.access,
          policyCode,
        )
        await denied(
          '/api/v1/sessions/current/logout',
          {},
          'POST',
          migratingSession.access,
          policyCode,
        )
        await denied(
          '/api/v1/authorization/check',
          { spaceId: legacy.id, action: 'project.read' },
          'POST',
          serviceAccess,
          policyCode,
          {
            Origin: '',
            'X-User-Token': migratingSession.access,
          },
        )
        const tokenRequests: Record<string, string>[] = [
          {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: redirect,
          },
          { grant_type: 'refresh_token', refresh_token: migratingSession.refresh },
        ]
        for (const fields of tokenRequests) {
          const response = await proxy.fetch(
            new Request(origin + '/oauth2/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ ...fields, client_id: migratingClient }).toString(),
            }),
          )
          assert.equal(response.status, 403)
          assert.equal(((await response.json()) as Envelope).error?.code, policyCode)
        }
        assert.equal(
          await statement(
            'SELECT status FROM auth_transaction WHERE token_hash=?',
            hash(pending.transaction),
          ).first('status'),
          'READY',
        )
        assert.equal(
          await statement('SELECT used_at FROM auth_code WHERE token_hash=?', hash(code)).first(
            'used_at',
          ),
          null,
        )
        assert.equal(
          await statement(
            'SELECT used_at FROM auth_refresh_token WHERE token_hash=?',
            hash(migratingSession.refresh),
          ).first('used_at'),
          null,
        )
        assert.equal(
          await statement(
            'SELECT revoked_at FROM auth_authentication WHERE id=?',
            migratingSession.root,
          ).first('revoked_at'),
          null,
        )
        assert.equal(
          await statement(
            'SELECT count(*) n FROM auth_user_email WHERE canonical_email=?',
            'new-policy@example.test',
          ).first('n'),
          0,
        )
        await ok('/api/v1/users/me')
      },
    )

    await t.test(
      'AUTH-02 keeps future v2 routes unavailable and implemented account routes reject v1 credentials',
      async () => {
        for (const path of ['/api/v2', '/api/v2/auth/providers']) {
          for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
            for (const access of [ownerSession.access, '']) {
              const result = await request(
                path,
                ['POST', 'PUT'].includes(method) ? {} : undefined,
                method,
                access,
              )
              assert.equal(result.response.status, 501, method + ' ' + path)
              assert.equal(result.body.error?.code, 'UNIFIED_ACCOUNT_NOT_IMPLEMENTED')
              assert.equal(result.body.data, undefined)
            }
          }
        }
        for (const access of [ownerSession.access, '']) {
          for (const path of [
            '/api/v2/users/me',
            '/api/v2/entitlements/check',
            '/api/v2/platform/tenants',
            '/api/v2/catalog/plans',
            '/api/v2/platform/subscriptions',
            '/api/v2/users/me/subscriptions',
            '/api/v2/platform/audit-events',
            '/api/v2/tenants/' + active.id + '/seat-assignments',
            '/api/v2/tenants/' + active.id,
          ]) {
            const result = await request(path, undefined, 'GET', access)
            assert.equal(result.response.status, 401)
            assert.equal(result.body.data, undefined)
          }
        }
      },
    )
  } finally {
    await proxy.dispose()
  }
})
