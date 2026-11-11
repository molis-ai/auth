import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'

function database() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const directory = new URL('../migrations/', import.meta.url)
  for (const name of readdirSync(directory)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(name, directory), 'utf8'))
  return db
}

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
