import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editableRoles, removable, type Role } from '../src/space-policy.ts'
import { spaceApi } from '../src/console-api.ts'
test('UI role choices never assign Owner and enforce the Admin target boundary', () => {
  const roles: Role[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']
  for (const actor of roles) for (const target of roles) assert.ok(!editableRoles(actor, target, false, false).includes('OWNER'))
  assert.deepEqual(editableRoles('ADMIN', 'ADMIN', false, false), [])
  assert.deepEqual(editableRoles('ADMIN', 'MEMBER', false, false), ['MEMBER', 'VIEWER'])
  assert.deepEqual(editableRoles('OWNER', 'ADMIN', false, false), ['ADMIN', 'MEMBER', 'VIEWER'])
  assert.deepEqual(editableRoles('OWNER', 'MEMBER', false, true), [])
})
test('UI never removes an Owner or personal membership and permits archived non-Owner removal', () => {
  assert.equal(removable('OWNER', 'OWNER', false), false)
  assert.equal(removable('OWNER', 'MEMBER', true), false)
  assert.equal(removable('ADMIN', 'ADMIN', false), false)
  assert.equal(removable('ADMIN', 'MEMBER', false), true)
})
test('space operations use the shared safe transport but not the platform administrator API', async () => {
  let calls = 0
  await spaceApi({ async getAccessToken() { return 'user-token' } }, '/invitations/test/accept', 'POST', {}, async (url, options) => {
    calls++; assert.equal(url, '/api/v1/invitations/test/accept'); assert.equal(options?.credentials, 'omit'); assert.equal(options?.body, '{}')
    return new Response(JSON.stringify({ data: { status: 'ACCEPTED' } }))
  })
  assert.equal(calls, 1)
})
