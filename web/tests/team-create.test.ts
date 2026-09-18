import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { workspacePage, isPlatformPage } from '../src/workspace.ts'
test('team creation has a non-admin standalone route', () => {
  assert.equal(workspacePage('#/team-create'), 'team-create')
  assert.equal(isPlatformPage('team-create'), false)
})
test('creation form exposes real fields, submission lock and draft lifecycle', () => {
  const source = readFileSync(new URL('../src/TeamCreate.vue', import.meta.url), 'utf8')
  assert.ok(source.includes('avatarUrl: avatar.value'))
  assert.ok(source.includes('description: description.value.trim()'))
  assert.ok(source.includes('if (locked.value || uncertain.value) return'))
  assert.ok(source.includes("emit('draft', false)"))
  assert.ok(source.includes('aria-invalid'))
  assert.ok(!source.includes('<dialog'))
})
