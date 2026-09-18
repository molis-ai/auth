import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restoreConsoleSession } from '../src/console-restore.ts'
import { ApiError } from '../src/protocol.ts'
const origin = 'https://auth.example.test', redirect = origin + '/console/callback', tx = 't'.repeat(43)
function fixture() {
  const calls: string[] = []
  const context = { id: 'request', clientId: 'console', redirectUri: redirect, clientType: 'WEB', forceLogin: false, state: 's'.repeat(43) }
  const client = { restorePaused: false, beginLogin: async () => { calls.push('begin'); return { loginUrl: origin + '/login#transaction=' + tx } }, logout: async () => { calls.push('clear'); return { serverRevoked: false, restorePaused: true } } }
  const transport = async (path: string) => {
    calls.push(path)
    if (path.endsWith('/context')) return { context, status: 'READY' }
    if (path.endsWith('/restore')) return { continueUrl: origin + '/complete#transaction=' + tx }
    if (path.endsWith('/confirmation')) return { confirmation: 'p'.repeat(43), account: { userId: '11111111-1111-1111-1111-111111111111', emails: ['test@example.test'] } }
    return { redirectTo: redirect + '?code=' + 'c'.repeat(43) + '&state=' + context.state }
  }
  return { calls, client, transport, context }
}
test('console restoration completes in memory without navigating', async () => {
  const f = fixture()
  assert.equal(await restoreConsoleSession(f.client, origin, 'console', redirect, async url => { assert.ok(url.startsWith(redirect)); f.calls.push('exchange'); return true }, f.transport), true)
  assert.deepEqual(f.calls, ['begin', '/transactions/context', '/transactions/restore', '/transactions/confirmation', '/transactions/complete', 'exchange'])
})
test('explicit logout suppresses restore and expired sessions remain on the page', async () => {
  const f = fixture(); f.client.restorePaused = true
  assert.equal(await restoreConsoleSession(f.client, origin, 'console', redirect, async () => true, f.transport), false)
  assert.deepEqual(f.calls, [])
  f.client.restorePaused = false
  assert.equal(await restoreConsoleSession(f.client, origin, 'console', redirect, async () => true, async path => {
    if (path.endsWith('/restore')) throw new ApiError('LOGIN_REQUIRED')
    return f.transport(path)
  }), false)
  assert.equal(f.calls.at(-1), 'clear')
})
test('other applications and uncertain responses cannot silently continue', async () => {
  const f = fixture(); f.context.clientId = 'other'
  await assert.rejects(restoreConsoleSession(f.client, origin, 'console', redirect, async () => assert.fail('must not continue'), f.transport))
  assert.ok(!f.calls.includes('/transactions/restore'))
  const second = fixture()
  await assert.rejects(restoreConsoleSession(second.client, origin, 'console', redirect, async () => true, async () => { throw new ApiError('NETWORK_ERROR') }))
  assert.deepEqual(second.calls, ['begin', 'clear'])
})
