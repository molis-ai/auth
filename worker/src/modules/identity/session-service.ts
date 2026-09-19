import {
  cookieHeader,
  hash,
  requireThat as ok,
  rootCookie,
  tokenPattern,
} from '../../shared/http.ts'
import type { Auth } from './service.ts'
import { alive } from './session-policy.ts'
import type { Principal } from './types.ts'

export async function root(auth: Auth, id: string) {
  const now = Date.now()
  const a = await auth.s.one<{
    id: string
    user_id: string
    created_at: number
    activity_at: number
  }>(
    `SELECT a.* FROM auth_authentication a JOIN auth_user u ON u.id=a.user_id WHERE a.id=? AND ${alive}`,
    id,
    now,
    now,
  )
  ok(a, 401, 'LOGIN_REQUIRED')
  return a
}

export async function principal(auth: Auth, token?: string): Promise<Principal> {
  token ??= (auth.request.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  ok(tokenPattern.test(token), 401, 'INVALID_TOKEN')
  const now = Date.now()
  const row = await auth.s.one<{
    userId: string
    displayName: string
    avatarUrl: string | null
    applicationId: string
    clientId: string
    sessionId: string
    authenticationId: string
    scopes: string
  }>(
    `SELECT u.id userId,u.display_name displayName,u.avatar_data avatarUrl,c.application_id applicationId,c.client_id clientId,g.id sessionId,a.id authenticationId,g.scopes FROM auth_access_token t JOIN auth_grant g ON g.id=t.grant_id JOIN auth_authentication a ON a.id=g.authentication_id JOIN auth_user u ON u.id=a.user_id JOIN auth_client c ON c.client_id=g.client_id JOIN auth_application app ON app.id=c.application_id WHERE t.token_hash=? AND t.expires_at>? AND g.revoked_at IS NULL AND c.status='ACTIVE' AND app.status='ACTIVE' AND ${alive}`,
    await hash(token),
    now,
    now,
    now,
  )
  ok(row, 401, 'INVALID_TOKEN')
  const c = await auth.client(row.clientId)
  auth.origin(c)
  const scopes = JSON.parse(row.scopes) as string[]
  ok(
    scopes.every((x) => JSON.parse(c.scopes).includes(x)),
    401,
    'INVALID_TOKEN',
  )
  const digest = await hash(token)
  auth.s.authorizationGuard = () => {
    const time = Date.now()
    return auth.s.guard(
      `EXISTS(SELECT 1 FROM auth_access_token t JOIN auth_grant g ON g.id=t.grant_id JOIN auth_authentication a ON a.id=g.authentication_id JOIN auth_user u ON u.id=a.user_id JOIN auth_client c ON c.client_id=g.client_id JOIN auth_application app ON app.id=c.application_id WHERE t.token_hash=? AND t.expires_at>? AND g.revoked_at IS NULL AND c.status='ACTIVE' AND app.status='ACTIVE' AND c.version=? AND ${alive})`,
      [digest, time, c.version, time, time],
    )
  }
  return {
    ...row,
    scopes,
    platformAdmin: (auth.env.PLATFORM_ADMIN_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .includes(row.userId),
  }
}

export async function me(auth: Auth, p: Principal) {
  return {
    userId: p.userId,
    displayName: p.displayName,
    avatarUrl: p.avatarUrl,
    applicationId: p.applicationId,
    clientId: p.clientId,
    sessionId: p.sessionId,
    scopes: p.scopes,
    emails: (
      await auth.s.all<{ canonical_email: string }>(
        'SELECT canonical_email FROM auth_user_email WHERE user_id=?',
        p.userId,
      )
    ).map((x) => x.canonical_email),
  }
}

export async function logout(auth: Auth, p: Principal, all: boolean) {
  await auth.s.batch([
    all
      ? auth.s.statement(
          'UPDATE auth_authentication SET revoked_at=? WHERE user_id=?',
          Date.now(),
          p.userId,
        )
      : auth.s.statement(
          'UPDATE auth_authentication SET revoked_at=? WHERE id=?',
          Date.now(),
          p.authenticationId,
        ),
    auth.s.audit(all ? 'account.logout.all' : 'account.logout', p.userId, auth.requestId),
  ])
  auth.cookies.push(cookieHeader(auth.env.AUTH_ORIGIN, rootCookie(auth.env.AUTH_ORIGIN), '', 0))
  return { loggedOut: true }
}
