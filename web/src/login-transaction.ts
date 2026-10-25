import { AuthClient, type AuthOptions } from '../../sdk/browser/src/index.ts'
import { api, ApiError, readFragment, secretPattern, type View } from './protocol.ts'

export interface LoginTransaction { transaction: string; view: View }
type ContextTransport = (path: string, transaction: string) => Promise<View>

/** Call only for a user action. Direct entries get fresh PKCE; application entries keep their binding. */
export async function prepareLoginTransaction(
  directOptions: AuthOptions | undefined,
  current: { transaction: string; view?: View },
  transport: ContextTransport = api,
): Promise<LoginTransaction> {
  if (!directOptions) {
    if (!secretPattern.test(current.transaction) || current.view?.status !== 'READY') throw new ApiError('INVALID_TRANSACTION')
    return { transaction: current.transaction, view: current.view }
  }

  // Each explicit attempt starts now, even after a previous rejected submission.
  const started = await new AuthClient(directOptions).beginLogin({ forceLogin: true })
  const transaction = readFragment(new URL(started.loginUrl).hash, 'login')?.transaction
  if (!transaction) throw new ApiError('INVALID_RESPONSE')
  const view = await transport('/transactions/context', transaction)
  if (view.status !== 'READY' || view.context.clientId !== directOptions.clientId
    || view.context.redirectUri !== directOptions.redirectUri) throw new ApiError('INVALID_TRANSACTION')
  return { transaction, view }
}
