import { accountRoutes } from '../modules/account/routes.ts'
import { authorize } from '../modules/authorization/service.ts'
import { providerCallback, startProvider } from '../modules/federation/service.ts'
import { identityRoutes } from '../modules/identity/routes.ts'
import type { Auth } from '../modules/identity/service.ts'
import { platformRoutes } from '../modules/platform/routes.ts'
import { teamRoutes } from '../modules/teams/routes.ts'
import { body, boundedText, Failure, fields, requireThat as ok } from '../shared/http.ts'

// Public login, server-to-server authorization, and user APIs have distinct guards.
// Never move principal() above public OAuth handling or bypass it for user modules.
export async function routes(a: Auth): Promise<unknown> {
  const req = a.request,
    url = new URL(req.url),
    path = url.pathname,
    method = req.method
  const callback = path.match(/^\/oauth2\/callback\/(google|apple)$/)
  if (callback) return providerCallback(a, callback[1])
  if (path === '/oauth2/token' && method === 'POST') {
    ok(req.headers.get('Content-Type')?.split(';')[0] === 'application/x-www-form-urlencoded', 415)
    const form = new URLSearchParams(await boundedText(req, 4096))
    ok([...form.keys()].every((k) => form.getAll(k).length === 1))
    return a.token(form)
  }
  const b = ['POST', 'PUT'].includes(method) ? await body(req) : {}
  const authorization = path.match(
    /^\/api\/v1\/authorization\/(check|activity|allowed-actions|spaces)$/,
  )
  if (authorization && method === 'POST') return authorize(a, authorization[1], b)
  if (path === '/api/v1/auth/transactions' || path.startsWith('/api/v1/auth/transactions/'))
    return identityRoutes(a, path, method, b)
  const provider = path.match(/^\/api\/v1\/auth\/providers\/(google|apple)\/(start|bind)$/)
  if (provider && method === 'POST') {
    fields(b, [])
    return startProvider(a, provider[1], provider[2] === 'bind')
  }
  if (path.startsWith('/api/v1/auth/providers/')) throw new Failure(409, 'PROVIDER_UNAVAILABLE')
  if (path.startsWith('/api/v1/auth/')) throw new Failure(409, 'EMAIL_FLOW_UNAVAILABLE')
  const p = await a.principal()
  ok(p.scopes.includes('account'), 403, 'INVALID_SCOPE')
  const relative = path.slice('/api/v1'.length)
  if (relative.startsWith('/platform/')) return platformRoutes(a, p, relative, method, url, b)
  if (
    relative === '/spaces' ||
    relative.startsWith('/spaces/') ||
    relative === '/invitations' ||
    relative.startsWith('/invitations/')
  )
    return teamRoutes(a, p, relative, method, url, b)
  const self = await accountRoutes(a, p, relative, method, url, b)
  if (self !== undefined) return self
  throw new Failure(404, 'NOT_FOUND')
}
