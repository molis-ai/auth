import { routes } from './http/router.ts'
import { EphemeralStore } from './infrastructure/ephemeral-store.ts'
import { providers } from './modules/federation/capabilities.ts'
import { Auth } from './modules/identity/service.ts'
import { Failure, requireThat as ok } from './shared/http.ts'
export interface Env {
  ASSETS: Fetcher
  DB: D1Database
  AUTH_ORIGIN: string
  PLATFORM_ADMIN_IDS?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  APPLE_CLIENT_ID?: string
  APPLE_CLIENT_SECRET?: string
  PROVIDER_STATE_KEY?: string
}

const pages = new Set([
  '/',
  '/login',
  '/provider',
  '/provider-mailbox',
  '/register',
  '/forgot-password',
  '/complete',
  '/verify-email',
  '/console',
  '/console/callback',
])

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID()
    const url = new URL(request.url)
    const error = (code: string, status: number) => json({ error: { code }, requestId }, status)
    let response: Response
    const auth = new Auth(env, request, requestId)
    let cors = false
    try {
      const origin = request.headers.get('Origin')
      if (origin && url.pathname !== '/oauth2/callback/apple') {
        cors = origin === env.AUTH_ORIGIN
        if (!cors) {
          const clients = await env.DB.prepare(
            "SELECT c.redirects FROM auth_client c JOIN auth_application a ON a.id=c.application_id WHERE c.status='ACTIVE' AND a.status='ACTIVE' AND c.client_type='WEB'",
          ).all<{ redirects: string }>()
          cors = clients.results.some((c) =>
            (JSON.parse(c.redirects) as string[]).some((r) => new URL(r).origin === origin),
          )
        }
        ok(cors, 403, 'ORIGIN_NOT_ALLOWED')
      }
      if (request.method === 'OPTIONS') {
        ok(origin && cors, 403, 'ORIGIN_NOT_ALLOWED')
        const requested = (request.headers.get('Access-Control-Request-Headers') ?? '')
          .toLowerCase()
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
        ok(
          requested.every((x) =>
            ['authorization', 'content-type', 'x-auth-transaction'].includes(x),
          ) &&
            ['GET', 'POST', 'PUT'].includes(
              request.headers.get('Access-Control-Request-Method') ?? '',
            ),
          403,
          'ORIGIN_NOT_ALLOWED',
        )
        response = new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Methods': 'GET, POST, PUT',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Auth-Transaction',
            'Access-Control-Max-Age': '600',
          },
        })
      } else if (url.pathname === '/api/v1/health' && request.method === 'GET') {
        await env.DB.prepare('SELECT 1 FROM auth_user LIMIT 1').all()
        response = json({
          data: { status: 'UP', runtime: 'cloudflare', migrationComplete: false },
          requestId,
        })
      } else if (url.pathname === '/api/v1/auth/ui-configuration' && request.method === 'GET') {
        const client = await env.DB.prepare(
          "SELECT c.redirects,c.scopes FROM auth_client c JOIN auth_application a ON a.id=c.application_id WHERE c.client_id='molis-auth-console' AND c.client_type='WEB' AND c.status='ACTIVE' AND a.status='ACTIVE'",
        ).first<{ redirects: string; scopes: string }>()
        const configured =
          client &&
          JSON.parse(client.redirects).includes(env.AUTH_ORIGIN + '/console/callback') &&
          ['account', 'profile'].every((x) => JSON.parse(client.scopes).includes(x))
        response = json({
          data: {
            mailboxEnabled: false,
            authOrigin: env.AUTH_ORIGIN,
            providers: providers(env),
            console: {
              enabled: !!configured,
              clientId: configured ? 'molis-auth-console' : null,
              redirectUri: configured ? env.AUTH_ORIGIN + '/console/callback' : null,
            },
          },
          requestId,
        })
      } else if (/^\/(api|oauth2|\.well-known)(\/|$)/.test(url.pathname)) {
        const result = await routes(auth)
        response =
          result instanceof Response
            ? result
            : json(url.pathname === '/oauth2/token' ? result : { data: result, requestId })
      } else if (request.method !== 'GET' && request.method !== 'HEAD') {
        response = error('METHOD_NOT_ALLOWED', 405)
      } else if (pages.has(url.pathname) || url.pathname.startsWith('/auth-ui/')) {
        const target = new URL(request.url)
        target.pathname = pages.has(url.pathname)
          ? '/index.html'
          : url.pathname.slice('/auth-ui'.length)
        target.search = ''
        response = await env.ASSETS.fetch(new Request(target, { method: request.method }))
        response = new Response(response.body, response)
        if (pages.has(url.pathname)) response.headers.set('Cache-Control', 'no-store')
      } else {
        response = error('NOT_FOUND', 404)
      }
    } catch (failure) {
      // No request bodies, credentials or underlying database errors in responses/logs.
      response =
        failure instanceof Failure
          ? error(failure.message, failure.status)
          : error('AUTH_UNAVAILABLE', 503)
    }
    if (response.status < 400)
      for (const value of auth.cookies) response.headers.append('Set-Cookie', value)
    if (cors) {
      response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin')!)
      response.headers.set('Vary', 'Origin')
      if (request.headers.get('Origin') === env.AUTH_ORIGIN)
        response.headers.set('Access-Control-Allow-Credentials', 'true')
    }
    if (response.status === 429) response.headers.set('Retry-After', '60')
    response.headers.set('X-Request-ID', requestId)
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.headers.set('X-Frame-Options', 'DENY')
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    )
    if (env.AUTH_ORIGIN.startsWith('https:'))
      response.headers.set('Strict-Transport-Security', 'max-age=31536000')
    return response
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    const now = Date.now()
    await new EphemeralStore(env.DB).prune(now)
    await env.DB.batch([
      env.DB.prepare(
        'DELETE FROM auth_transaction WHERE token_hash IN (SELECT token_hash FROM auth_transaction WHERE expires_at<=? LIMIT 100)',
      ).bind(now),
      env.DB.prepare(
        'DELETE FROM auth_access_token WHERE token_hash IN (SELECT token_hash FROM auth_access_token WHERE expires_at<=? LIMIT 100)',
      ).bind(now),
      env.DB.prepare(
        'DELETE FROM auth_service_token WHERE token_hash IN (SELECT token_hash FROM auth_service_token WHERE expires_at<=? LIMIT 100)',
      ).bind(now),
      env.DB.prepare(
        'DELETE FROM auth_code WHERE token_hash IN (SELECT token_hash FROM auth_code WHERE expires_at<=? LIMIT 100)',
      ).bind(now),
      env.DB.prepare(
        'DELETE FROM auth_refresh_token WHERE token_hash IN (SELECT token_hash FROM auth_refresh_token WHERE expires_at<=? LIMIT 100)',
      ).bind(now),
    ])
  },
}
