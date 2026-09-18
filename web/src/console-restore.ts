import { api, ApiError, checkedCallback, checkedHandoff, readFragment, type View } from './protocol.ts'
import { CompletionFlow } from './completion.ts'
import type { AuthClient } from '../../sdk/browser/src/index.ts'

type Client = Pick<AuthClient, 'restorePaused' | 'beginLogin' | 'logout'>
type Transport = (path: string, token?: string, body?: unknown) => Promise<any>
/** Auth console only: exchange the existing HttpOnly session without navigating or persisting tokens. */
export async function restoreConsoleSession(client: Client, origin: string, clientId: string, redirectUri: string,
  acceptCallback: (url: string) => Promise<boolean>, transport: Transport = api): Promise<boolean> {
  if (client.restorePaused) return false
  if (new URL(redirectUri).origin !== origin) throw new ApiError('AUTH_ORIGIN_REQUIRED')
  try {
    const started = await client.beginLogin()
    const url = new URL(started.loginUrl)
    if (url.origin !== origin || url.pathname !== '/login' || url.search) throw new ApiError('INVALID_RESPONSE')
    const transaction = readFragment(url.hash, 'login')?.transaction
    if (!transaction) throw new ApiError('INVALID_RESPONSE')
    const view: View = await transport('/transactions/context', transaction)
    if (view.context.clientId !== clientId || view.context.redirectUri !== redirectUri || view.context.forceLogin || view.context.clientType !== 'WEB') throw new ApiError('INVALID_RESPONSE')
    const restored = await transport('/transactions/restore', transaction, {})
    checkedHandoff(restored.continueUrl, transaction, origin)
    const flow = new CompletionFlow(transaction, transport)
    await flow.prepare()
    return await acceptCallback(checkedCallback(await flow.finish(true), view.context))
  } catch (error) {
    await client.logout({ localOnly: true })
    if (error instanceof ApiError && ['LOGIN_REQUIRED', 'FULL_LOGIN_REQUIRED'].includes(error.code)) return false
    throw error
  }
}
