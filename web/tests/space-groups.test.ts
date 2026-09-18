import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupSpaces } from '../src/space-groups.ts'
test('personal spaces are excluded and every team belongs to exactly one role group', () => {
  const spaces = [
    {id: 'personal', spaceType: 'PERSONAL', role: 'OWNER'},
    {id: 'owner', spaceType: 'TEAM', role: 'OWNER'},
    {id: 'admin', spaceType: 'TEAM', role: 'ADMIN'},
    {id: 'member', spaceType: 'TEAM', role: 'MEMBER'},
    {id: 'viewer', spaceType: 'TEAM', role: 'VIEWER'},
  ] as const
  const result = groupSpaces([...spaces])
  assert.deepEqual(result.owned.map(s => s.id), ['owner'])
  assert.deepEqual(result.managed.map(s => s.id), ['admin'])
  assert.deepEqual(result.joined.map(s => s.id), ['member', 'viewer'])
  assert.equal(new Set(Object.values(result).flat().map(s => s.id)).size, spaces.length - 1)
  assert.equal(Object.values(result).flat().some(s => s.spaceType === 'PERSONAL'), false)
})
test('empty groups and changed roles remain accurate', () => {
  assert.deepEqual(groupSpaces([]), {owned: [], managed: [], joined: []})
  assert.equal(groupSpaces([{spaceType: 'TEAM', role: 'ADMIN'}]).managed.length, 1)
  assert.equal(groupSpaces([{spaceType: 'TEAM', role: 'MEMBER'}]).managed.length, 0)
})
