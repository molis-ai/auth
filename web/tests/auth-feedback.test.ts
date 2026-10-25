import test from 'node:test'
import assert from 'node:assert/strict'
import { authFeedback } from '../src/auth-feedback.ts'
import { ApiError, api } from '../src/protocol.ts'
import { copy } from '../src/copy.ts'

const requestId = '0aabdaa3-6cca-4b36-9550-acbc6199276f'
test('current registration, session and provider error contracts have messages in both languages', () => {
  const codes = ['INVALID_EMAIL', 'PASSWORD_MISMATCH', 'INVALID_PASSWORD', 'PASSWORD_BLOCKED', 'ALREADY_EXISTS',
    'INVALID_CREDENTIALS', 'INVALID_TRANSACTION', 'INVALID_CLIENT', 'INVALID_SCOPE', 'INVALID_CONFIGURATION',
    'RATE_LIMITED', 'AUTH_UNAVAILABLE', 'RESULT_UNKNOWN', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'STORAGE_UNAVAILABLE',
    'LOGIN_REQUIRED', 'FULL_LOGIN_REQUIRED', 'INVALID_TOKEN', 'INVALID_CALLBACK', 'TOKEN_REJECTED', 'FLOW_SUPERSEDED',
    'ACCOUNT_CHANGED', 'LOGOUT_IN_PROGRESS', 'BROWSER_REQUIRED', 'AUTHORIZATION_DENIED', 'INVALID_PROVIDER',
    'PROVIDER_DENIED', 'PROVIDER_REJECTED', 'PROVIDER_EMAIL_REQUIRED', 'IDENTITY_ALREADY_LINKED', 'EMAIL_FLOW_UNAVAILABLE',
    'NOT_FOUND', 'METHOD_NOT_ALLOWED']
  for (const language of ['zh-CN', 'en'] as const) {
    for (const code of codes) {
      const feedback = authFeedback(new ApiError(code), language)
      assert.equal(feedback.code, code, `${language}: ${code} must not become a generic error`)
      assert.ok(feedback.message.length > 0)
    }
  }
  assert.deepEqual(Object.keys(copy['zh-CN'].errors).sort(), Object.keys(copy.en.errors).sort())
})

test('input errors point to the right field and registration conflicts allow sign-in without restarting', () => {
  for (const [code, field] of [['INVALID_EMAIL', 'email'], ['INVALID_PASSWORD', 'password'],
    ['PASSWORD_BLOCKED', 'password'], ['PASSWORD_MISMATCH', 'confirm-password'], ['ALREADY_EXISTS', 'email']]) {
    const feedback = authFeedback(new ApiError(code, requestId), 'zh-CN', 'register')
    assert.equal(feedback.field, field)
    assert.equal(feedback.terminal, false)
  }
  assert.equal(authFeedback(new ApiError('ALREADY_EXISTS'), 'en', 'register').goToLogin, true)
  assert.equal(authFeedback(new ApiError('ALREADY_EXISTS'), 'en', 'login').goToLogin, false)
  assert.equal(authFeedback(new ApiError('INVALID_CREDENTIALS'), 'en', 'login').field, undefined)
})

test('uncertain results and expired transactions stop submission; cancellation is neutral', () => {
  for (const code of ['NETWORK_ERROR', 'RESULT_UNKNOWN', 'INVALID_RESPONSE', 'INVALID_TRANSACTION', 'INVALID_CLIENT']) {
    assert.equal(authFeedback(new ApiError(code), 'zh-CN', 'register').terminal, true)
  }
  assert.equal(authFeedback(new ApiError('LOGIN_CANCELLED'), 'zh-CN', 'complete').neutral, true)
  assert.equal(authFeedback(new ApiError('PROVIDER_DENIED'), 'en').neutral, true)
})

test('unknown or prototype-key codes and untrusted request IDs are not displayed', () => {
  for (const code of ['constructor', 'toString', '__proto__', 'SYNTHETIC_PRIVATE_DETAIL', '<script>private</script>']) {
    const feedback = authFeedback(new ApiError(code, 'private-request-detail'), 'zh-CN')
    assert.equal(feedback.code, 'AUTH_INTERNAL_ERROR')
    assert.equal(typeof feedback.message, 'string')
    assert.equal(feedback.terminal, true)
    assert.equal(feedback.requestId, '')
    assert.ok(!JSON.stringify(feedback).includes(code))
  }
  assert.equal(authFeedback(new ApiError('ALREADY_EXISTS', requestId), 'en').requestId, requestId)
})

test('wait guidance uses a bounded server hint only for rate limits', () => {
  assert.match(authFeedback(new ApiError('RATE_LIMITED', '', 60), 'zh-CN').retryHint, /60 秒/)
  assert.match(authFeedback(new ApiError('RATE_LIMITED', '', 99999), 'en').retryHint, /3600 seconds/)
  for (const seconds of [NaN, Infinity, -5, 0]) assert.equal(authFeedback(new ApiError('RATE_LIMITED', '', seconds), 'en').retryHint, '')
  assert.equal(authFeedback(new ApiError('INVALID_EMAIL', '', 60), 'en').retryHint, '')
})

test('non-JSON service failures retain a safe request ID instead of becoming a network error', async () => {
  await assert.rejects(api('/transactions/signup', 't'.repeat(43), {}, async () => new Response('private upstream detail', {
    status: 503, headers: { 'X-Request-ID': requestId },
  })), (e: ApiError) => e.code === 'AUTH_UNAVAILABLE' && e.requestId === requestId && !e.message.includes('private'))
  await assert.rejects(api('/transactions/context', 't'.repeat(43), undefined, async () => new Response('not json', {
    status: 200, headers: { 'X-Request-ID': requestId },
  })), (e: ApiError) => e.code === 'INVALID_RESPONSE' && e.requestId === requestId)
  await assert.rejects(api('/transactions/signup', 't'.repeat(43), {}, async () => Response.json({ error: { code: 'private error text' } }, {
    status: 400, headers: { 'X-Request-ID': requestId },
  })), (e: ApiError) => e.code === 'AUTH_UNAVAILABLE' && e.requestId === requestId)
})
