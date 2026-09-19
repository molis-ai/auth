import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

test('D1-compatible schema enforces ownership, membership, foreign keys and rollback', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    db.exec(
      readFileSync(new URL('../migrations/0001_identity_and_spaces.sql', import.meta.url), 'utf8'),
    )
    db.exec(
      "INSERT INTO auth_user VALUES ('u','User','ACTIVE',NULL,0,0),('v','Other','ACTIVE',NULL,0,0)",
    )
    db.exec(
      "INSERT INTO auth_space(id,name,space_type,status,created_at,updated_at) VALUES ('s','Team','TEAM','ACTIVE',0,0)",
    )
    db.exec("INSERT INTO auth_membership VALUES ('s','u','OWNER',0)")
    assert.throws(() => db.exec("INSERT INTO auth_membership VALUES ('s','v','OWNER',0)"))
    assert.throws(() => db.exec("INSERT INTO auth_membership VALUES ('s','missing','MEMBER',0)"))
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
