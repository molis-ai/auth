import { encodePassword } from '../../security/password-policy.ts'
import {
  derivePassword,
  matchesLegacyPassword,
  normalizePassword,
  PASSWORD_VERSION,
} from '../../security/password.ts'
import {
  cookie,
  cookieHeader,
  email,
  Failure,
  fields,
  hash,
  requireThat as ok,
  rootCookie,
  secret,
  str,
  tokenPattern,
} from '../../shared/http.ts'
import type { Auth } from './service.ts'
import { DAY } from './session-policy.ts'
import type { Context, Transaction } from './types.ts'

export async function begin(auth: Auth, b: Record<string, unknown>) {
  fields(
    b,
    ['clientId', 'redirectUri', 'codeChallenge', 'codeChallengeMethod', 'state', 'scopes'],
    ['forceLogin'],
  )
  await auth.rate('begin-ip', auth.request.headers.get('CF-Connecting-IP') ?? 'local', 60)
  const c = await auth.client(str(b.clientId, 100))
  auth.origin(c)
  const redirect = str(b.redirectUri),
    state = str(b.state, 128),
    pkce = str(b.codeChallenge, 43)
  ok(
    (JSON.parse(c.redirects) as string[]).includes(redirect) &&
      tokenPattern.test(pkce) &&
      b.codeChallengeMethod === 'S256' &&
      /^[A-Za-z0-9_-]{22,128}$/.test(state),
  )
  ok(
    Array.isArray(b.scopes) &&
      b.scopes.length >= 1 &&
      b.scopes.length <= 2 &&
      b.scopes.every((x) => ['account', 'profile'].includes(x) && JSON.parse(c.scopes).includes(x)),
  )
  ok(b.forceLogin === undefined || typeof b.forceLogin === 'boolean')
  const context: Context = {
    id: crypto.randomUUID(),
    clientId: c.client_id,
    clientType: c.client_type,
    redirectUri: redirect,
    challenge: pkce,
    state,
    scopes: b.scopes as string[],
    forceLogin: b.forceLogin === true || c.client_type !== 'WEB',
  }
  const token = secret()
  await auth.s.run(
    'INSERT INTO auth_transaction(token_hash,context,expires_at) VALUES (?,?,?)',
    await hash(token),
    JSON.stringify(context),
    Date.now() + 600000,
  )
  return { transaction: token, loginUrl: auth.env.AUTH_ORIGIN + '/login#transaction=' + token }
}

export async function transaction(auth: Auth) {
  const token = auth.request.headers.get('X-Auth-Transaction') ?? ''
  ok(tokenPattern.test(token), 400, 'INVALID_TRANSACTION')
  const t = await auth.s.one<Transaction>(
    'SELECT * FROM auth_transaction WHERE token_hash=? AND expires_at>?',
    await hash(token),
    Date.now(),
  )
  ok(t, 400, 'INVALID_TRANSACTION')
  const context = JSON.parse(t.context) as Context
  const c = await auth.client(context.clientId)
  auth.origin(c)
  ok(
    JSON.parse(c.redirects).includes(context.redirectUri) &&
      context.scopes.every((x) => JSON.parse(c.scopes).includes(x)),
    400,
    'INVALID_CLIENT',
  )
  return { t, context, token }
}

export async function context(auth: Auth) {
  const { t, context } = await auth.transaction()
  return { context, status: t.status }
}

export async function login(auth: Auth, b: Record<string, unknown>, signup: boolean) {
  fields(b, signup ? ['email', 'password', 'confirmPassword'] : ['email', 'password'])
  if (signup) auth.authOrigin()
  const { t, token } = await auth.transaction()
  ok(t.status === 'READY', 400, 'INVALID_TRANSACTION')
  await auth.rate('login-ip', auth.request.headers.get('CF-Connecting-IP') ?? 'local', 30)
  let address = 'invalid-email'
  try {
    address = email(b.email)
  } catch {
    if (signup) throw new Failure(400, 'INVALID_EMAIL')
  }
  await auth.rate('login-email', address, 10, 300000)
  const raw = str(b.password, 512),
    now = Date.now(),
    root = crypto.randomUUID()
  const writes: D1PreparedStatement[] = [
    auth.s.guard(
      "EXISTS(SELECT 1 FROM auth_transaction WHERE token_hash=? AND status='READY' AND expires_at>?)",
      [t.token_hash, now],
    ),
  ]
  let user: string
  if (signup) {
    ok(raw === str(b.confirmPassword, 512), 400, 'PASSWORD_MISMATCH')
    const encoded = await encodePassword(raw)
    user = crypto.randomUUID()
    const space = crypto.randomUUID()
    writes.push(
      auth.s.statement(
        "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,?,'ACTIVE',?,?)",
        user,
        address.split('@')[0],
        now,
        now,
      ),
      auth.s.statement(
        'INSERT INTO auth_user_email(id,user_id,canonical_email,created_at) VALUES (?,?,?,?)',
        crypto.randomUUID(),
        user,
        address,
        now,
      ),
      auth.s.statement('INSERT INTO auth_local_credential VALUES (?,?,?)', user, encoded, now),
      auth.s.statement(
        "INSERT INTO auth_space(id,name,space_type,status,personal_user_id,created_at,updated_at) VALUES (?,'个人空间','PERSONAL','ACTIVE',?,?,?)",
        space,
        user,
        now,
        now,
      ),
      auth.s.statement("INSERT INTO auth_membership VALUES (?,?,'OWNER',?)", space, user, now),
    )
  } else {
    const candidate = await auth.s.one<{ id: string; password_hash: string; status: string }>(
      'SELECT u.id,u.status,c.password_hash FROM auth_user_email e JOIN auth_user u ON u.id=e.user_id LEFT JOIN auth_local_credential c ON c.user_id=u.id WHERE e.canonical_email=?',
      address,
    )
    // Equal KDF work for nonexistent/external-only accounts, with a non-account synthetic hash.
    const encoded = candidate?.password_hash ?? PASSWORD_VERSION + '00'.repeat(48)
    let matched = false
    if (normalizePassword(raw) === null) {
      await derivePassword('invalid-password-input', new Uint8Array(16))
    } else matched = await matchesLegacyPassword(raw, encoded)
    if (!matched || !candidate || candidate.status !== 'ACTIVE') {
      await auth.s.db.batch([auth.s.audit('account.login', null, auth.requestId, { denied: true })])
      throw new Failure(401, 'INVALID_CREDENTIALS')
    }
    user = candidate.id
    writes.push(
      auth.s.guard(
        "EXISTS(SELECT 1 FROM auth_user u JOIN auth_local_credential c ON c.user_id=u.id WHERE u.id=? AND u.status='ACTIVE' AND c.password_hash=?)",
        [user, encoded],
      ),
    )
  }
  writes.push(
    auth.s.statement(
      'INSERT INTO auth_authentication(id,user_id,created_at,activity_at) VALUES (?,?,?,?)',
      root,
      user,
      now,
      now,
    ),
    auth.s.statement(
      "UPDATE auth_transaction SET status='AUTHENTICATED',authentication_id=? WHERE token_hash=?",
      root,
      t.token_hash,
    ),
    auth.s.audit(signup ? 'account.register' : 'account.login', user, auth.requestId),
  )
  await auth.s.batch(writes, 'INVALID_TRANSACTION')
  return { continueUrl: auth.env.AUTH_ORIGIN + '/complete#transaction=' + token }
}

export async function restore(auth: Auth) {
  auth.authOrigin()
  const { t, context, token } = await auth.transaction()
  ok(context.clientType === 'WEB' && !context.forceLogin, 401, 'FULL_LOGIN_REQUIRED')
  const value = cookie(auth.request, rootCookie(auth.env.AUTH_ORIGIN)) ?? ''
  ok(tokenPattern.test(value), 401, 'LOGIN_REQUIRED')
  const a = await auth.s.one<{ id: string }>(
    'SELECT id FROM auth_authentication WHERE cookie_hash=?',
    await hash(value),
  )
  ok(a, 401, 'LOGIN_REQUIRED')
  await auth.root(a.id)
  const result = await auth.s.run(
    "UPDATE auth_transaction SET status='AUTHENTICATED',authentication_id=? WHERE token_hash=? AND status='READY' AND expires_at>?",
    a.id,
    t.token_hash,
    Date.now(),
  )
  ok(result.meta.changes === 1, 400, 'INVALID_TRANSACTION')
  return { continueUrl: auth.env.AUTH_ORIGIN + '/complete#transaction=' + token }
}

export function completionCookie(auth: Auth, t: Transaction) {
  return (
    (auth.env.AUTH_ORIGIN.startsWith('https:') ? '__Host-' : '') +
    'auth_complete_' +
    t.token_hash.slice(0, 24)
  )
}

export async function confirmation(auth: Auth) {
  auth.authOrigin()
  const { t } = await auth.transaction()
  ok(t.status === 'AUTHENTICATED' && t.authentication_id, 400, 'INVALID_TRANSACTION')
  await auth.rate('confirmation-ip', auth.request.headers.get('CF-Connecting-IP') ?? 'local', 60)
  const a = await auth.root(t.authentication_id),
    proof = secret(),
    browser = secret()
  const result = await auth.s.run(
    "UPDATE auth_transaction SET proof_hash=?,browser_hash=? WHERE token_hash=? AND status='AUTHENTICATED' AND expires_at>?",
    await hash(proof),
    await hash(browser),
    t.token_hash,
    Date.now(),
  )
  ok(result.meta.changes === 1, 400, 'INVALID_TRANSACTION')
  auth.cookies.push(
    cookieHeader(auth.env.AUTH_ORIGIN, auth.completionCookie(t), browser, 600).replace(
      'SameSite=Lax',
      'SameSite=Strict',
    ),
  )
  return {
    confirmation: proof,
    account: {
      userId: a.user_id,
      emails: (
        await auth.s.all<{ canonical_email: string }>(
          'SELECT canonical_email FROM auth_user_email WHERE user_id=?',
          a.user_id,
        )
      ).map((x) => x.canonical_email),
    },
  }
}

export async function complete(auth: Auth, b: Record<string, unknown>, cancel = false) {
  auth.authOrigin()
  fields(b, ['confirmation'], cancel ? [] : ['confirmed'])
  if (!cancel) ok(b.confirmed === true, 400, 'LOGIN_CONFIRMATION_REQUIRED')
  const { t, context } = await auth.transaction(),
    proof = str(b.confirmation, 43),
    browser = cookie(auth.request, auth.completionCookie(t)) ?? ''
  ok(
    t.status === 'AUTHENTICATED' &&
      t.authentication_id &&
      tokenPattern.test(proof) &&
      tokenPattern.test(browser) &&
      (await hash(proof)) === t.proof_hash &&
      (await hash(browser)) === t.browser_hash,
    400,
    'INVALID_TRANSACTION',
  )
  const a = await auth.root(t.authentication_id),
    now = Date.now(),
    code = secret()
  const writes = [
    auth.s.guard(
      "EXISTS(SELECT 1 FROM auth_transaction WHERE token_hash=? AND status='AUTHENTICATED' AND proof_hash=? AND browser_hash=? AND expires_at>?)",
      [t.token_hash, t.proof_hash, t.browser_hash, now],
    ),
    auth.s.guard(
      'EXISTS(SELECT 1 FROM auth_authentication WHERE id=? AND revoked_at IS NULL AND activity_at+2592000000>? AND created_at+7776000000>?)',
      [a.id, now, now],
    ),
    auth.s.statement(
      "UPDATE auth_transaction SET status='CONSUMED',proof_hash=NULL,browser_hash=NULL WHERE token_hash=?",
      t.token_hash,
    ),
  ]
  if (!cancel) {
    writes.push(
      auth.s.statement(
        'INSERT INTO auth_code VALUES (?,?,?,?,?,?,?,NULL)',
        await hash(code),
        context.clientId,
        context.redirectUri,
        context.challenge,
        JSON.stringify(context.scopes),
        a.id,
        now + 60000,
      ),
    )
    if (context.clientType === 'WEB') {
      const restore = secret()
      writes.push(
        auth.s.statement(
          'UPDATE auth_authentication SET cookie_hash=? WHERE id=?',
          await hash(restore),
          a.id,
        ),
      )
      auth.cookies.push(
        cookieHeader(
          auth.env.AUTH_ORIGIN,
          rootCookie(auth.env.AUTH_ORIGIN),
          restore,
          Math.floor((Math.min(a.created_at + 90 * DAY, a.activity_at + 30 * DAY) - now) / 1000),
        ),
      )
    }
  }
  await auth.s.batch(writes, 'INVALID_TRANSACTION')
  auth.cookies.push(cookieHeader(auth.env.AUTH_ORIGIN, auth.completionCookie(t), '', 0))
  return cancel
    ? { cancelled: true }
    : {
        redirectTo:
          context.redirectUri +
          (context.redirectUri.includes('?') ? '&' : '?') +
          'code=' +
          code +
          '&state=' +
          encodeURIComponent(context.state),
      }
}
