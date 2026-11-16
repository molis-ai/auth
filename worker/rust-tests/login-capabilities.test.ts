import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {getRustProxy, initializeLocalRuntime} from '../scripts/local-runtime.mjs'

test('LOGIN-P1-04: LIVE without provider credentials exposes password only and rejects disabled clients', async () => {
  const origin = 'http://127.0.0.1:8787'
  const p = await getRustProxy({AUTH_ORIGIN:origin, UNIFIED_ACCOUNT_CONFIG:JSON.stringify({environmentId:'unified-local', kind:'LOCAL', authOrigin:origin, deliveryMode:'LIVE', providerMode:'LIVE'})})
  try {
    await initializeLocalRuntime(p)
    for (const sql of readFileSync(new URL('../unified-account-local-seed.sql', import.meta.url),'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean)) await p.env.DB.prepare(sql).run()
    await p.env.DB.prepare("UPDATE auth_environment SET delivery_mode='LIVE',provider_mode='LIVE' WHERE id='unified-local'").run()
    const response = await p.fetch(new Request(origin+'/api/v2/auth/capabilities?clientId=molis-work-unified-local'))
    assert.equal(response.status,200)
    assert.deepEqual((await response.json()).data,{methods:['ACCOUNT_PASSWORD']})
    await p.env.DB.prepare("UPDATE auth_client SET status='DISABLED' WHERE client_id='molis-work-unified-local'").run()
    assert.equal((await p.fetch(new Request(origin+'/api/v2/auth/capabilities?clientId=molis-work-unified-local'))).status,403)
    assert.equal((await p.env.DB.prepare('SELECT count(*) n FROM auth_product_transaction').first()).n,0)
  } finally { await p.dispose() }
})
