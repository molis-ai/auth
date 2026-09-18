import { test } from 'node:test'
import assert from 'node:assert/strict'
import { permissionLevel, replaceResourceGrant } from '../src/permission-edit.ts'
test('editing preserves legacy partial permissions and unrelated resources',()=>{
 const actions=['project.read','project.update','project.delete']
 assert.equal(permissionLevel(actions,['project.read','project.update']),'custom')
 assert.deepEqual(replaceResourceGrant(['project.read','project.update'],actions,'custom'),['project.read','project.update'])
 assert.deepEqual(replaceResourceGrant(['goal.read','project.update'],actions,'read'),['goal.read','project.read'])
 assert.deepEqual(replaceResourceGrant(['goal.read'],actions,'edit'),['goal.read','project.delete','project.read','project.update'])
 assert.deepEqual(replaceResourceGrant(['goal.read','project.read'],actions,'none'),['goal.read'])
 assert.equal(permissionLevel(actions,actions),'edit')
 assert.equal(permissionLevel(actions,['project.read']),'read')
 assert.equal(permissionLevel(actions,[]),'none')
})
