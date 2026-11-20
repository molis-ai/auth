import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { aliyunRpc } from '../rust/src/runtime/aliyun.js'

const mail = 'SingleSendMail'
const send = 'SendSmsVerifyCode'
const check = 'CheckSmsVerifyCode'
const input = JSON.stringify({
  PhoneNumber: '13800000000',
  ToAddress: 'private@example.test',
  VerifyCode: '123456',
})

test('Aliyun logs one sanitized event per request and reports the provider result', async (t) => {
  const cases = [
    {
      action: mail,
      body: { RequestId: 'private-id', EnvId: 'private-env' },
      reply: 'accepted',
      outcome: 'success',
    },
    { action: send, body: { Code: 'OK', Success: true }, reply: 'accepted', outcome: 'success' },
    {
      action: check,
      body: { Code: 'OK', Success: true, Model: { VerifyResult: 'PASS' } },
      reply: 'match',
      outcome: 'success',
      verification: 'match',
    },
    {
      action: check,
      body: { Code: 'OK', Success: true, Model: { VerifyResult: 'UNKNOWN' } },
      reply: 'mismatch',
      outcome: 'success',
      verification: 'mismatch',
    },
    {
      action: check,
      body: { Code: 'OK', Success: true },
      reply: 'mismatch',
      outcome: 'invalid_response',
    },
    {
      action: check,
      body: { Code: 'isv.ValidateFail' },
      status: 400,
      reply: 'invalid_credentials',
      outcome: 'success',
      verification: 'mismatch',
    },
    {
      action: send,
      body: { Code: 'FREQUENCY_FAIL' },
      status: 400,
      reply: 'rate_limited',
      outcome: 'rate_limited',
    },
    {
      action: mail,
      body: { Code: 'BUSINESS_LIMIT_CONTROL' },
      status: 400,
      outcome: 'rate_limited',
    },
    { action: send, body: { Code: 'FREQUENCY_FAIL' }, status: 429, outcome: 'rate_limited' },
    { action: check, body: { Code: 'isv.ValidateFail' }, status: 503, outcome: 'upstream_error' },
    { action: send, body: { Code: 'OK', Success: false }, outcome: 'provider_error' },
    { action: check, body: { Code: 'Forbidden.NoPermission' }, status: 403, outcome: 'http_error' },
    { action: mail, body: { RequestId: 'private-id' }, outcome: 'invalid_response' },
    { action: mail, raw: '<invalid>private@example.test</invalid>', outcome: 'invalid_response' },
    { action: mail, raw: 'x'.repeat(32769), outcome: 'invalid_response' },
  ]

  for (const { action, body, raw, status = 200, outcome, reply, verification } of cases) {
    await t.test(`${action} ${status} ${reply ?? outcome}`, async (t) => {
      const fetch = t.mock.method(globalThis, 'fetch', async () =>
        raw
          ? new Response(raw, { status })
          : Response.json({ ...body, Message: 'private' }, { status }),
      )
      const log = t.mock.method(console, 'log', () => {})
      const call = aliyunRpc('fixture-key', 'fixture-secret', action, input)
      if (reply) assert.equal(await call, reply)
      else await assert.rejects(call, { message: 'upstream' })

      assert.equal(fetch.mock.callCount(), 1)
      assert.equal(log.mock.callCount(), 1)
      const [{ duration_ms, ...event }] = log.mock.calls[0].arguments
      assert.ok(Number.isInteger(duration_ms) && duration_ms >= 0)
      assert.deepEqual(event, {
        event: 'auth.aliyun.request',
        action,
        outcome,
        http_status: status,
        ...(verification && { verification_result: verification }),
      })
    })
  }
})

test('Aliyun separates network failures and timeouts from calls rejected before fetch', async (t) => {
  const log = t.mock.method(console, 'log', () => {})
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('private connection details')
  })

  await assert.rejects(aliyunRpc('key', 'secret', 'UnknownAction', input))
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(log.mock.callCount(), 0)

  await assert.rejects(aliyunRpc('key', 'secret', send, input))
  assert.equal(log.mock.calls[0].arguments[0].outcome, 'network_error')

  const timeout = t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort())
  await assert.rejects(aliyunRpc('key', 'secret', send, input))
  assert.equal(timeout.mock.calls[0].arguments[0], 10000)
  assert.equal(log.mock.callCount(), 2)
  assert.equal(log.mock.calls[1].arguments[0].outcome, 'timeout')
  for (const call of log.mock.calls) assert.equal(call.arguments[0].http_status, undefined)
})

test('Aliyun latency includes reading the response body', async (t) => {
  const body = new ReadableStream({
    async pull(controller) {
      await setTimeout(25)
      controller.enqueue(new TextEncoder().encode('{"Code":"OK","Success":true}'))
      controller.close()
    },
  })
  t.mock.method(globalThis, 'fetch', async () => new Response(body))
  const log = t.mock.method(console, 'log', () => {})
  assert.equal(await aliyunRpc('key', 'secret', send, input), 'accepted')
  assert.ok(log.mock.calls[0].arguments[0].duration_ms >= 15)
})
