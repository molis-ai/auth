import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { workspacePages, workspacePage, workspaceTeam, rememberedTeam, rememberTeam, clearAccountWorkspace, isPlatformPage } from '../src/workspace.ts'
test('team selection URLs allow only canonical IDs', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  assert.equal(workspacePage('#/spaces/' + id), 'spaces')
  assert.equal(workspaceTeam('#/spaces/' + id), id)
  for (const hash of ['#/spaces/evil', '#/spaces/' + id + '?token=secret', '#/spaces/../users']) assert.equal(workspaceTeam(hash), undefined)
})
test('workspace URL state accepts only known non-secret destinations', () => {
  for (const page of workspacePages) assert.equal(workspacePage('#/' + page), page)
  for (const value of ['', '#/unknown', '#/https://evil.test', '#transaction=secret', '#/users?token=secret']) assert.equal(workspacePage(value), 'account')
  assert.equal(isPlatformPage('spaces'), false)
  assert.equal(isPlatformPage('users'), true)
  assert.equal(isPlatformPage('permissions'), true)
  assert.equal(workspacePage('#/permissions'), 'permissions')
})
test('personal actions live in an accessible bottom account disclosure', () => {
  const menu=readFileSync(new URL('../src/UserMenu.vue', import.meta.url),'utf8')
  const page=readFileSync(new URL('../src/Console.vue', import.meta.url),'utf8')
  assert.match(menu, /<details/); assert.match(menu, /<summary/)
  assert.match(menu, /Escape/); assert.match(menu, /removeEventListener\('pointerdown'/)
  assert.match(menu, /个人资料/); assert.match(menu, /账号安全/)
  assert.match(menu, /bottom: calc\(100% \+ 8px\)/)
  assert.equal((page.match(/<UserMenu /g) || []).length, 2)
})
test('workspace provides accessible desktop and modal mobile navigation without storing credentials', () => {
  const page=readFileSync(new URL('../src/Console.vue', import.meta.url),'utf8')
  assert.match(page, /aria-current/); assert.match(page, /showModal\(\)/)
  assert.match(page, /popstate/); assert.match(page, /beforeunload/)
  assert.match(page, /isPlatformPage\(value\) && !administrator.value/)
  assert.ok(page.includes(`v-show="['spaces', 'team-create'].includes(page)"`))
  assert.ok(page.includes(`:creation-page="page === 'team-create'"`))
  assert.match(page, /setItem\('molis.auth.workspace-page', page.value\)/)
})

test('remembered teams are isolated by account and ignore the legacy shared key', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  const values = new Map<string, string>([['molis.auth.workspace-team', id]])
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  assert.equal(rememberedTeam(storage, 'new-user'), undefined)
  rememberTeam(storage, 'owner', id)
  assert.equal(rememberedTeam(storage, 'owner'), id)
  assert.equal(rememberedTeam(storage, 'new-user'), undefined)
  rememberTeam(storage, 'owner')
  assert.equal(rememberedTeam(storage, 'owner'), undefined)
  rememberTeam(storage, 'owner', 'invalid')
  assert.equal(rememberedTeam(storage, 'owner'), undefined)
})
test('team persistence tolerates unavailable browser storage', () => {
  const storage = { getItem: () => { throw Error('denied') }, setItem: () => { throw Error('denied') }, removeItem: () => { throw Error('denied') } }
  assert.equal(rememberedTeam(storage, 'user'), undefined)
  assert.doesNotThrow(() => rememberTeam(storage, 'user'))
})

test('logout removes account navigation and provider handoff while preserving logout suppression and preferences', () => {
  const values = new Map<string, string>([
    ['molis.auth.workspace-page', 'users'], ['molis.auth.workspace-team', 'legacy'],
    ['molis.auth.workspace-team:user', 'team'], ['molis.auth.provider-restart.v1', 'old'],
    ['sdk:paused', '1'], ['molis.auth.locale', 'en'], ['unrelated', 'keep'],
  ])
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  assert.equal(clearAccountWorkspace(storage, 'user'), true)
  assert.deepEqual([...values.keys()], ['sdk:paused', 'molis.auth.locale', 'unrelated'])
  assert.equal(clearAccountWorkspace(storage, 'user'), true)
})
test('logout cleanup continues after a storage failure and reports incomplete cleanup', () => {
  const removed: string[] = []
  const storage = { getItem: () => null, setItem: () => {}, removeItem: (key: string) => { removed.push(key); if (key.endsWith('workspace-page')) throw Error('denied') } }
  assert.equal(clearAccountWorkspace(storage, 'user'), false)
  assert.ok(removed.includes('molis.auth.workspace-team:user'))
})
test('normal logout, all-device logout and ended sessions share full frontend cleanup', () => {
  const page = readFileSync(new URL('../src/Console.vue', import.meta.url), 'utf8')
  assert.match(page, /finally \{ cleared = clearAccountState\(\) \}/)
  assert.match(page, /function sessionEnded[^\n]+clearAccountState\(\)/)
  assert.match(page, /catalog.value = \[\]/)
  assert.match(page, /permissionDraft.value = false/)
  assert.ok(page.includes("if (result?.serverRevoked && result.restorePaused && cleared) location.replace('/login')"))
  assert.ok(page.includes("if (restorePaused && cleared) location.replace('/login')"))
  assert.match(page, /history.replaceState\(null, '', '\/console#\/account'\)/)
})
