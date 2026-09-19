import { fields } from '../../shared/http.ts'
import type { Auth } from '../identity/service.ts'
import type { Principal } from '../identity/types.ts'
import { AccountService } from './service.ts'
export async function accountRoutes(
  a: Auth,
  p: Principal,
  path: string,
  method: string,
  url: URL,
  b: Record<string, unknown>,
) {
  const service = new AccountService(a, p)
  if (path === '/users/me' && method === 'GET') return a.me(p)
  if (path === '/users/me/profile' && method === 'POST') return service.profile(b)
  if (['/sessions/current/logout', '/sessions/logout-all'].includes(path) && method === 'POST') {
    fields(b, [])
    return a.logout(p, path.endsWith('logout-all'))
  }
  if (path === '/sessions/login-methods' && method === 'GET') return service.loginMethods()
  if (path === '/sessions/authentications' && method === 'GET') return service.authentications(url)
  if (path === '/sessions/security-events' && method === 'GET') return service.securityEvents(url)
  const revoke = path.match(/^\/sessions\/authentications\/([^/]+)\/revoke$/)
  if (revoke && method === 'POST') {
    fields(b, [])
    return service.revoke(revoke[1])
  }
  const unlink = path.match(/^\/sessions\/login-methods\/([^/]+)\/unlink$/)
  if (unlink && method === 'POST') {
    fields(b, [])
    return service.unlink(unlink[1])
  }
  return undefined
}
