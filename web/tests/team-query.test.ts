import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamListPath } from '../src/team-query.ts'
test('team search safely encodes names, filters, order and cursor', () => {
  const path = teamListPath(" 团队 .. &%'()+ ", 'ARCHIVED', 'desc', 'abc_def-123')
  assert.match(path, /^\/[A-Za-z0-9/_?.=&%-]+$/)
  assert.ok(!path.includes('..'))
  const url = new URL(path, 'http://localhost')
  assert.equal(url.searchParams.get('q'), "团队 .. &%'()+")
  assert.equal(url.searchParams.get('status'), 'ARCHIVED')
  assert.equal(url.searchParams.get('order'), 'desc')
  assert.equal(url.searchParams.get('cursor'), 'abc_def-123')
  assert.equal(url.searchParams.get('limit'), '25')
})
test('first page omits a cursor', () => {
  assert.ok(!teamListPath('', 'ALL', 'asc').includes('cursor='))
})
