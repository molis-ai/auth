import { readFileSync, readdirSync } from 'node:fs'
import { randomBytes, pbkdf2Sync, createHash } from 'node:crypto'
import { statement } from './common.mjs'
import { markSyntheticDatabase } from './cutover.mjs'
export const origin = 'http://127.0.0.1:8787'
export const config = {
  environmentId: 'unified-local',
  kind: 'LOCAL',
  authOrigin: origin,
  deliveryMode: 'MOCK',
  providerMode: 'MOCK',
}
export const targets = [
  {
    product: 'WORK',
    legacyClientId: 'synthetic-old-work',
    newClientId: 'molis-work-unified-local',
  },
  {
    product: 'CLUB',
    legacyClientId: 'synthetic-old-club',
    newClientId: 'molis-club-unified-local',
  },
]
export const hash = (value) => createHash('sha256').update(value).digest('hex')
export const challenge = (value) => createHash('sha256').update(value).digest('base64url')
export const secret = () => randomBytes(32).toString('base64url')
export async function sqlFile(db, file) {
  for (const sql of readFileSync(file, 'utf8')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((v) => v.trim())
    .filter(Boolean))
    await db.prepare(sql).bind().run()
}
export async function initializeSynthetic(db) {
  const directory = new URL('../../migrations/', import.meta.url)
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await sqlFile(db, new URL(file, directory))
  await sqlFile(db, new URL('../../local-seed.sql', import.meta.url))
  await seedSynthetic(db)
}
/** Synthetic data only; real product operations are exercised separately through Rust HTTP. */
export async function seedSynthetic(db) {
  await sqlFile(db, new URL('../../unified-account-local-seed.sql', import.meta.url))
  const now = Date.now(),
    password = secret(),
    salt = randomBytes(16),
    encoded =
      '{pbkdf2-sha256-600k-v1}' +
      salt.toString('hex') +
      pbkdf2Sync(password.normalize('NFC'), salt, 600000, 32, 'sha256').toString('hex')
  const legacyClients = [...targets.map((t) => t.legacyClientId), 'synthetic-other-product'],
    accesses = {},
    refreshes = {},
    codes = {},
    verifiers = {}
  const writes = [
    statement(
      db,
      "INSERT INTO auth_application(id,name) VALUES ('synthetic-products','Synthetic product applications')",
    ),
  ]
  for (const id of ['verified', 'unverified', 'review-required']) {
    writes.push(
      statement(
        db,
        "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,?,'ACTIVE',?,?)",
        id,
        'Synthetic ' + id,
        now,
        now,
      ),
      statement(
        db,
        'INSERT INTO auth_user_email VALUES (?,?,?,?,?)',
        'email-' + id,
        id,
        id + '@example.test',
        id === 'verified' ? now : null,
        now,
      ),
      statement(
        db,
        'INSERT INTO auth_local_credential VALUES (?,?,?)',
        id,
        id === 'review-required' ? 'unsupported-synthetic-format' : encoded,
        now,
      ),
      statement(
        db,
        "INSERT INTO auth_space(id,name,space_type,status,personal_user_id,created_at,updated_at) VALUES (?,?,'PERSONAL','ACTIVE',?,?,?)",
        'personal-' + id,
        'Synthetic personal',
        id,
        now,
        now,
      ),
      statement(
        db,
        "INSERT INTO auth_membership VALUES (?,?,'OWNER',?)",
        'personal-' + id,
        id,
        now,
      ),
    )
  }
  writes.push(
    statement(
      db,
      "INSERT INTO auth_external_identity VALUES ('existing-google','verified','GOOGLE','https://accounts.google.com','synthetic-stable-google-subject',?)",
      now,
    ),
    statement(
      db,
      "INSERT INTO auth_external_identity VALUES ('existing-apple','review-required','APPLE','https://appleid.apple.com','synthetic-stable-apple-subject',?)",
      now,
    ),
    statement(
      db,
      "INSERT INTO auth_space(id,name,space_type,status,created_at,updated_at) VALUES ('old-team','Preserved old team','TEAM','ACTIVE',?,?)",
      now,
      now,
    ),
    statement(db, "INSERT INTO auth_membership VALUES ('old-team','verified','OWNER',?)", now),
    statement(db, "INSERT INTO auth_membership VALUES ('old-team','unverified','VIEWER',?)", now),
    statement(
      db,
      "INSERT INTO auth_authentication(id,user_id,cookie_hash,created_at,activity_at) VALUES ('shared-root','verified',?,?,?)",
      hash(secret()),
      now,
      now,
    ),
  )
  for (const client of legacyClients) {
    const access = secret(),
      refresh = secret(),
      code = secret(),
      verifier = secret()
    verifiers[client] = verifier
    accesses[client] = access
    refreshes[client] = refresh
    codes[client] = code
    writes.push(
      statement(
        db,
        "INSERT INTO auth_client(id,client_id,application_id,client_type,scopes,redirects) VALUES (?,?,'synthetic-products','WEB','[\"account\",\"profile\"]',?)",
        client,
        client,
        JSON.stringify([origin + '/old/callback']),
      ),
      statement(
        db,
        'INSERT INTO auth_grant VALUES (?,\'shared-root\',?,\'["account","profile"]\',?,NULL)',
        'grant-' + client,
        client,
        now,
      ),
      statement(
        db,
        'INSERT INTO auth_access_token VALUES (?,?,?)',
        hash(access),
        'grant-' + client,
        now + 900000,
      ),
      statement(
        db,
        'INSERT INTO auth_refresh_token VALUES (?,?,?,NULL)',
        hash(refresh),
        'grant-' + client,
        now + 86400000,
      ),
      statement(
        db,
        "INSERT INTO auth_code VALUES (?,?,?,?,'[\"account\"]','shared-root',?,NULL)",
        hash(code),
        client,
        origin + '/old/callback',
        challenge(verifier),
        now + 600000,
      ),
      statement(
        db,
        "INSERT INTO auth_transaction(token_hash,context,status,expires_at,authentication_id) VALUES (?,?,'AUTHENTICATED',?,'shared-root')",
        hash('tx-' + client),
        JSON.stringify({ clientId: client }),
        now + 600000,
      ),
    )
  }
  for (const target of targets)
    writes.push(
      statement(
        db,
        "UPDATE auth_client SET status='DISABLED' WHERE client_id=?",
        target.newClientId,
      ),
    )
  await db.batch(writes)
  await markSyntheticDatabase(db)
  return { password, accesses, refreshes, codes, verifiers, targets, verifiedUserId: 'verified' }
}
