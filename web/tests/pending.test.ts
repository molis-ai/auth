import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPending } from '../src/pending-api.ts'
import { workspacePage, isPlatformPage } from '../src/workspace.ts'
import { readFileSync } from 'node:fs'
const client = { getAccessToken: async () => 'test-access' }
test('pending invitation count includes every page without duplicate items', async () => {
  const paths: string[] = []
  const transport = (async (path: string) => {
    paths.push(path)
    return Response.json({data: paths.length === 1 ? {items: [{id:'a'}], nextCursor:'a'} : {items:[{id:'a'},{id:'b'}],nextCursor:null}})
  }) as typeof fetch
  assert.deepEqual((await loadPending(client,transport)).map(item => item.id), ['a','b'])
  assert.equal(paths.length,2); assert.match(paths[1], /cursor=a/)
})
test('failed and looping pagination never become a false zero count', async () => {
  await assert.rejects(loadPending(client, (async () => Response.json({error:{code:'AUTH_UNAVAILABLE'}},{status:503})) as typeof fetch))
  await assert.rejects(loadPending(client, (async () => Response.json({data:{items:[],nextCursor:'same'}})) as typeof fetch), /INVALID_RESPONSE/)
})
test('pending is a personal route and outgoing invitations remain in team details', () => {
  assert.equal(workspacePage('#/pending'),'pending'); assert.equal(isPlatformPage('pending'),false)
  const spaces = readFileSync(new URL('../src/Spaces.vue',import.meta.url),'utf8')
  const menu = readFileSync(new URL('../src/UserMenu.vue',import.meta.url),'utf8')
  assert.doesNotMatch(spaces, /class="space-inbox"|function answer\(/)
  assert.match(spaces, /function revoke\(/)
  assert.match(menu, /emit\('navigate', 'pending'\)/)
})
