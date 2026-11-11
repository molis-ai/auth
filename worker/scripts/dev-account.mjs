import { getPlatformProxy } from 'wrangler'
import { localCredential } from './local-credential.mjs'
import { fileURLToPath } from 'node:url'

// Only the local Wrangler database: never remote, never reset an existing password.
const proxy = await getPlatformProxy({
  configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
  remoteBindings: false,
  persist: { path: fileURLToPath(new URL('../.wrangler/state/v3', import.meta.url)) },
})
try {
  const config = JSON.parse(proxy.env.UNIFIED_ACCOUNT_CONFIG)
  if (
    config.kind !== 'LOCAL' ||
    config.authOrigin !== 'http://127.0.0.1:8787' ||
    config.providerMode !== 'MOCK' ||
    config.deliveryMode !== 'MOCK'
  )
    throw Error('Dev bootstrap requires the local mock environment')
  const db = proxy.env.DB
  const id = 'molis-dev-test-user',
    email = 'preview@example.test'
  const existing = await db.prepare('SELECT id FROM auth_user WHERE id=?').bind(id).first()
  const owner = await db
    .prepare('SELECT user_id FROM auth_user_email WHERE canonical_email=?')
    .bind(email)
    .first()
  if (existing || owner) {
    if (!existing || owner?.user_id !== id)
      throw Error('Dev account conflicts with existing data; no credentials were changed')
    console.log('Dev account exists; password preserved:', email)
  } else {
    const credential = await localCredential(email, 'Molis-dev-2026!')
    const now = Date.now()
    await db.batch([
      db
        .prepare(
          "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,'Molis 用户','ACTIVE',?,?)",
        )
        .bind(id, now, now),
      db
        .prepare(
          'INSERT INTO auth_user_email(id,user_id,canonical_email,created_at,verified_at) VALUES (?,?,?,?,?)',
        )
        .bind(crypto.randomUUID(), id, email, now, now),
      db
        .prepare('INSERT INTO auth_local_credential VALUES (?,?,?)')
        .bind(id, credential.encoded, now),
      db.prepare('INSERT INTO auth_user_security(user_id,updated_at) VALUES (?,?)').bind(id, now),
    ])
    console.log('Created local-only test account:', email)
  }
} finally {
  await proxy.dispose()
}
