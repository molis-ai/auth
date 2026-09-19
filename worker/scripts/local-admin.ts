import { getPlatformProxy } from 'wrangler'
import { encodePassword } from '../src/security/password-policy.ts'
import { email } from '../src/shared/http.ts'
import { Store } from '../src/infrastructure/database.ts'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// No remote flags, account tokens, or production bindings accepted by this command.
const proxy = await getPlatformProxy<{ DB: D1Database; AUTH_ORIGIN: string }>({
  configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
  remoteBindings: false,
})
try {
  if (proxy.env.AUTH_ORIGIN !== 'http://127.0.0.1:8787') throw new Error('Local bootstrap only')
  const s = new Store(proxy.env.DB),
    id = '826b9c2a-f24a-4ca6-a747-411a5579b643',
    address = email(process.env.LOCAL_ADMIN_EMAIL ?? 'admin@example.com')
  if (
    (await s.one('SELECT id FROM auth_user WHERE id=?', id)) ||
    (await s.one('SELECT id FROM auth_user_email WHERE canonical_email=?', address))
  )
    throw new Error(
      'Account already exists; refusing to overwrite credentials or adopt another account.',
    )
  const password = process.env.LOCAL_ADMIN_PASSWORD ?? randomBytes(24).toString('base64url'),
    encoded = await encodePassword(password),
    now = Date.now(),
    space = crypto.randomUUID()
  await s.batch([
    s.statement(
      "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,'本地管理员','ACTIVE',?,?)",
      id,
      now,
      now,
    ),
    s.statement(
      'INSERT INTO auth_user_email(id,user_id,canonical_email,created_at) VALUES (?,?,?,?)',
      crypto.randomUUID(),
      id,
      address,
      now,
    ),
    s.statement('INSERT INTO auth_local_credential VALUES (?,?,?)', id, encoded, now),
    s.statement(
      "INSERT INTO auth_space(id,name,space_type,status,personal_user_id,created_at,updated_at) VALUES (?,'个人空间','PERSONAL','ACTIVE',?,?,?)",
      space,
      id,
      now,
      now,
    ),
    s.statement("INSERT INTO auth_membership VALUES (?,?,'OWNER',?)", space, id, now),
  ])
  console.log('Local administrator created:', address)
  if (!process.env.LOCAL_ADMIN_PASSWORD) console.log('Generated password (shown once):', password)
} finally {
  await proxy.dispose()
}
