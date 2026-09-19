import { paginate } from '../../infrastructure/pagination.ts'
import { fields, hash, iso, name, requireThat as ok, secret, str } from '../../shared/http.ts'
import {
  capabilities,
  catalog,
  consoleActions,
  defaultGrant,
  roles,
} from '../authorization/policy.ts'
import { Auth, type Principal } from '../identity/service.ts'
interface App {
  id: string
  name: string
  status: string
  version: number
  actions: string
  grants: string
  is_console: number
}
export class Platform {
  readonly a: Auth
  readonly p: Principal
  constructor(a: Auth, p: Principal) {
    ok(p.platformAdmin, 403, 'PLATFORM_ADMIN_REQUIRED')
    this.a = a
    this.p = p
  }
  view(a: App) {
    return {
      id: a.id,
      name: a.name,
      status: a.status,
      version: a.version,
      actions: JSON.parse(a.actions),
    }
  }
  async app(id: string) {
    const a = await this.a.s.one<App>('SELECT * FROM auth_application WHERE id=?', id)
    ok(a, 404, 'NOT_FOUND')
    return a
  }
  async apps(url: URL) {
    const result = await paginate<App>(this.a.s, url, 'SELECT * FROM auth_application', [], 'id')
    return { ...result, items: result.items.map((a) => this.view(a)) }
  }
  async application(id: string | undefined, b: Record<string, unknown>) {
    fields(b, id ? ['name', 'status', 'actions', 'version'] : ['name', 'actions'])
    ok(
      Array.isArray(b.actions) &&
        b.actions.length <= 100 &&
        b.actions.every((x) => catalog.includes(x)),
    )
    const s = this.a.s,
      n = name(b.name),
      app = id ?? crypto.randomUUID()
    if (id) {
      const old = await this.app(id)
      ok(Number.isSafeInteger(b.version) && ['ACTIVE', 'DISABLED'].includes(str(b.status)))
      ok(!old.is_console || b.status === 'ACTIVE', 403, 'CONSOLE_PROTECTED')
      await s.batch([
        s.guard('EXISTS(SELECT 1 FROM auth_application WHERE id=? AND version=?)', [
          id,
          b.version as number,
        ]),
        s.statement(
          'UPDATE auth_application SET name=?,status=?,actions=?,version=version+1 WHERE id=?',
          n,
          b.status as string,
          JSON.stringify(b.actions),
          id,
        ),
        s.audit('platform.application.update', this.p.userId, this.a.requestId, { app }),
      ])
    } else
      await s.batch([
        s.statement(
          'INSERT INTO auth_application(id,name,actions) VALUES (?,?,?)',
          app,
          n,
          JSON.stringify(b.actions),
        ),
        s.audit('platform.application.create', this.p.userId, this.a.requestId, { app }),
      ])
    return this.view(await this.app(app))
  }
  async matrix(id: string) {
    const a = await this.app(id),
      actions: string[] = a.is_console ? capabilities : JSON.parse(a.actions),
      grants = JSON.parse(a.grants)
    return {
      console: !!a.is_console,
      application: { ...this.view(a), actions },
      roles: roles.map((role) => ({
        role,
        actions:
          a.status !== 'ACTIVE'
            ? []
            : a.is_console
              ? consoleActions(role)
              : actions.filter(
                  (action) => grants[role + ':' + action] ?? defaultGrant(role, action),
                ),
      })),
    }
  }
  async saveMatrix(id: string, b: Record<string, unknown>) {
    fields(b, ['grants', 'version'])
    const a = await this.app(id)
    ok(!a.is_console, 403, 'BUILTIN_PERMISSIONS_READ_ONLY')
    ok(a.status === 'ACTIVE', 409, 'APPLICATION_DISABLED')
    const actions: string[] = JSON.parse(a.actions),
      valid = roles.flatMap((r) => actions.map((x) => r + ':' + x))
    ok(
      Number.isSafeInteger(b.version) &&
        Array.isArray(b.grants) &&
        b.grants.length <= 400 &&
        b.grants.every((x) => valid.includes(x)),
    )
    const grants = b.grants as string[],
      mapping = Object.fromEntries(valid.map((x) => [x, grants.includes(x)])),
      s = this.a.s
    await s.batch([
      s.guard('EXISTS(SELECT 1 FROM auth_application WHERE id=? AND version=?)', [
        id,
        b.version as number,
      ]),
      s.statement(
        'UPDATE auth_application SET grants=?,version=version+1 WHERE id=?',
        JSON.stringify(mapping),
        id,
      ),
      s.audit('platform.permissions.update', this.p.userId, this.a.requestId, {
        app: id,
        summary: JSON.stringify(mapping),
      }),
    ])
    return { saved: true, version: (b.version as number) + 1 }
  }
  async clients(url: URL, app: string) {
    await this.app(app)
    const result = await paginate<Record<string, unknown>>(
      this.a.s,
      url,
      'SELECT id,client_id clientId,application_id applicationId,client_type clientType,status,version,scopes,redirects FROM auth_client WHERE application_id=?',
      [app],
      'id',
    )
    return {
      ...result,
      items: result.items.map((c) => ({
        ...c,
        scopes: JSON.parse(c.scopes as string),
        redirects: JSON.parse(c.redirects as string),
      })),
    }
  }
  async client(id: string): Promise<Record<string, unknown>> {
    const c = await this.a.s.one<Record<string, unknown>>(
      'SELECT id,client_id clientId,application_id applicationId,client_type clientType,status,version,scopes,redirects FROM auth_client WHERE client_id=?',
      id,
    )
    ok(c, 404, 'NOT_FOUND')
    return {
      ...c,
      scopes: JSON.parse(c.scopes as string),
      redirects: JSON.parse(c.redirects as string),
    }
  }
  async saveClient(app: string | undefined, id: string | undefined, b: Record<string, unknown>) {
    fields(
      b,
      id
        ? ['status', 'scopes', 'redirects', 'version']
        : ['clientId', 'clientType', 'scopes', 'redirects'],
    )
    const old = id ? await this.client(id) : null,
      clientId = id ?? str(b.clientId, 100),
      type = old?.clientType ?? str(b.clientType)
    ok(
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(clientId) &&
        !clientId.startsWith('svc_') &&
        ['WEB', 'MACOS', 'CLI'].includes(type as string),
    )
    ok(
      Array.isArray(b.scopes) &&
        b.scopes.length >= 1 &&
        b.scopes.length <= 2 &&
        b.scopes.every((x) => ['account', 'profile'].includes(x)),
    )
    ok(Array.isArray(b.redirects) && b.redirects.length >= 1 && b.redirects.length <= 20)
    for (const value of b.redirects) {
      const u = new URL(str(value))
      ok(
        !u.username &&
          !u.password &&
          !u.hash &&
          !u.searchParams.has('code') &&
          !u.searchParams.has('state'),
      )
      ok(
        u.protocol === 'https:' ||
          (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) ||
          (type !== 'WEB' && u.protocol === 'molis:'),
      )
    }
    const s = this.a.s
    if (old) {
      ok(Number.isSafeInteger(b.version) && ['ACTIVE', 'DISABLED'].includes(str(b.status)))
      if (clientId === 'molis-auth-console')
        ok(
          b.status === 'ACTIVE' &&
            (b.redirects as string[]).includes(this.a.env.AUTH_ORIGIN + '/console/callback') &&
            (b.scopes as string[]).includes('account'),
          403,
          'CONSOLE_PROTECTED',
        )
      await s.batch([
        s.guard('EXISTS(SELECT 1 FROM auth_client WHERE client_id=? AND version=?)', [
          clientId,
          b.version as number,
        ]),
        s.statement(
          'UPDATE auth_client SET status=?,scopes=?,redirects=?,version=version+1 WHERE client_id=?',
          b.status as string,
          JSON.stringify(b.scopes),
          JSON.stringify(b.redirects),
          clientId,
        ),
        s.audit('platform.client.update', this.p.userId, this.a.requestId),
      ])
    } else {
      await this.app(app!)
      await s.batch([
        s.statement(
          'INSERT INTO auth_client(id,client_id,application_id,client_type,scopes,redirects) VALUES (?,?,?,?,?,?)',
          crypto.randomUUID(),
          clientId,
          app!,
          type as string,
          JSON.stringify(b.scopes),
          JSON.stringify(b.redirects),
        ),
        s.audit('platform.client.create', this.p.userId, this.a.requestId, { app }),
      ])
    }
    return this.client(clientId)
  }
  async users(url: URL, id?: string) {
    const sql =
      'SELECT u.id,u.display_name displayName,u.status,(SELECT json_group_array(canonical_email) FROM auth_user_email WHERE user_id=u.id) emails FROM auth_user u'
    if (id) {
      const u = await this.a.s.one<{ emails: string }>(sql + ' WHERE u.id=?', id)
      ok(u, 404, 'NOT_FOUND')
      return { ...u, emails: JSON.parse(u.emails) }
    }
    const result = await paginate<{ emails: string }>(this.a.s, url, sql, [], 'id')
    return { ...result, items: result.items.map((x) => ({ ...x, emails: JSON.parse(x.emails) })) }
  }
  async userStatus(id: string, b: Record<string, unknown>) {
    fields(b, ['status'])
    ok(['ACTIVE', 'DISABLED'].includes(str(b.status)))
    ok(id !== this.p.userId, 403, 'SELF_DISABLE_FORBIDDEN')
    ok(
      !(this.a.env.PLATFORM_ADMIN_IDS ?? '')
        .split(',')
        .map((x) => x.trim())
        .includes(id),
      403,
      'ADMIN_PROTECTED',
    )
    await this.users(new URL(this.a.request.url), id)
    const s = this.a.s
    await s.batch([
      s.statement(
        'UPDATE auth_user SET status=?,updated_at=? WHERE id=?',
        b.status as string,
        Date.now(),
        id,
      ),
      ...(b.status === 'DISABLED'
        ? [
            s.statement(
              'UPDATE auth_authentication SET revoked_at=? WHERE user_id=?',
              Date.now(),
              id,
            ),
          ]
        : []),
      s.audit('platform.user.status', this.p.userId, this.a.requestId, { target: id }),
    ])
    return this.users(new URL(this.a.request.url), id)
  }
  async services(url: URL, app: string) {
    await this.app(app)
    return paginate(
      this.a.s,
      url,
      'SELECT id,client_id clientId,name,status,credential_id activeCredentialId FROM auth_service WHERE application_id=?',
      [app],
      'id',
    )
  }
  async service(
    app: string | undefined,
    id: string | undefined,
    b: Record<string, unknown>,
    disable = false,
  ) {
    fields(b, id ? [] : ['name'])
    const s = this.a.s,
      key = secret(),
      credential = crypto.randomUUID(),
      client = id ?? 'svc_' + crypto.randomUUID()
    if (id) {
      ok(await s.one('SELECT id FROM auth_service WHERE client_id=?', id), 404, 'NOT_FOUND')
      await s.batch(
        [
          ...(disable
            ? []
            : [
                s.guard(
                  "EXISTS(SELECT 1 FROM auth_service WHERE client_id=? AND status='ACTIVE')",
                  [id],
                ),
              ]),
          disable
            ? s.statement("UPDATE auth_service SET status='DISABLED' WHERE client_id=?", id)
            : s.statement(
                "UPDATE auth_service SET credential_id=?,secret_hash=? WHERE client_id=? AND status='ACTIVE'",
                credential,
                await hash(key),
                id,
              ),
          s.audit(
            disable ? 'platform.service.disable' : 'platform.service.rotate',
            this.p.userId,
            this.a.requestId,
          ),
        ],
        'SERVICE_DISABLED',
      )
    } else {
      await this.app(app!)
      await s.batch([
        s.statement(
          "INSERT INTO auth_service VALUES (?,?,?,?,'ACTIVE',?,?)",
          crypto.randomUUID(),
          client,
          app!,
          name(b.name),
          credential,
          await hash(key),
        ),
        s.audit('platform.service.create', this.p.userId, this.a.requestId, { app }),
      ])
    }
    return disable ? { disabled: true } : { clientId: client, secret: key }
  }
  async audit(url: URL) {
    const result = await paginate<{ occurredAt: number }>(
      this.a.s,
      url,
      'SELECT id,action,outcome,actor_user_id actorUserId,target_user_id targetUserId,application_id applicationId,occurred_at occurredAt,request_id requestId,change_summary changeSummary FROM auth_audit_event',
      [],
      'occurredAt DESC,id DESC',
    )
    return { ...result, items: result.items.map((x) => ({ ...x, occurredAt: iso(x.occurredAt) })) }
  }
}
