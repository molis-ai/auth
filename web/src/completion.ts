import { api, ApiError, secretPattern } from './protocol.ts'
export interface ConfirmationAccount { userId: string; emails: string[] }
type Transport = (path: string, token: string, body: unknown) => Promise<any>

/** Preparation retains the browser-bound, one-use proof for both explicit and fresh-login completion. */
export class CompletionFlow {
  #proof?: string
  #prepared = false
  readonly #transaction: string
  readonly #transport: Transport
  constructor(transaction: string, transport: Transport = api) { this.#transaction = transaction; this.#transport = transport }
  async prepare(): Promise<ConfirmationAccount> {
    if (this.#prepared) throw new ApiError('INVALID_TRANSACTION')
    this.#prepared = true
    const result = await this.#transport('/transactions/confirmation', this.#transaction, {})
    if (!result || !secretPattern.test(result.confirmation ?? '') || !result.account
      || !/^[0-9a-f-]{36}$/.test(result.account.userId ?? '') || !Array.isArray(result.account.emails)
      || result.account.emails.length > 20 || result.account.emails.some((email: unknown) => typeof email !== 'string' || !email || email.length > 254))
      throw new ApiError('INVALID_RESPONSE')
    this.#proof = result.confirmation
    return { userId: result.account.userId, emails: [...result.account.emails] }
  }
  async finish(confirmed: boolean): Promise<string> {
    if (confirmed !== true) throw new ApiError('LOGIN_CONFIRMATION_REQUIRED')
    const proof = this.consume()
    const result = await this.#transport('/transactions/complete', this.#transaction, { confirmation: proof, confirmed: true })
    if (!result || typeof result.redirectTo !== 'string') throw new ApiError('INVALID_RESPONSE')
    return result.redirectTo
  }
  async cancel(): Promise<void> {
    const proof = this.consume()
    const result = await this.#transport('/transactions/cancel', this.#transaction, { confirmation: proof })
    if (result?.cancelled !== true) throw new ApiError('INVALID_RESPONSE')
  }
  private consume(): string {
    if (!this.#proof) throw new ApiError('INVALID_TRANSACTION')
    const proof = this.#proof; this.#proof = undefined; return proof
  }
}

const CONTINUE_KEY = 'molis.auth.completion-intent.v1'
type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type IntentContext = { id: string; clientId: string; redirectUri: string }
/** UI intent only, never authentication proof. No tokens or passwords are persisted. */
export function rememberCompletion(storage: IntentStorage, context: IntentContext, now = Date.now()): void {
  try { storage.setItem(CONTINUE_KEY, JSON.stringify({ ...context, createdAt: now })) } catch { /* Fall back to explicit confirmation. */ }
}
export function takeCompletion(storage: IntentStorage, context: IntentContext, now = Date.now()): boolean {
  try {
    const raw = storage.getItem(CONTINUE_KEY); storage.removeItem(CONTINUE_KEY)
    if (!raw || raw.length > 4096) return false
    const value = JSON.parse(raw)
    return value.id === context.id && value.clientId === context.clientId && value.redirectUri === context.redirectUri
      && Number.isFinite(value.createdAt) && Number.isFinite(now) && now >= value.createdAt && now - value.createdAt < 600000
  } catch { return false }
}
