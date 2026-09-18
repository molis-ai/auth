import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memberListPath, memberPermissionLines, memberPermissionSummary } from '../src/member-table.ts'
test('compact summaries follow actual grants, including archived and empty permissions', () => {
  const base = {actions:['feed.read'],invite:false,editableRoles:[],removableRoles:[]}
  assert.equal(memberPermissionSummary(base, false), '只读访问')
  assert.equal(memberPermissionSummary({...base, actions:['project.create']}, false), '业务协作')
  assert.equal(memberPermissionSummary({...base, invite:true, actions:['project.create']}, false), '团队管理与业务操作')
  assert.equal(memberPermissionSummary({...base, actions:['space.restore','feed.read']}, false), '团队管理与只读访问')
  assert.equal(memberPermissionSummary({...base, actions:[]}, false), '暂无可用权限')
  assert.equal(memberPermissionSummary({...base, actions:['future.write']}, false), '其他权限')
  assert.equal(memberPermissionSummary(base, true), 'Read-only access')
})
test('member search encodes email and literal punctuation with page and size', () => {
  const path = memberListPath('team-id', " 名称 .. &%'()+@example.com ", 3, 25)
  assert.match(path, /^\/[A-Za-z0-9/_?.=&%-]+$/)
  assert.ok(!path.includes('..'))
  const url = new URL(path, 'http://localhost')
  assert.equal(url.searchParams.get('q'), "名称 .. &%'()+@example.com")
  assert.equal(url.searchParams.get('page'), '3')
  assert.equal(url.searchParams.get('limit'), '25')
  assert.equal(url.searchParams.get('sort'), 'role')
  assert.equal(url.searchParams.get('order'), 'desc')
  const sorted = new URL(memberListPath('team-id', '名称', 1, 10, 'name', 'asc'), 'http://localhost')
  assert.equal(sorted.searchParams.get('sort'), 'name')
  assert.equal(sorted.searchParams.get('order'), 'asc')
})
test('permission labels only describe returned grants and preserve target role limits', () => {
  const lines = memberPermissionLines({actions:['feed.read'],invite:false,editableRoles:[],removableRoles:[]}, false)
  assert.deepEqual(lines, ['查看 Feed'])
  const admin = memberPermissionLines({actions:['space.update'],invite:true,editableRoles:['MEMBER','VIEWER'],removableRoles:['MEMBER','VIEWER']}, false)
  assert.ok(admin.includes('邀请成员'))
  assert.ok(admin.includes('调整角色：成员、只读成员'))
  assert.ok(!admin.join(' ').includes('管理员'))
  assert.deepEqual(memberPermissionLines({actions:[],invite:false,editableRoles:[],removableRoles:[]}, true), [])
})
