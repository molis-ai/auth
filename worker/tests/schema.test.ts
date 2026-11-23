import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { verifyDeploymentDatabase } from '../scripts/deployment-readiness.mjs'

const busyLeaseMigration = '0019_web_session_busy_lease.sql'
const migrationDirectory = new URL('../migrations/', import.meta.url)

function database(through?: string) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const name of readdirSync(migrationDirectory)
    .filter((n) => n.endsWith('.sql') && (!through || n <= through))
    .sort())
    db.exec(readFileSync(new URL(name, migrationDirectory), 'utf8'))
  return db
}

test('0019 preserves existing READY and BUSY sessions and enables the lease readiness probe', () => {
  const db = database('0018_management_handoff.sql')
  try {
    db.exec(`INSERT INTO auth_web_session(id_hash,payload,revision,status,expires_at) VALUES
      ('ready','sealed-ready',7,'READY',1795417800000),
      ('busy','sealed-busy',11,'BUSY',1795417900000)`)
    const rows = () => db.prepare('SELECT * FROM auth_web_session ORDER BY id_hash').all()
    const before = rows()
    const readiness = 'SELECT payload,revision,busy_until FROM auth_web_session LIMIT 0'
    assert.throws(() => db.prepare(readiness), /no such column: busy_until/)
    db.exec(readFileSync(new URL(busyLeaseMigration, migrationDirectory), 'utf8'))
    assert.deepEqual(db.prepare(readiness).all(), [])
    assert.deepEqual(
      rows().map((row) => ({ ...row })),
      before.map((row) => ({ ...row, busy_until: 0 })),
    )
  } finally {
    db.close()
  }
})

test('V2C-02 current tenant schema enforces ownership, membership, foreign keys and rollback', () => {
  const db = database()
  try {
    db.exec(
      "INSERT INTO auth_user VALUES ('u','User','ACTIVE',NULL,0,0),('v','Other','ACTIVE',NULL,0,0)",
    )
    db.exec(
      "INSERT INTO auth_space(id,name,space_type,status,created_at,updated_at) VALUES ('s','Team','TEAM','ACTIVE',0,0)",
    )
    db.exec(
      "INSERT INTO auth_managed_tenant(space_id,status,managed_by,managed_at,updated_at) VALUES ('s','ACTIVE','u',0,0)",
    )
    const member = (id: string, user: string) =>
      db
        .prepare(
          "INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at) VALUES (?,'s',?,'OWNER','ACTIVE',0)",
        )
        .run(id, user)
    member('owner', 'u')
    assert.throws(() => member('second-owner', 'v'), /UNIQUE constraint/)
    assert.throws(
      () =>
        db.exec(
          "INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at) VALUES ('missing','s','missing','MEMBER','ACTIVE',0)",
        ),
      /FOREIGN KEY constraint/,
    )
    db.exec("INSERT INTO auth_user_email VALUES ('e','u','test@example.com',NULL,0)")
    assert.throws(() =>
      db.exec("INSERT INTO auth_user_email VALUES ('f','v','test@example.com',NULL,0)"),
    )
    db.exec('BEGIN')
    try {
      db.exec("INSERT INTO auth_user VALUES ('rollback','Temporary','ACTIVE',NULL,0,0)")
      db.exec("INSERT INTO auth_user_email VALUES ('g','rollback','test@example.com',NULL,0)")
      assert.fail('Expected duplicate email')
    } catch {
      db.exec('ROLLBACK')
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM auth_user WHERE id='rollback'").get()!.n, 0)
  } finally {
    db.close()
  }
})

test('V2C-02 a fresh database has no retired V1 token, member, invitation or service storage', () => {
  const db = database()
  try {
    for (const table of [
      'auth_authentication',
      'auth_transaction',
      'auth_code',
      'auth_grant',
      'auth_access_token',
      'auth_refresh_token',
      'auth_membership',
      'auth_invitation',
      'auth_service',
      'auth_service_token',
    ])
      assert.throws(() => db.prepare(`SELECT 1 FROM ${table}`), /no such table/, table)
    const columns = db
      .prepare('PRAGMA table_info(auth_application)')
      .all()
      .map((r) => r.name)
    assert.ok(!columns.includes('actions') && !columns.includes('grants'))
    for (const table of [
      'auth_login_session',
      'auth_login_access_token',
      'auth_login_refresh_token',
      'auth_product_transaction',
      'auth_identity_proof',
      'auth_tenant_membership',
      'auth_one_use',
      'auth_audit_event',
      'auth_web_session',
    ])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0, table)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})

test('deployment preflight requires every migration record and the deployed schema probes', () => {
  const db = database()
  const vars = {
    AUTH_WEB_CLIENT_ID: 'deploy-web',
    UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
      environmentId: 'deploy-environment',
      authOrigin: 'https://auth.example.test',
      kind: 'TEST',
    }),
  }
  const execute = (sql: string) =>
    JSON.stringify(
      sql
        .split(';')
        .filter((s) => s.trim())
        .map((statement) => ({
          success: true,
          results: db.prepare(statement).all(),
        })),
    )
  try {
    db.exec(`
      CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
      INSERT INTO auth_environment(id,kind,auth_origin,delivery_mode,provider_mode,created_at,updated_at)
        VALUES ('deploy-environment','TEST','https://auth.example.test','LIVE','LIVE',0,0);
      INSERT INTO auth_application(id,name) VALUES ('deploy-app','Auth');
      INSERT INTO auth_client(id,client_id,application_id,client_type,scopes,redirects)
        VALUES ('deploy-web','deploy-web','deploy-app','WEB','["account","profile"]','["https://auth.example.test/account/callback"]');
      INSERT INTO auth_client_policy(client_id,policy_profile,environment_id,allowed_origins,created_at,updated_at)
        VALUES ('deploy-web','unified-account-v2','deploy-environment','["https://auth.example.test"]',0,0);
    `)
    const files = readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql'))
    const apply = db.prepare('INSERT INTO d1_migrations(name) VALUES (?)')
    for (const file of files) apply.run(file)
    const verify = () => verifyDeploymentDatabase(execute, vars, migrationDirectory)
    for (const file of files) {
      db.prepare('DELETE FROM d1_migrations WHERE name=?').run(file)
      assert.throws(verify, { message: 'Unapplied Auth D1 migrations: ' + file })
      apply.run(file)
    }
    assert.doesNotThrow(verify)
    db.exec("UPDATE auth_client SET status='DISABLED' WHERE client_id='deploy-web'")
    assert.throws(verify, /registration is not ready/)
    db.exec("UPDATE auth_client SET status='ACTIVE' WHERE client_id='deploy-web'")
    assert.doesNotThrow(verify)
    db.exec('DROP INDEX ix_logout_receipt_proof_expiry')
    assert.throws(verify, /schema or browser client registration is not ready/)
  } finally {
    db.close()
  }
})
