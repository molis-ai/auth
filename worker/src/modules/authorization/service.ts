import { fields, hash, requireThat as ok, str, tokenPattern } from '../../shared/http.ts'
import { Auth } from '../identity/service.ts'
import { decision } from './policy.ts'
export async function authorize(a: Auth, operation: string, b: Record<string, unknown>) {
  ok(!a.request.headers.has('Origin'), 403, 'ORIGIN_NOT_ALLOWED')
  const service = (a.request.headers.get('Authorization') ?? '').replace(/^Bearer /i, ''),
    token = a.request.headers.get('X-User-Token') ?? ''
  ok(tokenPattern.test(service) && tokenPattern.test(token), 401, 'SERVICE_UNAUTHENTICATED')
  await a.rate('authorization-ip', a.request.headers.get('CF-Connecting-IP') ?? 'local', 300)
  const p = await a.principal(token)
  ok(p.scopes.includes('account'), 403, 'USER_SCOPE_REQUIRED')
  const app = await a.s.one<{ application_id: string; actions: string; grants: string }>(
    "SELECT s.application_id,app.actions,app.grants FROM auth_service_token t JOIN auth_service s ON s.id=t.service_id JOIN auth_application app ON app.id=s.application_id WHERE t.token_hash=? AND t.expires_at>? AND t.credential_id=s.credential_id AND s.status='ACTIVE' AND app.status='ACTIVE'",
    await hash(service),
    Date.now(),
  )
  ok(app, 401, 'SERVICE_UNAUTHENTICATED')
  ok(app.application_id === p.applicationId, 403, 'APPLICATION_MISMATCH')
  const decisionId = crypto.randomUUID(),
    actions = JSON.parse(app.actions) as string[],
    grants = JSON.parse(app.grants) as Record<string, boolean>
  let result: unknown, space: string | undefined
  if (operation === 'activity') {
    fields(b, [])
    await a.s.batch([
      a.s.statement(
        'UPDATE auth_authentication SET activity_at=max(activity_at,?) WHERE id=?',
        Date.now(),
        p.authenticationId,
      ),
    ])
    result = { recorded: true, decisionId }
  } else if (operation === 'spaces') {
    fields(b, ['action'], ['cursor', 'limit'])
    const action = str(b.action, 100),
      limit = Number(b.limit ?? 50),
      cursor = str(b.cursor ?? '')
    ok(Number.isInteger(limit) && limit >= 1 && limit <= 200)
    // Filter in SQL through role grants before pagination; no truncation before authorization.
    const eligible = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'].flatMap((role) =>
      ['ACTIVE', 'ARCHIVED'].flatMap((status) =>
        ['PERSONAL', 'TEAM']
          .filter((type) => decision(role, status, type, action, actions, grants) === 'NONE')
          .map((type) => ({ role, status, type })),
      ),
    )
    const clauses = eligible.map(() => '(m.role=? AND s.status=? AND s.space_type=?)')
    const rows = clauses.length
      ? await a.s.all<{
          id: string
          name: string
          spaceType: string
          status: string
          role: string
        }>(
          `SELECT s.id,s.name,s.space_type spaceType,s.status,m.role FROM auth_space s JOIN auth_membership m ON m.space_id=s.id WHERE m.user_id=? AND s.id>? AND (${clauses.join(' OR ')}) ORDER BY s.id LIMIT ?`,
          p.userId,
          cursor,
          ...eligible.flatMap((x) => [x.role, x.status, x.type]),
          limit + 1,
        )
      : []
    result = {
      spaces: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
      decisionId,
    }
  } else {
    fields(
      b,
      operation === 'check' ? ['spaceId', 'action'] : ['spaceId'],
      operation === 'check' ? ['resourceType', 'resourceId'] : [],
    )
    space = str(b.spaceId, 36)
    ok(/^[0-9a-f-]{36}$/i.test(space))
    ok((b.resourceId === undefined) === (b.resourceType === undefined))
    if (b.resourceId !== undefined) ok(str(b.resourceId) !== token && b.resourceId !== service)
    const row = await a.s.one<{ status: string; space_type: string; role: string | null }>(
      'SELECT s.status,s.space_type,m.role FROM auth_space s LEFT JOIN auth_membership m ON m.space_id=s.id AND m.user_id=? WHERE s.id=?',
      p.userId,
      space,
    )
    if (operation === 'allowed-actions') {
      ok(row?.role, 403, 'NO_MEMBERSHIP')
      result = {
        allowedActions: actions.filter(
          (x) => decision(row.role, row.status, row.space_type, x, actions, grants) === 'NONE',
        ),
        role: row.role,
        decisionId,
      }
    } else {
      const reason = decision(
        row?.role ?? null,
        row?.status ?? '',
        row?.space_type ?? '',
        str(b.action, 100),
        actions,
        grants,
      )
      result = { allowed: reason === 'NONE', reason, decisionId }
    }
  }
  await a.s.db.batch([
    a.s.audit('authorization.' + operation, p.userId, a.requestId, {
      space,
      app: p.applicationId,
      summary: JSON.stringify(result),
    }),
  ])
  return result
}
