import { paginate } from '../../infrastructure/pagination.ts'
import { avatar } from '../../security/avatar.ts'
import { fields, iso, name, requireThat as ok } from '../../shared/http.ts'
import { providers } from '../federation/capabilities.ts'
import { Auth, type Principal } from '../identity/service.ts'

export class AccountService {
  readonly auth: Auth
  readonly principal: Principal
  constructor(auth: Auth, principal: Principal) {
    this.auth = auth
    this.principal = principal
  }
  async profile(b: Record<string, unknown>) {
    const a = this.auth,
      p = this.principal,
      s = a.s

    fields(b, ['displayName', 'avatarUrl'])
    const displayName = name(b.displayName),
      avatarUrl = await avatar(b.avatarUrl)
    await s.batch([
      s.statement(
        'UPDATE auth_user SET display_name=?,avatar_data=?,updated_at=? WHERE id=?',
        displayName,
        avatarUrl,
        Date.now(),
        p.userId,
      ),
      s.audit('account.profile.update', p.userId, a.requestId),
    ])
    return a.me({ ...p, displayName, avatarUrl })
  }
  async loginMethods() {
    const a = this.auth,
      p = this.principal,
      s = a.s
    const enabled = providers(a.env)
    return {
      userId: p.userId,
      password: !!(await s.one(
        'SELECT user_id FROM auth_local_credential WHERE user_id=?',
        p.userId,
      )),
      availableProviders: enabled,
      external: (
        await s.all<{ id: string; provider: string }>(
          'SELECT id,provider FROM auth_external_identity WHERE user_id=?',
          p.userId,
        )
      ).map((x) => ({ ...x, available: enabled.includes(x.provider.toLowerCase()) })),
    }
  }
  async authentications(url: URL) {
    const a = this.auth,
      p = this.principal,
      s = a.s

    const result = await paginate<{
      id: string
      created_at: number
      activity_at: number
      revoked_at: number | null
      applicationSessionCount: number
    }>(
      s,
      url,
      'SELECT a.*,(SELECT count(*) FROM auth_grant WHERE authentication_id=a.id AND revoked_at IS NULL) applicationSessionCount FROM auth_authentication a WHERE a.user_id=?',
      [p.userId],
      'created_at DESC,id DESC',
    )
    return {
      ...result,
      items: result.items.map((x) => {
        const expiry = Math.min(x.created_at + 90 * 86400000, x.activity_at + 30 * 86400000)
        return {
          id: x.id,
          current: x.id === p.authenticationId,
          authenticatedAt: iso(x.created_at),
          lastUserActivityAt: iso(x.activity_at),
          expiresAt: iso(expiry),
          revokedAt: x.revoked_at === null ? null : iso(x.revoked_at),
          status: x.revoked_at !== null ? 'REVOKED' : expiry > Date.now() ? 'ACTIVE' : 'EXPIRED',
          applicationSessionCount: x.applicationSessionCount,
        }
      }),
    }
  }
  async revoke(id: string) {
    const a = this.auth,
      p = this.principal,
      s = a.s
    ok(
      await s.one('SELECT id FROM auth_authentication WHERE id=? AND user_id=?', id, p.userId),
      404,
      'NOT_FOUND',
    )
    await s.batch([
      s.statement(
        'UPDATE auth_authentication SET revoked_at=? WHERE id=? AND user_id=?',
        Date.now(),
        id,
        p.userId,
      ),
      s.audit('account.session.revoke', p.userId, a.requestId),
    ])
    return { revoked: true, current: id === p.authenticationId }
  }
  async securityEvents(url: URL) {
    const a = this.auth,
      p = this.principal,
      s = a.s

    const result = await paginate<{ occurredAt: number }>(
      s,
      url,
      'SELECT id,action,outcome,occurred_at occurredAt,request_id requestId,application_id applicationId,NULL authorizationSessionId,NULL authenticationSessionId FROM auth_audit_event WHERE target_user_id=?',
      [p.userId],
      'occurredAt DESC,id DESC',
    )
    return { ...result, items: result.items.map((x) => ({ ...x, occurredAt: iso(x.occurredAt) })) }
  }
  async unlink(id: string) {
    const a = this.auth,
      p = this.principal,
      s = a.s
    ok(
      await s.one('SELECT id FROM auth_external_identity WHERE id=? AND user_id=?', id, p.userId),
      404,
      'NOT_FOUND',
    )
    await s.batch(
      [
        s.guard(
          'EXISTS(SELECT 1 FROM auth_local_credential WHERE user_id=?) OR EXISTS(SELECT 1 FROM auth_external_identity WHERE user_id=? AND id<>?)',
          [p.userId, p.userId, id],
        ),
        s.statement('DELETE FROM auth_external_identity WHERE id=? AND user_id=?', id, p.userId),
        s.statement(
          'UPDATE auth_authentication SET revoked_at=? WHERE user_id=?',
          Date.now(),
          p.userId,
        ),
        s.audit('account.identity.unlink', p.userId, a.requestId),
      ],
      'LAST_LOGIN_METHOD',
    )
    return { unlinked: true, loggedOut: true }
  }
}
