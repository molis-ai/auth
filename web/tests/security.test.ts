import { test } from 'node:test'
import assert from 'node:assert/strict'
import { revokeAuthentication, unlinkIdentity } from '../src/security-api.ts'
import { ConsoleError } from '../src/console-api.ts'
const id = 'b89f2809-42c7-4c31-850b-57c1c35da457'
function client() {
  const calls: unknown[] = []
  return { calls, async getAccessToken() { return 'test-access' }, async logout(options: unknown) { calls.push(options); return { serverRevoked: false, restorePaused: true } } }
}
test('committed identity unlink clears only local SDK state without another request', async () => {
  const auth = client(); let calls = 0
  const result = await unlinkIdentity(auth, id, async (url, init) => {
    calls++; assert.equal(url, '/api/v1/sessions/login-methods/' + id + '/unlink'); assert.equal(init?.body, '{}')
    return new Response(JSON.stringify({ data: { unlinked: true, loggedOut: true } }))
  })
  assert.equal(result.restorePaused, true); assert.equal(calls, 1); assert.deepEqual(auth.calls, [{ localOnly: true }])
})
test('unlink cannot clear credentials or claim success after uncertain or rejected responses', async () => {
  const auth = client(); let calls = 0
  await assert.rejects(unlinkIdentity(auth, id, async () => { calls++; throw new Error('private network detail') }), ConsoleError)
  for (const data of [null, { unlinked: false, loggedOut: true }, { unlinked: true, loggedOut: false }])
    await assert.rejects(unlinkIdentity(auth, id, async () => new Response(JSON.stringify({ data }))), ConsoleError)
  await assert.rejects(unlinkIdentity(auth, '../other'), ConsoleError)
  assert.equal(calls, 1); assert.equal(auth.calls.length, 0)
})
test('confirmed current-root revocation clears SDK locally without a second server request', async () => {
  const auth = client(); let calls = 0
  const result = await revokeAuthentication(auth, id, async (url, init) => {
    calls++; assert.equal(url, '/api/v1/sessions/authentications/' + id + '/revoke')
    assert.equal(init?.body, '{}'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error')
    return new Response(JSON.stringify({ data: { revoked: true, current: true } }))
  })
  assert.deepEqual(result, { current: true, restorePaused: true }); assert.equal(calls, 1); assert.deepEqual(auth.calls, [{ localOnly: true }])
})
test('revoking another root leaves this SDK session alone', async () => {
  const auth = client()
  assert.deepEqual(await revokeAuthentication(auth, id, async () => new Response(JSON.stringify({ data: { revoked: true, current: false } }))), { current: false, restorePaused: false })
  assert.equal(auth.calls.length, 0)
})
test('unconfirmed writes and malformed results cannot claim success or clear local state', async () => {
  const auth = client(); let calls = 0
  await assert.rejects(revokeAuthentication(auth, id, async () => { calls++; throw new Error('private'); }), (e: unknown) => e instanceof ConsoleError && e.uncertain)
  for (const result of [{ revoked: false, current: true }, { revoked: true, current: 'true' }, null])
    await assert.rejects(revokeAuthentication(auth, id, async () => new Response(JSON.stringify({ data: result }))), (e: unknown) => e instanceof ConsoleError && e.code === 'INVALID_RESPONSE' && e.uncertain)
  assert.equal(calls, 1); assert.equal(auth.calls.length, 0)
  await assert.rejects(revokeAuthentication(auth, '../logout-all'), ConsoleError)
})
