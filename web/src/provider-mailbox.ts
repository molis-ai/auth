import { api, ApiError, checkedHandoff, secretPattern, type Context } from './protocol.ts'
import { checkedProviderUrl } from './provider.ts'
import type { AuthProvider } from './protocol.ts'

export class ProviderMailboxFlow {
  terminal = false
  #challenge?: string
  #transaction: string
  #continuation: string
  #origin: string
  #transport: typeof fetch
  constructor(transaction: string, continuation: string, origin: string, transport: typeof fetch = fetch) {
    if (!secretPattern.test(transaction) || !secretPattern.test(continuation)) throw new ApiError('INVALID_TRANSACTION')
    this.#transaction = transaction; this.#continuation = continuation; this.#origin = origin; this.#transport = transport
  }
  private call<T>(action: string, fields: Record<string, unknown> = {}) {
    return api<T>('/providers/continuation/' + action, this.#transaction, { continuation: this.#continuation, ...fields }, this.#transport)
  }
  async context() {
    const result = await this.call<{ context: Context; provider: string; expiresAt: string; mode: 'MAILBOX' | 'LINK_PASSWORD'; email: string }>('context')
    if (!result?.context || !['google', 'apple'].includes(result.provider) || !Number.isFinite(Date.parse(result.expiresAt))
      || !['MAILBOX', 'LINK_PASSWORD'].includes(result.mode) || typeof result.email !== 'string' || result.email.length > 254) throw new ApiError('INVALID_RESPONSE')
    return result
  }
  async request(email: string, locale: string) {
    if (this.terminal || this.#challenge) throw new ApiError('INVALID_TRANSACTION')
    this.terminal = true
    const result = await this.call<{ challenge: string }>('mailbox', { email, locale })
    if (!secretPattern.test(result?.challenge ?? '')) throw new ApiError('INVALID_RESPONSE')
    this.#challenge = result.challenge; this.terminal = false
  }
  async complete(locale: string) {
    if (this.terminal || !this.#challenge) throw new ApiError('INVALID_TRANSACTION')
    this.terminal = true
    try {
      const result = await this.call<{ continueUrl?: string; linkRequired?: boolean }>('complete', { challenge: this.#challenge, locale, confirmed: true })
      if(result.linkRequired === true && result.continueUrl === undefined) { this.#challenge = undefined; this.terminal = false; return undefined }
      if(typeof result.continueUrl !== 'string') throw new ApiError('INVALID_RESPONSE')
      return checkedHandoff(result.continueUrl, this.#transaction, this.#origin)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_PROOF') this.terminal = false
      throw error
    }
  }
  async cancel() {
    if (this.terminal) throw new ApiError('INVALID_TRANSACTION')
    this.terminal = true
    const result = await this.call<{ cancelled: boolean }>('cancel')
    if (result?.cancelled !== true) throw new ApiError('INVALID_RESPONSE')
  }
  async linkPassword(password: string) {
    if (this.terminal) throw new ApiError('INVALID_TRANSACTION')
    this.terminal = true
    try {
      const result = await this.call<{ continueUrl: string }>('link-password', { password, confirmed: true })
      return checkedHandoff(result.continueUrl, this.#transaction, this.#origin)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_CREDENTIALS') this.terminal = false
      throw error
    }
  }
  async reauthenticate(provider: AuthProvider) {
    if(this.terminal || !['google', 'apple'].includes(provider)) throw new ApiError('INVALID_TRANSACTION')
    this.terminal = true
    const result = await this.call<{ authorizationUrl: string }>('reauthenticate', { provider, confirmed: true })
    return checkedProviderUrl(result.authorizationUrl, provider, this.#origin)
  }
}
