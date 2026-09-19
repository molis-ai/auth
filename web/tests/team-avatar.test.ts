import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateTeamAvatar, readTeamAvatar, TeamAvatarError } from '../src/team-avatar.ts'
test('team avatar accepts JPG up to 5 MiB and distinguishes size and format errors',()=>{
  for(const type of ['image/jpeg','image/png','image/webp']) assert.doesNotThrow(()=>validateTeamAvatar({type,size:5*1024*1024}))
  assert.throws(()=>validateTeamAvatar({type:'image/jpeg',size:5*1024*1024+1}),e=>e instanceof TeamAvatarError&&e.code==='size')
  assert.throws(()=>validateTeamAvatar({type:'image/svg+xml',size:100}),e=>e instanceof TeamAvatarError&&e.code==='format')
})
test('team avatar uses CSP-compatible data URLs and reports reader failures',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'FileReader')
  let fail=false
  class Reader {
    result='data:image/jpeg;base64,AA=='
    onload?:()=>void; onerror?:()=>void; onabort?:()=>void
    readAsDataURL(){if(fail)this.onerror?.();else this.onload?.()}
  }
  Object.defineProperty(globalThis,'FileReader',{value:Reader,configurable:true})
  try {
    const file={type:'image/jpeg',size:100} as File
    assert.equal(await readTeamAvatar(file),'data:image/jpeg;base64,AA==')
    fail=true;await assert.rejects(readTeamAvatar(file),e=>e instanceof TeamAvatarError&&e.code==='read')
  } finally {if(descriptor)Object.defineProperty(globalThis,'FileReader',descriptor);else Reflect.deleteProperty(globalThis,'FileReader')}
})
test('team upload keeps CSP restrictions and reports errors without replacing existing avatar',()=>{
  const source=readFileSync(new URL('../src/TeamCreate.vue',import.meta.url),'utf8')
  const helper=readFileSync(new URL('../src/team-avatar.ts',import.meta.url),'utf8')
  const security=readFileSync(new URL('../../worker/src/app.ts',import.meta.url),'utf8')
  assert.match(source,/avatar.value = await prepareTeamAvatar/)
  assert.doesNotMatch(source+helper,/createObjectURL/)
  assert.match(security,/img-src 'self' data:;/)
  assert.match(source,/图片无法解析或处理/)
})
