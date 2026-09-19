import {
  challenge,
  Failure,
  hash,
  requireThat as ok,
  secret,
  tokenPattern,
} from '../../shared/http.ts'
import type { Auth } from './service.ts'
import { alive, DAY } from './session-policy.ts'

export async function token(auth: Auth, b: URLSearchParams) {
  if (b.get('grant_type') === 'client_credentials') return auth.serviceToken(b)
  ok(!auth.request.headers.has('Authorization') && !b.has('client_secret'), 400, 'INVALID_CLIENT')
  const c = await auth.client(b.get('client_id') ?? '')
  auth.origin(c)
  await auth.rate('token-ip', auth.request.headers.get('CF-Connecting-IP') ?? 'local', 120)
  const now = Date.now(),
    access = secret(),
    refresh = secret()
  let grant: string, scopes: string, rootId: string
  const writes: D1PreparedStatement[] = []
  if (b.get('grant_type') === 'authorization_code') {
    const code = b.get('code') ?? '',
      verifier = b.get('code_verifier') ?? ''
    ok(tokenPattern.test(code) && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier), 400, 'INVALID_GRANT')
    const digest = await hash(code)
    const row = await auth.s.one<{
      client_id: string
      redirect_uri: string
      challenge: string
      scopes: string
      authentication_id: string
      expires_at: number
      used_at: number | null
    }>('SELECT * FROM auth_code WHERE token_hash=?', digest)
    ok(
      row &&
        row.client_id === c.client_id &&
        row.redirect_uri === b.get('redirect_uri') &&
        JSON.parse(c.redirects).includes(row.redirect_uri) &&
        row.expires_at > now &&
        row.used_at === null &&
        row.challenge === (await challenge(verifier)),
      400,
      'INVALID_GRANT',
    )
    grant = crypto.randomUUID()
    scopes = row.scopes
    rootId = row.authentication_id
    writes.push(
      auth.s.guard(
        'EXISTS(SELECT 1 FROM auth_code WHERE token_hash=? AND used_at IS NULL AND expires_at>?)',
        [digest, now],
      ),
      auth.s.statement('UPDATE auth_code SET used_at=? WHERE token_hash=?', now, digest),
      auth.s.statement(
        'INSERT INTO auth_grant(id,authentication_id,client_id,scopes,created_at) VALUES (?,?,?,?,?)',
        grant,
        rootId,
        c.client_id,
        scopes,
        now,
      ),
    )
  } else if (b.get('grant_type') === 'refresh_token') {
    const token = b.get('refresh_token') ?? ''
    ok(tokenPattern.test(token), 400, 'INVALID_GRANT')
    const digest = await hash(token)
    const row = await auth.s.one<{
      grant_id: string
      authentication_id: string
      client_id: string
      scopes: string
      used_at: number | null
      revoked_at: number | null
      expires_at: number
    }>(
      'SELECT r.*,g.authentication_id,g.client_id,g.scopes,g.revoked_at FROM auth_refresh_token r JOIN auth_grant g ON g.id=r.grant_id WHERE r.token_hash=?',
      digest,
    )
    ok(
      row && row.client_id === c.client_id && row.expires_at > now && row.revoked_at === null,
      400,
      'INVALID_GRANT',
    )
    if (row.used_at !== null) {
      await auth.s.run('UPDATE auth_grant SET revoked_at=? WHERE id=?', now, row.grant_id)
      throw new Failure(400, 'INVALID_GRANT')
    }
    grant = row.grant_id
    scopes = row.scopes
    rootId = row.authentication_id
    writes.push(
      auth.s.guard(
        'EXISTS(SELECT 1 FROM auth_refresh_token r JOIN auth_grant g ON g.id=r.grant_id WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>? AND g.revoked_at IS NULL)',
        [digest, now],
      ),
      auth.s.statement('UPDATE auth_refresh_token SET used_at=? WHERE token_hash=?', now, digest),
    )
  } else throw new Failure(400, 'UNSUPPORTED_GRANT_TYPE')
  const a = await auth.root(rootId),
    expires = Math.min(a.created_at + 90 * DAY, a.activity_at + 30 * DAY)
  ok(
    (JSON.parse(scopes) as string[]).every((x) => JSON.parse(c.scopes).includes(x)),
    400,
    'INVALID_SCOPE',
  )
  writes.push(
    auth.s.guard(
      'EXISTS(SELECT 1 FROM auth_authentication a JOIN auth_user u ON u.id=a.user_id WHERE a.id=? AND ' +
        alive +
        ')',
      [rootId, now, now],
    ),
    auth.s.guard(
      "EXISTS(SELECT 1 FROM auth_client c JOIN auth_application a ON a.id=c.application_id WHERE c.client_id=? AND c.version=? AND c.status='ACTIVE' AND a.status='ACTIVE')",
      [c.client_id, c.version],
    ),
    auth.s.statement(
      'INSERT INTO auth_access_token VALUES (?,?,?)',
      await hash(access),
      grant,
      Math.min(now + 900000, expires),
    ),
    auth.s.statement(
      'INSERT INTO auth_refresh_token VALUES (?,?,?,NULL)',
      await hash(refresh),
      grant,
      expires,
    ),
  )
  try {
    await auth.s.batch(writes, 'INVALID_GRANT')
  } catch (e) {
    if (b.get('grant_type') === 'refresh_token' && e instanceof Failure) {
      await auth.s.run('UPDATE auth_grant SET revoked_at=? WHERE id=?', now, grant)
    }
    throw e
  }
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: Math.floor((Math.min(now + 900000, expires) - now) / 1000),
    scope: (JSON.parse(scopes) as string[]).join(' '),
  }
}

export async function serviceToken(auth: Auth, b: URLSearchParams) {
  ok(
    !auth.request.headers.has('Origin') &&
      [...b.keys()].every((k) => ['grant_type', 'scope'].includes(k)),
    400,
    'INVALID_CLIENT',
  )
  ok(!b.has('scope') || b.get('scope') === 'authorization', 400, 'INVALID_SCOPE')
  await auth.rate('service-ip', auth.request.headers.get('CF-Connecting-IP') ?? 'local', 60)
  const basic = auth.request.headers.get('Authorization') ?? ''
  ok(/^Basic [A-Za-z0-9+/=]{1,500}$/i.test(basic), 401, 'INVALID_CLIENT')
  let decoded: string
  try {
    decoded = atob(basic.slice(6))
  } catch {
    throw new Failure(401, 'INVALID_CLIENT')
  }
  const at = decoded.indexOf(':')
  ok(at > 0, 401, 'INVALID_CLIENT')
  const clientId = decodeURIComponent(decoded.slice(0, at)),
    credential = decodeURIComponent(decoded.slice(at + 1))
  await auth.rate('service-client', clientId, 30)
  const digest = await hash(credential)
  const row = await auth.s.one<{ id: string; credential_id: string }>(
    "SELECT s.id,s.credential_id FROM auth_service s JOIN auth_application a ON a.id=s.application_id WHERE s.client_id=? AND s.secret_hash=? AND s.status='ACTIVE' AND a.status='ACTIVE'",
    clientId,
    digest,
  )
  ok(row, 401, 'INVALID_CLIENT')
  const access = secret(),
    now = Date.now()
  await auth.s.batch([
    auth.s.guard(
      "EXISTS(SELECT 1 FROM auth_service WHERE id=? AND credential_id=? AND status='ACTIVE')",
      [row.id, row.credential_id],
    ),
    auth.s.statement(
      'INSERT INTO auth_service_token VALUES (?,?,?,?)',
      await hash(access),
      row.id,
      row.credential_id,
      now + 300000,
    ),
  ])
  return { access_token: access, token_type: 'Bearer', expires_in: 300, scope: 'authorization' }
}
