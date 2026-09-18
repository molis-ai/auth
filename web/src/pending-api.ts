import type { AuthClient } from '../../sdk/browser/src/index.ts'
import { spaceApi, listPath, ConsoleError, type Page } from './console-api.ts'
export interface PendingInvitation { id: string; spaceId: string; spaceName: string; invitedEmail: string; inviterName: string; expiresAt: string }
export async function loadPending(client: Pick<AuthClient, 'getAccessToken'>, transport: typeof fetch = fetch) {
  const items = new Map<string, PendingInvitation>(), seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page: Page<PendingInvitation> = await spaceApi(client, listPath('/invitations', cursor), 'GET', undefined, transport)
    for (const item of page.items) items.set(item.id, item)
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) throw new ConsoleError('INVALID_RESPONSE')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return [...items.values()]
}
