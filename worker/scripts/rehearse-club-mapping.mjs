// Cross-repository rehearsal uses Club's own mapping owner, not another implementation.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { resolve, join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sqlitePort, requireValue } from './account-migration/common.mjs'
import { initializeSynthetic, targets, origin, secret } from './account-migration/synthetic.mjs'
import { inventory } from './account-migration/inventory.mjs'
import { applyRehearsal, rollbackRehearsal } from './account-migration/cutover.mjs'

const [clubSource, output, ...extra] = process.argv.slice(2)
requireValue(
  clubSource && isAbsolute(clubSource) && output && !extra.length,
  'Usage: <absolute Club checkout> <new synthetic output directory>',
)
const { inventoryBusinessIdentities, applyBusinessIdentityDecision } = await import(
  pathToFileURL(join(clubSource, 'lib/account/business-migration.mjs')).href
)
const dir = resolve(output)
mkdirSync(dir, { mode: 0o700 })
const authPath = join(dir, 'synthetic-auth.sqlite'),
  clubPath = join(dir, 'synthetic-club.sqlite')
const auth = new DatabaseSync(authPath),
  club = new DatabaseSync(clubPath)
chmodSync(authPath, 0o600)
chmodSync(clubPath, 0o600)
try {
  auth.exec('PRAGMA foreign_keys=ON')
  club.exec('PRAGMA foreign_keys=ON')
  const db = sqlitePort(auth)
  await initializeSynthetic(db)
  for (const file of readdirSync(join(clubSource, 'drizzle'))
    .filter((f) => f.endsWith('.sql') && f < '0006')
    .sort())
    club.exec(readFileSync(join(clubSource, 'drizzle', file), 'utf8'))
  club.exec(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('original','Original name','verified@example.test',0,0,0),('unresolved','Pending same email','VERIFIED@example.test',0,0,0);INSERT INTO notes(id,work,name,body,user_id,created_at) VALUES ('historic','niulai','Historic byline','Synthetic historical feedback','original','2020-01-01')",
  )
  club
    .prepare(
      'INSERT INTO account(id,user_id,account_id,provider_id,password,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run('old-password', 'original', 'original', 'credential', 'aabb:ccdd', 0, 0)
  club
    .prepare(
      'INSERT INTO account(id,user_id,account_id,provider_id,access_token,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run('old-provider', 'original', 'synthetic-provider-subject', 'google', secret(), 0, 0)
  club
    .prepare(
      'INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run('old-session', 'original', secret(), Date.now() + 60_000, 0, 0)
  const oldCredentialsAndSessions = ['account', 'session'].map((t) =>
    club.prepare('SELECT * FROM ' + t + ' ORDER BY id').all(),
  )
  const original = club.prepare('SELECT * FROM notes').all(),
    originalUsers = club.prepare('SELECT * FROM user ORDER BY id').all()
  const before = await inventory(sqlitePort(club), 'CLUB')
  assert.equal(before.duplicateEmailGroups.length, 1)
  club.exec(
    'BEGIN;' + readFileSync(join(clubSource, 'drizzle/0006_light_prism.sql'), 'utf8') + 'COMMIT;',
  )
  assert.deepEqual(club.prepare('SELECT * FROM notes').all(), original)
  assert.deepEqual(club.prepare('SELECT * FROM user ORDER BY id').all(), originalUsers)
  assert.deepEqual(
    ['account', 'session'].map((t) => club.prepare('SELECT * FROM ' + t + ' ORDER BY id').all()),
    oldCredentialsAndSessions,
  )
  const plan = {
    formatVersion: 1,
    environment: 'SYNTHETIC_ONLY',
    runId: crypto.randomUUID(),
    inventoryDigest: (await inventory(db, 'AUTH')).sourceDigest,
    targets,
    review: { reviewedBy: 'synthetic-reviewer', evidenceReference: 'fixture-existing-owner-link' },
  }
  await applyRehearsal(db, plan)
  const decision = {
    formatVersion: 1,
    mode: 'LINK',
    issuer: origin,
    authUserId: 'verified',
    localUserId: 'original',
    status: 'VERIFIED',
    evidence: 'VERIFIED_EXISTING_LINK',
    evidenceReference: 'fixture-existing-owner-link',
    reviewedBy: 'synthetic-reviewer',
    reviewedAt: new Date().toISOString(),
    sourceDigest: inventoryBusinessIdentities(club).users.find((u) => u.localUserId === 'original')
      .sourceDigest,
    displayName: null,
  }
  assert.equal(applyBusinessIdentityDecision(club, decision).status, 'APPLIED')
  assert.equal(applyBusinessIdentityDecision(club, decision).status, 'ALREADY_APPLIED')
  assert.throws(
    () => applyBusinessIdentityDecision(club, { ...decision, authUserId: 'unverified' }),
    /conflict/,
  )
  auth.exec("INSERT INTO auth_user VALUES ('new-phone','New phone user','ACTIVE',NULL,0,0)")
  const created = {
    ...decision,
    mode: 'NEW',
    authUserId: 'new-phone',
    localUserId: 'new-phone-local',
    evidence: 'REVIEWED_NEW_IDENTITY',
    displayName: 'Phone user',
    sourceDigest: inventoryBusinessIdentities(club).inventoryDigest,
  }
  applyBusinessIdentityDecision(club, created)
  club.exec(
    "INSERT INTO notes(id,work,name,body,user_id,created_at) VALUES ('post-cutover','niulai','Current byline','Synthetic feedback after cutover','original','2026-11-05')",
  )
  const afterWrites = ['user', 'notes', 'central_business_identities'].map((t) =>
    club.prepare('SELECT * FROM ' + t + ' ORDER BY 1').all(),
  )
  await rollbackRehearsal(db, plan)
  assert.deepEqual(
    ['user', 'notes', 'central_business_identities'].map((t) =>
      club.prepare('SELECT * FROM ' + t + ' ORDER BY 1').all(),
    ),
    afterWrites,
  )
  assert.equal(
    club.prepare("SELECT name FROM notes WHERE id='historic'").get().name,
    'Historic byline',
  )
  assert.equal(
    club.prepare("SELECT email_verified FROM user WHERE id='original'").get().email_verified,
    0,
  )
  assert.equal(club.prepare("SELECT email FROM user WHERE id='new-phone-local'").get().email, null)
  assert.equal(
    club
      .prepare(
        "SELECT count(*) n FROM central_business_identities WHERE local_user_id='unresolved'",
      )
      .get().n,
    0,
  )
  assert.deepEqual(club.prepare('PRAGMA foreign_key_check').all(), [])
  assert.deepEqual(
    ['account', 'session'].map((t) => club.prepare('SELECT * FROM ' + t + ' ORDER BY id').all()),
    oldCredentialsAndSessions,
  )
  const report = {
    kind: 'SYNTHETIC_ONLY',
    existingIdAndBylinePreserved: true,
    oldCredentialsAndSessionRowsPreserved: true,
    unverifiedEmailPreserved: true,
    sameEmailNotClaimed: true,
    conflictingClaimRejected: true,
    mappingRetryIdempotent: true,
    newUserEmailNull: true,
    rollbackPreservesPostCutoverData: true,
    notesAfterRollback: 2,
    pendingLocalUsers: 1,
    productionDataAccessed: false,
  }
  writeFileSync(join(dir, 'club-mapping-report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  })
  process.stdout.write(JSON.stringify({ directory: dir, ...report }, null, 2) + '\n')
} finally {
  auth.close()
  club.close()
}
