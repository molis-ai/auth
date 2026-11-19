import { getPlatformProxy } from 'wrangler'
import { localCredential } from './local-credential.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { authEnvironment } from './environment.mjs'

async function ensureDevAccount(db, { email, password }) {
  const id = 'molis-dev-test-user'
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
    const credential = await localCredential(email, password)
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
}

export async function prepareLocalDevAccount(account, configPath) {
  const proxy = await getPlatformProxy({
    configPath,
    remoteBindings: false,
    persist: { path: fileURLToPath(new URL('../.wrangler/state/v3', import.meta.url)) },
  })
  try {
    const config = JSON.parse(proxy.env.UNIFIED_ACCOUNT_CONFIG)
    if (config.kind !== 'LOCAL' || config.authOrigin !== 'http://127.0.0.1:8787')
      throw Error('Dev account requires the loopback local database')
    await ensureDevAccount(proxy.env.DB, account)
  } finally {
    await proxy.dispose()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { previewAccount } = authEnvironment('dev', true)
  await prepareLocalDevAccount(
    previewAccount,
    fileURLToPath(new URL('../wrangler.fixture.jsonc', import.meta.url)),
  )
}
