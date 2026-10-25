import { copy } from './copy.ts'
import type { ApiError } from './protocol.ts'

type Language = 'zh-CN' | 'en'
const editable = new Set(['INVALID_EMAIL', 'INVALID_PASSWORD', 'PASSWORD_BLOCKED', 'PASSWORD_MISMATCH',
  'INVALID_CREDENTIALS', 'INVALID_REQUEST', 'ALREADY_EXISTS', 'ACCOUNT_NOT_AVAILABLE', 'RATE_LIMITED', 'LOGIN_CONFIRMATION_REQUIRED'])

/** Only curated messages reach the page; unexpected codes and response details are never echoed. */
export function authFeedback(error: Pick<ApiError, 'code' | 'requestId' | 'retryAfter'>, language: Language, mode = '') {
  const t = copy[language]
  const known = Object.hasOwn(t.errors, error.code)
  const code = known ? error.code : 'AUTH_INTERNAL_ERROR'
  let field: 'email' | 'password' | 'confirm-password' | undefined
  if (mode === 'register' || mode === 'login') {
    if (code === 'INVALID_EMAIL' || (mode === 'register' && code === 'ALREADY_EXISTS')) field = 'email'
    if (code === 'INVALID_PASSWORD' || code === 'PASSWORD_BLOCKED') field = 'password'
    if (mode === 'register' && code === 'PASSWORD_MISMATCH') field = 'confirm-password'
  }
  const seconds = Number.isFinite(error.retryAfter) ? Math.min(3600, Math.max(0, Math.ceil(error.retryAfter))) : 0
  return {
    code, message: t.errors[code], field,
    terminal: !known || !editable.has(code),
    goToLogin: mode === 'register' && ['ALREADY_EXISTS', 'ACCOUNT_NOT_AVAILABLE', 'NETWORK_ERROR', 'RESULT_UNKNOWN', 'INVALID_RESPONSE'].includes(code),
    neutral: ['LOGIN_CANCELLED', 'PROVIDER_CANCELLED', 'PROVIDER_DENIED', 'AUTHORIZATION_DENIED'].includes(code),
    requestId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(error.requestId) ? error.requestId : '',
    retryHint: code === 'RATE_LIMITED' && seconds > 0 ? t.retryAfter.replace('{seconds}', String(seconds)) : '',
  }
}
