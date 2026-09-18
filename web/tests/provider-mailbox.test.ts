import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, readFragment } from '../src/protocol.ts'
import { ProviderMailboxFlow } from '../src/provider-mailbox.ts'
const tx = 'T'.repeat(43), state = 'S'.repeat(43), challenge = 'C'.repeat(43), origin = 'https://auth.example.test'
const ok = (data: unknown) => new Response(JSON.stringify({ data }))
test('verified mailbox conflict enters linking without claiming authentication or retrying the old mailbox proof', async () => {
  let calls = 0
  const flow = new ProviderMailboxFlow(tx, state, origin, (async url => {
    calls++; return String(url).endsWith('/mailbox') ? ok({ challenge }) : ok({ linkRequired: true })
  }) as typeof fetch)
  await flow.request('existing@example.test', 'en'); assert.equal(await flow.complete('en'), undefined)
  assert.equal(flow.terminal, false); await assert.rejects(flow.complete('en')); assert.equal(calls, 2)
})
test('provider reauthentication requires explicit confirmation and never follows a foreign URL', async () => {
  let calls = 0
  const flow = new ProviderMailboxFlow(tx, state, origin, (async (url, init) => {
    calls++; assert.ok(String(url).endsWith('/reauthenticate'))
    assert.deepEqual(JSON.parse(init!.body as string), { continuation: state, provider: 'apple', confirmed: true })
    return ok({ authorizationUrl: 'https://evil.example/authorize' })
  }) as typeof fetch)
  await assert.rejects(flow.reauthenticate('apple')); assert.equal(flow.terminal, true)
  await assert.rejects(flow.reauthenticate('apple')); assert.equal(calls, 1)
})
test('password linking requires explicit submission, keeps passwords out of object state and does not retry uncertainty', async () => {
  let calls = 0
  const password = 'existing-password-secret'
  const flow = new ProviderMailboxFlow(tx, state, origin, (async (url, init) => {
    assert.ok(String(url).endsWith('/link-password'))
    const body = JSON.parse(init!.body as string); assert.deepEqual(Object.keys(body).sort(), ['confirmed', 'continuation', 'password'])
    assert.equal(body.password, password); assert.equal(body.confirmed, true)
    calls++; if (calls === 1) return new Response(JSON.stringify({ error: { code: 'INVALID_CREDENTIALS' } }), { status: 401 })
    throw Error('uncertain')
  }) as typeof fetch)
  await assert.rejects(flow.linkPassword(password)); assert.equal(flow.terminal, false)
  await assert.rejects(flow.linkPassword(password)); assert.equal(flow.terminal, true)
  await assert.rejects(flow.linkPassword(password)); assert.equal(calls, 2)
  assert.ok(!JSON.stringify(flow).includes(password)); assert.ok(!JSON.stringify(flow).includes(tx))
})
test('continuation fragment rejects duplicates, missing secrets and arbitrary identity data', () => {
  assert.deepEqual(readFragment('#transaction=' + tx + '&continuation=' + state, 'provider-mailbox'), { transaction: tx, continuation: state })
  for (const extra of ['', '&continuation=' + state, '&userId=someone']) {
    const fragment = extra === '' ? '#transaction=' + tx : '#transaction=' + tx + '&continuation=' + state + extra
    assert.equal(readFragment(fragment, 'provider-mailbox'), null)
  }
})
test('mailbox continuation carries browser cookies and transaction but never requests a password', async () => {
  const calls: { path: string; body: any }[] = []
  const flow = new ProviderMailboxFlow(tx, state, origin, (async (url, init) => {
    assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('X-Auth-Transaction'), tx)
    const body = JSON.parse(init!.body as string); assert.equal(body.continuation, state); assert.equal(body.password, undefined)
    calls.push({ path: String(url), body })
    return String(url).endsWith('/mailbox') ? ok({ challenge }) : ok({ continueUrl: origin + '/complete#transaction=' + tx })
  }) as typeof fetch)
  await flow.request('person@example.test', 'en'); assert.equal(flow.terminal, false)
  assert.equal(await flow.complete('en'), origin + '/complete#transaction=' + tx)
  assert.equal(calls[1].body.confirmed, true); assert.equal(flow.terminal, true)
  await assert.rejects(flow.complete('en')); assert.equal(calls.length, 2)
})
test('unverified proof permits explicit retry but unknown write outcome cannot be retried', async () => {
  let calls = 0
  const flow = new ProviderMailboxFlow(tx, state, origin, (async url => {
    if (String(url).endsWith('/mailbox')) return ok({ challenge })
    calls++; if (calls === 1) return new Response(JSON.stringify({ error: { code: 'INVALID_PROOF' } }), { status: 400 })
    throw Error('lost response')
  }) as typeof fetch)
  await flow.request('person@example.test', 'en'); await assert.rejects(flow.complete('en'), ApiError)
  assert.equal(flow.terminal, false); await assert.rejects(flow.complete('en'), ApiError)
  assert.equal(flow.terminal, true); await assert.rejects(flow.complete('en'), ApiError); assert.equal(calls, 2)
})
test('cancel is explicit and response cannot redirect to another origin or transaction', async () => {
  const cancel = new ProviderMailboxFlow(tx, state, origin, (async () => ok({ cancelled: true })) as typeof fetch)
  await cancel.cancel(); assert.equal(cancel.terminal, true)
  for (const url of ['https://evil.example/complete', origin + '/complete#transaction=' + state]) {
    const flow = new ProviderMailboxFlow(tx, state, origin, (async path => String(path).endsWith('/mailbox') ? ok({ challenge }) : ok({ continueUrl: url })) as typeof fetch)
    await flow.request('person@example.test', 'en'); await assert.rejects(flow.complete('en'), ApiError); assert.equal(flow.terminal, true)
  }
})
