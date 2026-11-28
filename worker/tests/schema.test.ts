import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { verifyDeploymentDatabase } from '../scripts/deployment-readiness.mjs'

const migrationDirectory = new URL('../migrations/', import.meta.url)
const migrations = ['0001_auth_baseline.sql', '0002_auth_security_sequence_indexes.sql']

function database() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const migration of migrations)
    db.exec(readFileSync(new URL(migration, migrationDirectory), 'utf8'))
  return db
}

test('fresh Auth migrations create the expected indexes and drop unused storage', () => {
  assert.deepEqual(readdirSync(migrationDirectory).sort(), migrations)
  const db = database()
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'billing_*'").all(),
      [],
    )
    const indexes = {
      ix_login_session_created_sequence: ['created_seq'],
      ix_user_revoked_sequence: ['revoked_before_seq'],
      ix_ownership_transfer_from: ['from_membership_id', 'id'],
      ix_ownership_transfer_to: ['to_membership_id', 'id'],
      ix_tenant_membership_tenant_status_id: ['tenant_id', 'status', 'id'],
      ix_client_application_id: ['application_id', 'id'],
      ix_management_audit_time: ['occurred_at', 'id'],
      ix_managed_tenant_time: ['managed_at', 'id'],
      ix_user_email_verified_order: ['user_id', 'created_at', 'id'],
      ix_managed_tenant_status_time: ['status', 'managed_at', 'id'],
      ix_management_audit_outcome_time: ['outcome', 'occurred_at', 'id'],
      ix_management_audit_operation_time: ['operation', 'occurred_at', 'id'],
      ix_platform_permission_status_user: ['permission', 'status', 'user_id'],
      ix_management_audit_target_time: ['target_id', 'occurred_at', 'id'],
      ix_user_status_id: ['status', 'id'],
      ix_tenant_membership_tenant_user_version: ['tenant_id', 'user_id', 'version'],
      ix_tenant_invitation_tenant_id: ['tenant_id', 'id'],
    }
    for (const [index, columns] of Object.entries(indexes)) {
      assert.deepEqual(
        db
          .prepare(`PRAGMA index_info(${index})`)
          .all()
          .map((row) => row.name),
        columns,
      )
    }
    assert.deepEqual(db.prepare('PRAGMA index_info(ix_management_audit_tenant_id)').all(), [])
    for (const [table, column] of [
      ['auth_verification_challenge', 'next_send_at'],
      ['auth_management_result', 'response_status'],
      ['auth_logout_receipt', 'revoked_seq'],
      ['auth_login_activity', 'received_at'],
    ]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all()
      assert.ok(columns.length > 0)
      assert.ok(columns.every((entry) => entry.name !== column))
    }
  } finally {
    db.close()
  }
})

test('AUTH-C-02 current tenant schema enforces ownership, membership, foreign keys and rollback', () => {
  const db = database()
  try {
    db.exec(
      "INSERT INTO auth_user(id,display_name,status,avatar_data,created_at,updated_at) VALUES ('u','User','ACTIVE',NULL,0,0),('v','Other','ACTIVE',NULL,0,0)",
    )
    db.exec(
      "INSERT INTO auth_tenant(id,name,created_at,status,managed_by,managed_at,updated_at) VALUES ('s','Team',0,'ACTIVE','u',0,0)",
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
      db.exec(
        "INSERT INTO auth_user(id,display_name,status,avatar_data,created_at,updated_at) VALUES ('rollback','Temporary','ACTIVE',NULL,0,0)",
      )
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

test('AUTH-C-02 a fresh database has no retired V1 token, member, invitation or service storage', () => {
  const db = database()
  try {
    for (const table of [
      'auth_audit_event',
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
      'auth_web_session',
    ])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0, table)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})

test('security sequence insertion checks user and session foreign keys by index', () => {
  const db = database()
  try {
    const sql =
      "INSERT INTO auth_security_sequence(kind,created_at) SELECT 'REVOCATION',? WHERE EXISTS(SELECT 1 FROM auth_user WHERE id=?)"
    const plan = db
      .prepare('EXPLAIN QUERY PLAN ' + sql)
      .all(1, 'fixture')
      .map((row) => row.detail)
      .join('\n')
    assert.doesNotMatch(plan, /SCAN (auth_login_session|auth_user)\b/u)
    assert.match(plan, /ix_login_session_created_sequence/u)
    assert.match(plan, /ix_user_revoked_sequence/u)
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
      INSERT INTO auth_client(id,client_id,application_id,client_type,redirects,environment_id,allowed_origins)
        VALUES ('deploy-web','deploy-web','deploy-app','WEB','["https://auth.example.test/account/callback"]',
          'deploy-environment','["https://auth.example.test"]');
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
