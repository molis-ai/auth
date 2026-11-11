import { validateNamed } from '../../contracts/unified-account/validate.ts'
import schemas from '../../contracts/unified-account/schemas.json' with { type: 'json' }

/** Host-local, first administrator only. Never called by a public HTTP route. */
export async function bootstrapPlatform(db, userId) {
  if (!validateNamed('Id', userId)) throw new Error('Invalid target user ID')
  const permission = schemas.$defs.PlatformCapability.enum
  const now = Date.now(),
    request = crypto.randomUUID()
  const statement = (sql, ...values) => db.prepare(sql).bind(...values)
  // Check and writes belong to the same D1 batch; even revoked grants require an explicit recovery flow.
  await db.batch([
    statement(
      "INSERT INTO auth_write_guard(id,ok) VALUES (?,CASE WHEN NOT EXISTS(SELECT 1 FROM auth_platform_permission) AND EXISTS(SELECT 1 FROM auth_user u JOIN auth_user_security s ON s.user_id=u.id WHERE u.id=? AND u.status='ACTIVE') THEN 1 ELSE 0 END)",
      request,
      userId,
    ),
    ...permission.map((value) =>
      statement(
        "INSERT INTO auth_platform_permission(user_id,permission,status,granted_by,granted_at) VALUES (?,?,'ACTIVE',?,?)",
        userId,
        value,
        userId,
        now,
      ),
    ),
    statement(
      "INSERT INTO auth_audit_event(id,action,outcome,actor_user_id,target_user_id,request_id,occurred_at,change_summary) VALUES (?,'platform.bootstrap','SUCCESS',?,?,?,?,?)",
      crypto.randomUUID(),
      userId,
      userId,
      request,
      now,
      JSON.stringify({ capabilities: permission }),
    ),
    statement('DELETE FROM auth_write_guard WHERE id=?', request),
  ])
  return { userId, capabilities: permission }
}
