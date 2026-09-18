import test from 'node:test'
import assert from 'node:assert/strict'
import { canResendMail, type MailDelivery } from '../src/mail-policy.ts'
const original: MailDelivery = { id: 'id', recipientEmail: 'test@example.test', templateKey: 'ACCOUNT_REGISTERED', status: 'FAILED', attempts: 5, createdAt: '', lastErrorCode: null, resendOf: null, retryId: null }
test('only failed original non-secret notifications may be manually resent', () => {
  for (const templateKey of ['ACCOUNT_REGISTERED', 'PASSWORD_CHANGED', 'SPACE_INVITED']) assert.equal(canResendMail({ ...original, templateKey }), true)
  for (const templateKey of ['VERIFY_REGISTER', 'VERIFY_PASSWORD_RESET', 'UNKNOWN']) assert.equal(canResendMail({ ...original, templateKey }), false)
  for (const status of ['PENDING', 'SENDING', 'SENT']) assert.equal(canResendMail({ ...original, status }), false)
})
test('retry batches and previously retried originals cannot create an unbounded resend chain', () => {
  assert.equal(canResendMail({ ...original, resendOf: 'original' }), false)
  assert.equal(canResendMail({ ...original, retryId: 'retry' }), false)
})
