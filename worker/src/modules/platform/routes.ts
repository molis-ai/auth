import { Failure } from '../../shared/http.ts'
import { catalog } from '../authorization/policy.ts'
import type { Auth } from '../identity/service.ts'
import type { Principal } from '../identity/types.ts'
import { Platform } from './service.ts'
export async function platformRoutes(
  a: Auth,
  p: Principal,
  relative: string,
  method: string,
  url: URL,
  b: Record<string, unknown>,
) {
  const platform = new Platform(a, p),
    sub = relative.slice('/platform'.length)
  if (sub === '/me' && method === 'GET') return { userId: p.userId, platformAdministrator: true }
  if (sub === '/permission-catalog' && method === 'GET') return catalog
  if (sub === '/applications' && method === 'GET') return platform.apps(url)
  if (sub === '/applications' && method === 'POST') return platform.application(undefined, b)
  if (sub === '/users' && method === 'GET') return platform.users(url)
  if (sub === '/audit' && method === 'GET') return platform.audit(url)
  if (sub === '/mail' && method === 'GET') return { items: [], nextCursor: null }
  if (sub.startsWith('/mail/') && method === 'POST')
    throw new Failure(409, 'EMAIL_FLOW_UNAVAILABLE')
  const app = sub.match(/^\/applications\/([^/]+)(.*)$/)
  if (app) {
    const [, id, tail] = app
    if (!tail && method === 'GET') return platform.view(await platform.app(id))
    if (!tail && method === 'PUT') return platform.application(id, b)
    if (tail === '/permission-matrix' && method === 'GET') return platform.matrix(id)
    if (tail === '/permission-matrix' && method === 'PUT') return platform.saveMatrix(id, b)
    if (tail === '/clients' && method === 'GET') return platform.clients(url, id)
    if (tail === '/clients' && method === 'POST') return platform.saveClient(id, undefined, b)
    if (tail === '/services' && method === 'GET') return platform.services(url, id)
    if (tail === '/services' && method === 'POST') return platform.service(id, undefined, b)
  }
  const client = sub.match(/^\/clients\/([^/]+)$/)
  if (client && method === 'GET') return platform.client(client[1])
  if (client && method === 'PUT') return platform.saveClient(undefined, client[1], b)
  const user = sub.match(/^\/users\/([^/]+)(\/status)?$/)
  if (user && method === 'GET' && !user[2]) return platform.users(url, user[1])
  if (user && method === 'PUT' && user[2]) return platform.userStatus(user[1], b)
  const service = sub.match(/^\/services\/([^/]+)\/(rotate|disable)$/)
  if (service && method === 'POST')
    return platform.service(undefined, service[1], b, service[2] === 'disable')
  throw new Failure(404, 'NOT_FOUND')
}
