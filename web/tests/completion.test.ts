import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CompletionFlow, rememberCompletion, takeCompletion } from '../src/completion.ts'
import { ApiError } from '../src/protocol.ts'
import { copy } from '../src/copy.ts'
const proof = 'p'.repeat(43), tx = 't'.repeat(43)
const account = { userId: '291e4f05-6205-41bb-8583-3d0ba416c5f9', emails: ['verified@example.test'] }
test('loading only prepares identity confirmation and cannot automatically complete login', async () => {
  const calls: unknown[] = []
  const flow = new CompletionFlow(tx, async (...args) => { calls.push(args); return { confirmation: proof, account } })
  assert.deepEqual(await flow.prepare(), account)
  assert.deepEqual(calls, [['/transactions/confirmation', tx, {}]])
  assert.equal(JSON.stringify(flow), '{}')
  await assert.rejects(flow.finish(false), (e: ApiError) => e.code === 'LOGIN_CONFIRMATION_REQUIRED')
  assert.equal(calls.length, 1)
})
test('explicit confirmation submits the response proof once and only then returns the callback', async () => {
  const calls: unknown[] = []
  const flow = new CompletionFlow(tx, async (...args) => { calls.push(args); return args[0].endsWith('/confirmation') ? { confirmation: proof, account } : { redirectTo: 'https://product.example.test/callback' } })
  await flow.prepare(); assert.equal(await flow.finish(true), 'https://product.example.test/callback')
  assert.deepEqual(calls[1], ['/transactions/complete', tx, { confirmation: proof, confirmed: true }])
  await assert.rejects(flow.finish(true)); await assert.rejects(flow.cancel()); assert.equal(calls.length, 2)
})
test('cancel uses only the bound cancellation endpoint and cannot subsequently complete', async () => {
  const calls: string[] = []
  const flow = new CompletionFlow(tx, async (path) => { calls.push(path); return path.endsWith('/confirmation') ? { confirmation: proof, account } : { cancelled: true } })
  await flow.prepare(); await flow.cancel(); await assert.rejects(flow.finish(true))
  assert.deepEqual(calls, ['/transactions/confirmation', '/transactions/cancel'])
})
test('lost completion responses and simultaneous actions never retry a consumed proof', async () => {
  let calls = 0, resolve!: (value: unknown) => void
  const pending = new Promise(done => { resolve = done })
  const flow = new CompletionFlow(tx, async path => { calls++; if (path.endsWith('/confirmation')) return { confirmation: proof, account }; return pending })
  await flow.prepare(); const first = flow.finish(true)
  await assert.rejects(flow.cancel()); await assert.rejects(flow.finish(true))
  resolve(null); await assert.rejects(first); assert.equal(calls, 2)
})
test('invalid identity or proof never enables confirmation, and failed previews do not retry', async () => {
  for (const result of [null, { confirmation: 'short', account }, { confirmation: proof, account: { ...account, userId: 'untrusted' } }, { confirmation: proof, account: { ...account, emails: [42] } }]) {
    let calls = 0
    const flow = new CompletionFlow(tx, async () => { calls++; return result })
    await assert.rejects(flow.prepare()); await assert.rejects(flow.finish(true)); await assert.rejects(flow.prepare()); assert.equal(calls, 1)
  }
})
test('both locales explain the account, destination, cancellation and original-session preservation', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    for (const key of ['confirmAccountNotice', 'confirmAccount', 'cancelAccount', 'accountId'] as const) assert.ok(copy[locale][key])
    for (const key of ['LOGIN_CANCELLED', 'LOGIN_CONFIRMATION_REQUIRED', 'CONFIRMATION_TOO_MANY_PENDING']) assert.ok(copy[locale].errors[key])
  }
})

test('fresh login intent is tab-local, bound to the exact request and consumed once', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const context = { id: 'request-one', clientId: 'console', redirectUri: 'https://auth.test/callback' }
  assert.equal(takeCompletion(storage, context, 100), false)
  rememberCompletion(storage, context, 100)
  assert.equal(takeCompletion(storage, context, 101), true)
  assert.equal(takeCompletion(storage, context, 102), false)
  for (const different of [{ ...context, id: 'other' }, { ...context, clientId: 'other' }, { ...context, redirectUri: 'https://evil.test' }]) {
    rememberCompletion(storage, context, 100)
    assert.equal(takeCompletion(storage, different, 101), false)
  }
  rememberCompletion(storage, context, 100)
  assert.equal(takeCompletion(storage, context, 600100), false)
  rememberCompletion(storage, context, 100)
  assert.equal(takeCompletion(storage, context, 99), false)
})
test('unavailable storage falls back to explicit confirmation', () => {
  const storage = { getItem: () => { throw Error() }, setItem: () => { throw Error() }, removeItem: () => { throw Error() } }
  const context = { id: 'request', clientId: 'console', redirectUri: 'https://auth.test/callback' }
  assert.doesNotThrow(() => rememberCompletion(storage, context))
  assert.equal(takeCompletion(storage, context), false)
})
