import { Store } from '../../infrastructure/database.ts'
import { EphemeralStore } from '../../infrastructure/ephemeral-store.ts'
import { hash, requireThat as ok } from '../../shared/http.ts'
import {
  begin,
  complete,
  completionCookie,
  confirmation,
  context,
  login,
  restore,
  transaction,
} from './login-workflow.ts'
import { logout, me, principal, root } from './session-service.ts'
import { serviceToken, token } from './token-service.ts'

import type { AuthEnv, Client, Principal, Transaction } from './types.ts'
export type { AuthEnv, Principal } from './types.ts'

export class Auth {
  readonly s: Store
  readonly env: AuthEnv
  readonly request: Request
  readonly requestId: string
  readonly cookies: string[] = []
  constructor(env: AuthEnv, request: Request, requestId: string) {
    this.env = env
    this.s = new Store(env.DB)
    this.request = request
    this.requestId = requestId
  }
  async rate(kind: string, subject: string, limit: number, window = 60000) {
    ok(
      await new EphemeralStore(this.env.DB).allow(
        await hash(kind + ':' + subject),
        limit,
        window,
        Date.now(),
      ),
      429,
      'RATE_LIMITED',
    )
  }
  authOrigin() {
    ok(this.request.headers.get('Origin') === this.env.AUTH_ORIGIN, 403, 'AUTH_ORIGIN_REQUIRED')
  }
  async client(id: string): Promise<Client> {
    const c = await this.s.one<Client>(
      'SELECT c.*,a.status app_status FROM auth_client c JOIN auth_application a ON a.id=c.application_id WHERE c.client_id=?',
      id,
    )
    ok(c && c.status === 'ACTIVE' && c.app_status === 'ACTIVE', 400, 'INVALID_CLIENT')
    return c
  }
  origin(c: Client) {
    const origin = this.request.headers.get('Origin')
    ok(
      origin === null ||
        origin === this.env.AUTH_ORIGIN ||
        (c.client_type === 'WEB' &&
          (JSON.parse(c.redirects) as string[]).some((r) => new URL(r).origin === origin)),
      403,
      'ORIGIN_NOT_ALLOWED',
    )
  }
  async begin(b: Record<string, unknown>) {
    return begin(this, b)
  }
  async transaction() {
    return transaction(this)
  }
  async context() {
    return context(this)
  }
  async login(b: Record<string, unknown>, signup: boolean) {
    return login(this, b, signup)
  }
  async root(id: string) {
    return root(this, id)
  }
  async restore() {
    return restore(this)
  }
  completionCookie(t: Transaction) {
    return completionCookie(this, t)
  }
  async confirmation() {
    return confirmation(this)
  }
  async complete(b: Record<string, unknown>, cancel = false) {
    return complete(this, b, cancel)
  }
  async token(b: URLSearchParams) {
    return token(this, b)
  }
  async principal(token?: string): Promise<Principal> {
    return principal(this, token)
  }
  async serviceToken(b: URLSearchParams) {
    return serviceToken(this, b)
  }
  async me(p: Principal) {
    return me(this, p)
  }
  async logout(p: Principal, all: boolean) {
    return logout(this, p, all)
  }
}
