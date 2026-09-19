import { Failure, fields } from '../../shared/http.ts'
import { Auth } from './service.ts'
export async function identityRoutes(
  a: Auth,
  path: string,
  method: string,
  b: Record<string, unknown>,
) {
  if (path === '/api/v1/auth/transactions' && method === 'POST') return a.begin(b)
  if (path === '/api/v1/auth/transactions/context' && method === 'GET') return a.context()
  if (path === '/api/v1/auth/transactions/password' && method === 'POST') return a.login(b, false)
  if (path === '/api/v1/auth/transactions/signup' && method === 'POST') return a.login(b, true)
  if (path === '/api/v1/auth/transactions/restore' && method === 'POST') {
    fields(b, [])
    return a.restore()
  }
  if (path === '/api/v1/auth/transactions/confirmation' && method === 'POST') {
    fields(b, [])
    return a.confirmation()
  }
  if (path === '/api/v1/auth/transactions/complete' && method === 'POST') return a.complete(b)
  if (path === '/api/v1/auth/transactions/cancel' && method === 'POST') return a.complete(b, true)
  // Keep the existing disabled-mail-flow response contract after route extraction.
  throw new Failure(409, 'EMAIL_FLOW_UNAVAILABLE')
}
