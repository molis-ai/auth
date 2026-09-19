import { createRemoteJWKSet, jwtVerify } from 'jose'
import { EphemeralStore } from '../../infrastructure/ephemeral-store.ts'
import {
  b64,
  boundedText,
  challenge,
  cookie,
  email,
  Failure,
  hash,
  requireThat as ok,
  secret,
  tokenPattern,
} from '../../shared/http.ts'
import { Auth } from '../identity/service.ts'
import { providers } from './capabilities.ts'
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'))
function settings(a: Auth, provider: string) {
  ok(providers(a.env).includes(provider), 409, 'PROVIDER_NOT_ENABLED')
  const google = provider === 'google'
  return {
    google,
    client: google ? a.env.GOOGLE_CLIENT_ID! : a.env.APPLE_CLIENT_ID!,
    secret: google ? a.env.GOOGLE_CLIENT_SECRET! : a.env.APPLE_CLIENT_SECRET!,
    authorization: google
      ? 'https://accounts.google.com/o/oauth2/v2/auth'
      : 'https://appleid.apple.com/auth/authorize',
    token: google ? 'https://oauth2.googleapis.com/token' : 'https://appleid.apple.com/auth/token',
    callback: a.env.AUTH_ORIGIN + '/oauth2/callback/' + provider,
  }
}
function bytes(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}
async function key(a: Auth) {
  const raw = bytes(a.env.PROVIDER_STATE_KEY!)
  ok(raw.length === 32, 503, 'PROVIDER_UNAVAILABLE')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function encrypt(a: Auth, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  return (
    b64(iv) +
    '.' +
    b64(
      new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          await key(a),
          new TextEncoder().encode(JSON.stringify(value)),
        ),
      ),
    )
  )
}
async function decrypt(a: Auth, value: string) {
  const [iv, data] = value.split('.')
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv) }, await key(a), bytes(data)),
    ),
  )
}
function bindingCookie(state: string, value: string, ttl: number) {
  return `__Host-auth_provider_${state}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${ttl}`
}
export async function startProvider(a: Auth, provider: string, bind: boolean) {
  a.authOrigin()
  const cfg = settings(a, provider),
    { t, token, context } = await a.transaction()
  ok(t.status === 'READY', 400, 'INVALID_TRANSACTION')
  await a.rate('provider-start', a.request.headers.get('CF-Connecting-IP') ?? 'local', 20)
  let target: null | { user: string; grant: string; root: string } = null
  if (bind) {
    const p = await a.principal(),
      root = await a.root(p.authenticationId)
    ok(
      Date.now() - root.created_at < 900000 && p.clientId === context.clientId,
      401,
      'FULL_LOGIN_REQUIRED',
    )
    target = { user: p.userId, grant: p.sessionId, root: p.authenticationId }
  }
  const state = secret(),
    nonce = secret(),
    browser = secret(),
    verifier = secret()
  const data = await encrypt(a, { transaction: token, nonce, verifier, target })
  await new EphemeralStore(a.env.DB).issue(
    await hash(state),
    'PROVIDER',
    await hash(provider + ':' + browser),
    data,
    Date.now() + 300000,
  )
  const url = new URL(cfg.authorization)
  const params: Record<string, string> = {
    client_id: cfg.client,
    response_type: 'code',
    redirect_uri: cfg.callback,
    scope: cfg.google ? 'openid email profile' : 'openid email',
    response_mode: cfg.google ? 'query' : 'form_post',
    state,
    nonce,
  }
  if (cfg.google)
    Object.assign(params, {
      access_type: 'online',
      code_challenge: await challenge(verifier),
      code_challenge_method: 'S256',
    })
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  a.cookies.push(bindingCookie(state, browser, 300))
  return { authorizationUrl: url.href }
}
export async function providerCallback(a: Auth, provider: string): Promise<Response> {
  const cfg = settings(a, provider)
  ok(a.request.method === (cfg.google ? 'GET' : 'POST'), 405)
  if (!cfg.google)
    ok(
      a.request.headers.get('Content-Type')?.split(';')[0] === 'application/x-www-form-urlencoded',
      415,
    )
  const params = cfg.google
    ? new URL(a.request.url).searchParams
    : new URLSearchParams(await boundedText(a.request, 16384))
  ok(
    [...params.keys()].every((k) => params.getAll(k).length === 1),
    400,
    'INVALID_REQUEST',
  )
  const state = params.get('state') ?? '',
    browser = cookie(a.request, '__Host-auth_provider_' + state) ?? ''
  ok(tokenPattern.test(state) && tokenPattern.test(browser), 400, 'INVALID_TRANSACTION')
  const sealed = await new EphemeralStore(a.env.DB).consume(
    await hash(state),
    'PROVIDER',
    await hash(provider + ':' + browser),
    Date.now(),
  )
  ok(typeof sealed === 'string', 400, 'INVALID_TRANSACTION')
  a.cookies.push(bindingCookie(state, '', 0))
  try {
    ok(!params.has('error'), 400, 'PROVIDER_DENIED')
    const data = (await decrypt(a, sealed)) as {
      transaction: string
      nonce: string
      verifier: string
      target: null | { user: string; grant: string; root: string }
    }
    const tokenHash = await hash(data.transaction),
      now = Date.now()
    const transaction = await a.s.one<{ status: string; expires_at: number }>(
      'SELECT status,expires_at FROM auth_transaction WHERE token_hash=?',
      tokenHash,
    )
    ok(transaction?.status === 'READY' && transaction.expires_at > now, 400, 'INVALID_TRANSACTION')
    const code = params.get('code')
    ok(code && code.length <= 4096, 400, 'INVALID_REQUEST')
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: cfg.client,
      client_secret: cfg.secret,
      redirect_uri: cfg.callback,
    })
    if (cfg.google) form.set('code_verifier', data.verifier)
    const response = await fetch(cfg.token, {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    ok(response.ok, 400, 'PROVIDER_REJECTED')
    const tokens = (await response.json()) as { id_token?: string }
    ok(
      typeof tokens.id_token === 'string' && tokens.id_token.length <= 20000,
      400,
      'PROVIDER_REJECTED',
    )
    const { payload } = await jwtVerify(tokens.id_token, cfg.google ? googleKeys : appleKeys, {
      issuer: cfg.google
        ? ['https://accounts.google.com', 'accounts.google.com']
        : 'https://appleid.apple.com',
      audience: cfg.client,
      algorithms: ['RS256'],
      maxTokenAge: '10m',
    })
    ok(
      payload.nonce === data.nonce &&
        typeof payload.sub === 'string' &&
        payload.sub.length > 0 &&
        payload.sub.length <= 255 &&
        typeof payload.exp === 'number',
      400,
      'PROVIDER_REJECTED',
    )
    if (payload.azp !== undefined) ok(payload.azp === cfg.client, 400, 'PROVIDER_REJECTED')
    const issuer = cfg.google ? 'https://accounts.google.com' : 'https://appleid.apple.com'
    const identity = await a.s.one<{ user_id: string }>(
      'SELECT user_id FROM auth_external_identity WHERE issuer=? AND subject=?',
      issuer,
      payload.sub,
    )
    let user = identity?.user_id
    const writes = [
      a.s.guard(
        "EXISTS(SELECT 1 FROM auth_transaction WHERE token_hash=? AND status='READY' AND expires_at>?)",
        [tokenHash, now],
      ),
    ]
    if (data.target) {
      ok(!user || user === data.target.user, 409, 'IDENTITY_ALREADY_LINKED')
      user = data.target.user
      writes.push(
        a.s.guard(
          "EXISTS(SELECT 1 FROM auth_grant g JOIN auth_authentication a ON a.id=g.authentication_id JOIN auth_user u ON u.id=a.user_id WHERE g.id=? AND g.revoked_at IS NULL AND a.id=? AND a.user_id=? AND a.revoked_at IS NULL AND a.created_at>? AND u.status='ACTIVE')",
          [data.target.grant, data.target.root, user, now - 900000],
        ),
      )
    } else if (!user) {
      ok(
        payload.email_verified === true || payload.email_verified === 'true',
        409,
        'PROVIDER_EMAIL_REQUIRED',
      )
      const address = email(payload.email)
      // Never auto-link by email. A pre-existing account must authenticate and explicitly bind.
      ok(
        !(await a.s.one('SELECT id FROM auth_user_email WHERE canonical_email=?', address)),
        409,
        'ACCOUNT_LINK_REQUIRED',
      )
      user = crypto.randomUUID()
      const space = crypto.randomUUID()
      writes.push(
        a.s.statement(
          "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,?,'ACTIVE',?,?)",
          user,
          address.split('@')[0],
          now,
          now,
        ),
        a.s.statement(
          'INSERT INTO auth_user_email VALUES (?,?,?,?,?)',
          crypto.randomUUID(),
          user,
          address,
          now,
          now,
        ),
        a.s.statement(
          "INSERT INTO auth_space(id,name,space_type,status,personal_user_id,created_at,updated_at) VALUES (?,'个人空间','PERSONAL','ACTIVE',?,?,?)",
          space,
          user,
          now,
          now,
        ),
        a.s.statement("INSERT INTO auth_membership VALUES (?,?,'OWNER',?)", space, user, now),
      )
    }
    ok(user, 400, 'PROVIDER_REJECTED')
    if (!identity)
      writes.push(
        a.s.statement(
          'INSERT INTO auth_external_identity VALUES (?,?,?,?,?,?)',
          crypto.randomUUID(),
          user,
          provider.toUpperCase(),
          issuer,
          payload.sub,
          now,
        ),
      )
    writes.push(a.s.guard("EXISTS(SELECT 1 FROM auth_user WHERE id=? AND status='ACTIVE')", [user]))
    const root = crypto.randomUUID()
    writes.push(
      a.s.statement(
        'INSERT INTO auth_authentication(id,user_id,created_at,activity_at) VALUES (?,?,?,?)',
        root,
        user,
        now,
        now,
      ),
      a.s.statement(
        "UPDATE auth_transaction SET status='AUTHENTICATED',authentication_id=? WHERE token_hash=?",
        root,
        tokenHash,
      ),
      a.s.audit(
        data.target ? 'account.external.bind' : 'account.external.login',
        user,
        a.requestId,
      ),
    )
    await a.s.batch(writes, 'INVALID_TRANSACTION')
    return new Response(null, {
      status: 303,
      headers: { Location: a.env.AUTH_ORIGIN + '/complete#transaction=' + data.transaction },
    })
  } catch (e) {
    const code = e instanceof Failure ? e.message : 'PROVIDER_UNAVAILABLE'
    return new Response(null, {
      status: 303,
      headers: { Location: a.env.AUTH_ORIGIN + '/login#provider-error=' + code },
    })
  }
}
