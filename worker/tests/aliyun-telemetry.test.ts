import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { aliyunRpc } from '../rust/src/runtime/aliyun.js'

const mail = 'SingleSendMail'
const send = 'SendSmsVerifyCode'
const check = 'CheckSmsVerifyCode'
const requestId = crypto.randomUUID()
const input = JSON.stringify({
  PhoneNumber: '13800000000',
  ToAddress: 'private@example.test',
  VerifyCode: '123456',
})

function readEvent(args: unknown[]) {
  assert.equal(args.length, 1)
  const [line] = args
  assert.equal(typeof line, 'string')
  assert.doesNotMatch(line as string, /[\r\n]/)
  return JSON.parse(line as string)
}

test('AC-AUTH-02/03 Aliyun logs one sanitized JSON event per request and reports the provider result', async (t) => {
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
    {
      action: send,
      body: { Code: 'FREQUENCY_FAIL' },
      status: 429,
      reply: 'rate_limited',
      outcome: 'rate_limited',
    },
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
      const call = aliyunRpc('fixture-key', 'fixture-secret', action, input, requestId, 'test')
      if (reply) assert.equal(await call, reply)
      else await assert.rejects(call, { message: 'upstream' })

      assert.equal(fetch.mock.callCount(), 1)
      assert.equal(log.mock.callCount(), 1)
      const { duration_ms, ...event } = readEvent(log.mock.calls[0].arguments)
      assert.ok(Number.isInteger(duration_ms) && duration_ms >= 0)
      assert.deepEqual(event, {
        schema: 1,
        service: 'molis-auth',
        env: 'test',
        event: 'auth.aliyun.request',
        request_id: requestId,
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

  await assert.rejects(aliyunRpc('key', 'secret', 'UnknownAction', input, requestId, 'prod'))
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(log.mock.callCount(), 0)

  await assert.rejects(aliyunRpc('key', 'secret', send, input, requestId, 'prod'))
  assert.equal(readEvent(log.mock.calls[0].arguments).outcome, 'network_error')

  const timeout = t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort())
  await assert.rejects(aliyunRpc('key', 'secret', send, input, requestId, 'private-env'))
  assert.equal(timeout.mock.calls[0].arguments[0], 10000)
  assert.equal(log.mock.callCount(), 2)
  assert.equal(readEvent(log.mock.calls[1].arguments).outcome, 'timeout')
  assert.equal(readEvent(log.mock.calls[1].arguments).env, 'unknown')
  for (const call of log.mock.calls) assert.equal(readEvent(call.arguments).http_status, undefined)
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
  assert.equal(await aliyunRpc('key', 'secret', send, input, requestId, 'dev'), 'accepted')
  assert.ok(readEvent(log.mock.calls[0].arguments).duration_ms >= 15)
})
