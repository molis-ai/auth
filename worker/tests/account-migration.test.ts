import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sqlitePort, digest, all } from '../scripts/account-migration/common.mjs'
import { inventory, credentialFormat } from '../scripts/account-migration/inventory.mjs'
import { applyRehearsal, rollbackRehearsal } from '../scripts/account-migration/cutover.mjs'
import { initializeSynthetic, targets, sqlFile } from '../scripts/account-migration/synthetic.mjs'
import { run } from '../scripts/account-migration.mjs'

async function fixture(t: { after: (f: () => void) => void }) {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  sql.exec('PRAGMA foreign_keys=ON')
  const db = sqlitePort(sql)
  await initializeSynthetic(db)
  const plan = {
    formatVersion: 1,
    environment: 'SYNTHETIC_ONLY',
    runId: crypto.randomUUID(),
    inventoryDigest: (await inventory(db, 'AUTH')).sourceDigest,
    targets,
    review: { reviewedBy: 'fixture-reviewer', evidenceReference: 'fixture-proof' },
  }
  return { sql, db, plan }
}
const unchangedTables = [
  'auth_user',
  'auth_user_email',
  'auth_local_credential',
  'auth_external_identity',
  'auth_space',
  'auth_membership',
  'auth_authentication',
  'auth_user_security',
]
const snapshot = async (db: ReturnType<typeof sqlitePort>) =>
  Promise.all(unchangedTables.map((t) => all(db, 'SELECT * FROM ' + t + ' ORDER BY 1')))

test('AUTH11-01 UAS-27/28/30: inventory preserves data, redacts credentials and reports actual unknowns', async (t) => {
  const { sql, db } = await fixture(t),
    before = await snapshot(db),
    report = await inventory(db, 'AUTH'),
    text = JSON.stringify(report)
  assert.equal(report.observedDeploymentVersion, 'NOT_OBSERVED')
  assert.equal(
    report.users.find((u) => u.userId === 'verified').passwordFormat,
    'AUTH_PBKDF2_SHA256_600K_V1',
  )
  assert.ok(
    report.users
      .find((u) => u.userId === 'unverified')
      .reviewRequired.includes('EMAIL_VERIFICATION_REQUIRED'),
  )
  assert.ok(
    report.users
      .find((u) => u.userId === 'review-required')
      .reviewRequired.includes('PASSWORD_FORMAT'),
  )
  assert.equal(report.teams[0].disposition, 'REVIEW_REQUIRED_NO_AUTO_ENROLLMENT')
  assert.ok(report.teams[0].members.some((m) => m.role === 'VIEWER'))
  assert.doesNotMatch(
    text,
    /@example.test|password_hash|canonical_email|synthetic-stable-google-subject|unsupported-synthetic-format/,
  )
  assert.deepEqual(await snapshot(db), before)
  sql
    .prepare('INSERT INTO auth_user_email VALUES (?,?,?,?,?)')
    .run('case-variant', 'unverified', 'VERIFIED@example.test', null, 0)
  assert.equal((await inventory(db, 'AUTH')).duplicateEmailGroups.length, 1)
  assert.equal(
    credentialFormat('{pbkdf2-sha256-600k-v1}' + 'AB'.repeat(48)),
    'UNKNOWN_REQUIRES_REVIEW',
  )
})
test('AUTH11-02 UAS-27/28/30: Club formats and duplicate identities remain pending, inventory creates no mapping', async (t) => {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  sql.exec(
    "CREATE TABLE user(id TEXT,email TEXT,email_verified INTEGER);CREATE TABLE account(id TEXT,user_id TEXT,provider_id TEXT,account_id TEXT,password TEXT);CREATE TABLE session(id TEXT,user_id TEXT);CREATE TABLE notes(id TEXT,user_id TEXT,name TEXT,body TEXT);INSERT INTO user VALUES ('old','shared@example.test',0),('case','SHARED@example.test',1),('phone',NULL,0);INSERT INTO account VALUES ('credential','old','credential','old','aabb:ccdd'),('google-a','old','google','same-stable-subject',NULL),('google-b','case','google','same-stable-subject',NULL);INSERT INTO notes VALUES ('note','old','Preserved author','private historical content')",
  )
  const report = await inventory(sqlitePort(sql), 'CLUB')
  assert.equal(report.duplicateEmailGroups.length, 1)
  assert.equal(report.duplicateExternalIdentityGroups.length, 1)
  assert.equal(report.users.find((u) => u.userId === 'old').emailVerified, false)
  assert.equal(report.users.find((u) => u.userId === 'phone').emailPresent, false)
  assert.ok(report.users.every((u) => u.disposition === 'REVIEW_REQUIRED_NO_EMAIL_CLAIM'))
  assert.doesNotMatch(
    JSON.stringify(report),
    /shared@example|aabb:ccdd|same-stable-subject|private historical content/,
  )
  assert.equal(
    sql
      .prepare("SELECT count(*) n FROM sqlite_master WHERE name='central_business_identities'")
      .get().n,
    0,
  )
})
test('AUTH11-01: inventory supports the pre-v2 Auth schema without applying migrations', async (t) => {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  const db = sqlitePort(sql),
    directory = new URL('../migrations/', import.meta.url)
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith('.sql') && f < '0005')
    .sort())
    await sqlFile(db, new URL(file, directory))
  const report = await inventory(db, 'AUTH')
  assert.equal(report.observedDeploymentVersion, 'NOT_OBSERVED')
  assert.equal(report.counts.auth_user, 0)
  assert.equal(report.counts.auth_user_security, undefined)
  assert.equal(
    sql.prepare("SELECT count(*) n FROM sqlite_master WHERE name='auth_user_security'").get().n,
    0,
  )
})
test('AUTH11-03 AUTH11-04 UAS-28/29: cutover/rollback repeat safely, never restore old proofs or other products', async (t) => {
  const { sql, db, plan } = await fixture(t),
    before = await snapshot(db)
  const a = await applyRehearsal(db, plan)
  assert.deepEqual(await applyRehearsal(db, plan), a)
  assert.equal(sql.prepare('SELECT count(*) n FROM auth_user').get().n, 3)
  assert.equal(
    sql.prepare("SELECT revoked_at FROM auth_grant WHERE client_id='synthetic-other-product'").get()
      .revoked_at,
    null,
  )
  const r = await rollbackRehearsal(db, plan)
  assert.deepEqual(await rollbackRehearsal(db, plan), r)
  assert.deepEqual(await snapshot(db), before)
  assert.equal(
    sql
      .prepare(
        "SELECT count(*) n FROM auth_grant WHERE client_id IN ('synthetic-old-work','synthetic-old-club') AND revoked_at IS NULL",
      )
      .get().n,
    0,
  )
  assert.equal(
    sql
      .prepare(
        "SELECT count(*) n FROM auth_code WHERE client_id IN ('synthetic-old-work','synthetic-old-club') AND used_at IS NULL",
      )
      .get().n,
    0,
  )
  assert.equal(
    sql
      .prepare(
        "SELECT status FROM auth_transaction WHERE json_extract(context,'$.clientId')='synthetic-other-product'",
      )
      .get().status,
    'AUTHENTICATED',
  )
  assert.equal(sql.prepare('SELECT count(*) n FROM auth_managed_tenant').get().n, 0)
  assert.equal(sql.prepare('SELECT count(*) n FROM auth_write_guard').get().n, 0)
  assert.ok(
    sql.prepare("SELECT version FROM auth_client WHERE client_id='synthetic-old-work'").get()
      .version === 2,
  )
  await assert.rejects(applyRehearsal(db, plan), /rolled back/)
})
test('AUTH11-03: stale inventory, overlapping clients and absent synthetic scope refuse without effects', async (t) => {
  const { sql, db, plan } = await fixture(t),
    before = await snapshot(db)
  await assert.rejects(
    applyRehearsal(db, { ...plan, inventoryDigest: '0'.repeat(64) }),
    /Inventory changed/,
  )
  await assert.rejects(applyRehearsal(db, { ...plan, targets: [targets[0], targets[0]] }), /pairs/)
  sql.exec('DELETE FROM account_rehearsal_marker')
  await assert.rejects(applyRehearsal(db, plan), /marker/)
  assert.deepEqual(await snapshot(db), before)
  assert.equal(sql.prepare('SELECT count(*) n FROM account_rehearsal_run').get().n, 0)
})
test('AUTH11-03: injected failure rolls back client switches and revocations as one transaction', async (t) => {
  const { sql, db, plan } = await fixture(t)
  const clients = sql.prepare('SELECT * FROM auth_client ORDER BY client_id').all(),
    grants = sql.prepare('SELECT * FROM auth_grant ORDER BY id').all()
  sql.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON account_rehearsal_run BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END",
  )
  await assert.rejects(applyRehearsal(db, plan), /injected receipt failure/)
  assert.deepEqual(sql.prepare('SELECT * FROM auth_client ORDER BY client_id').all(), clients)
  assert.deepEqual(sql.prepare('SELECT * FROM auth_grant ORDER BY id').all(), grants)
  assert.equal(sql.prepare('SELECT count(*) n FROM auth_write_guard').get().n, 0)
})
test('AUTH11-04: rollback retains newly created identities and refuses to overwrite newer configuration', async (t) => {
  const { sql, db, plan } = await fixture(t)
  await applyRehearsal(db, plan)
  sql.exec(
    "INSERT INTO auth_user VALUES ('new-phone','New user','ACTIVE',NULL,0,0);UPDATE auth_client SET version=version+1 WHERE client_id='molis-work-unified-local'",
  )
  await assert.rejects(rollbackRehearsal(db, plan), /Client changed/)
  assert.equal(sql.prepare('SELECT state FROM account_rehearsal_run').get().state, 'APPLIED')
  assert.equal(sql.prepare("SELECT count(*) n FROM auth_user WHERE id='new-phone'").get().n, 1)
})
test('AUTH11-04 UAS-30: interrupted rollback leaves the applied state intact and permits a reviewed retry', async (t) => {
  const { sql, db, plan } = await fixture(t)
  await applyRehearsal(db, plan)
  const clients = sql.prepare('SELECT * FROM auth_client ORDER BY client_id').all()
  sql.exec(
    "CREATE TRIGGER fail_rollback BEFORE UPDATE ON account_rehearsal_run BEGIN SELECT RAISE(ABORT,'injected rollback failure'); END",
  )
  await assert.rejects(rollbackRehearsal(db, plan), /injected rollback failure/)
  assert.deepEqual(sql.prepare('SELECT * FROM auth_client ORDER BY client_id').all(), clients)
  assert.equal(sql.prepare('SELECT state FROM account_rehearsal_run').get().state, 'APPLIED')
  assert.equal(sql.prepare('SELECT count(*) n FROM auth_write_guard').get().n, 0)
  sql.exec('DROP TRIGGER fail_rollback')
  assert.equal((await rollbackRehearsal(db, plan)).state, 'ROLLED_BACK')
})
test('AUTH11-03: rehearsal refuses live delivery and non-loopback environments without switching clients', async (t) => {
  const { sql, db, plan } = await fixture(t)
  const clients = sql.prepare('SELECT * FROM auth_client ORDER BY client_id').all()
  sql.exec("UPDATE auth_environment SET delivery_mode='LIVE' WHERE id='unified-local'")
  await assert.rejects(applyRehearsal(db, plan), /LOCAL mock/)
  sql.exec(
    "UPDATE auth_environment SET delivery_mode='MOCK',auth_origin='https://auth.example.test' WHERE id='unified-local'",
  )
  await assert.rejects(applyRehearsal(db, plan), /loopback/)
  assert.deepEqual(sql.prepare('SELECT * FROM auth_client ORDER BY client_id').all(), clients)
  assert.equal(sql.prepare('SELECT count(*) n FROM account_rehearsal_run').get().n, 0)
})
test('AUTH11-05: CLI only mutates its own newly generated synthetic directory and reads copies without writes', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'auth11-cli-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const dir = join(parent, 'generated')
  const result = await run(['rehearse', dir])
  assert.equal(result.productionDataAccessed, false)
  assert.equal(result.backupRestorationVerified, true)
  const original = JSON.parse(readFileSync(join(dir, 'inventory-before.json'), 'utf8'))
  assert.equal(
    (await run(['inventory', 'AUTH', join(dir, 'synthetic-auth-restored-offline.sqlite')]))
      .sourceDigest,
    original.sourceDigest,
  )
  const file = join(dir, 'synthetic-auth.sqlite'),
    before = digest(readFileSync(file))
  const report = await run(['inventory', 'AUTH', file])
  assert.equal(report.users.length, 3)
  assert.equal(digest(readFileSync(file)), before)
  await assert.rejects(run(['rehearse', dir]))
  await assert.rejects(run(['apply', 'AUTH', file]))
  await assert.rejects(run(['inventory', 'AUTH', file, '--remote']))
  assert.equal(
    JSON.parse(readFileSync(join(dir, 'rehearsal-report.json'), 'utf8')).oldTokensRemainRevoked,
    true,
  )
})
