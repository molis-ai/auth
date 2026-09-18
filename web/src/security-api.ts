import type { AuthClient } from '../../sdk/browser/src/index.ts'
import { spaceApi, ConsoleError } from './console-api.ts'

export interface AuthenticationSession {
  id: string; current: boolean; authenticatedAt: string; lastUserActivityAt: string; expiresAt: string
  revokedAt: string | null; status: 'ACTIVE' | 'EXPIRED' | 'REVOKED'; applicationSessionCount: number
}
export interface SecurityEvent {
  id: string; action: string; outcome: string; occurredAt: string; requestId: string
  applicationId: string | null; authorizationSessionId: string | null; authenticationSessionId: string | null
}
export async function unlinkIdentity(client: Pick<AuthClient, 'getAccessToken' | 'logout'>, id: string, transport: typeof fetch = fetch) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new ConsoleError('INVALID_REQUEST')
  const result = await spaceApi<{ unlinked: boolean; loggedOut: boolean }>(client, '/sessions/login-methods/' + id + '/unlink', 'POST', {}, transport)
  if (result?.unlinked !== true || result.loggedOut !== true) throw new ConsoleError('INVALID_RESPONSE', '', true)
  return client.logout({ localOnly: true })
}
/** Only a validated, committed server result may trigger the "revoked" success state. No write retry. */
export async function revokeAuthentication(client: Pick<AuthClient, 'getAccessToken' | 'logout'>, id: string, transport: typeof fetch = fetch) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new ConsoleError('INVALID_REQUEST')
  const result = await spaceApi<{ revoked: boolean; current: boolean }>(client, '/sessions/authentications/' + id + '/revoke', 'POST', {}, transport)
  if (result?.revoked !== true || typeof result.current !== 'boolean') throw new ConsoleError('INVALID_RESPONSE', '', true)
  // Revocation was already committed; no refresh or second logout request with the now-invalid token.
  const local = result.current ? await client.logout({ localOnly: true }) : null
  return { current: result.current, restorePaused: local?.restorePaused ?? false }
}
