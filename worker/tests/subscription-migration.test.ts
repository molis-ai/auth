import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'

test('AUTH-08/UAS-28/30: additive lifecycle migration preserves subscriptions and snapshots old seat labels', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    const dir = new URL('../migrations/', import.meta.url)
    for (const name of readdirSync(dir)
      .filter((n) => n.endsWith('.sql') && n < '0010')
      .sort())
      db.exec(readFileSync(new URL(name, dir), 'utf8'))
    db.exec(`INSERT INTO auth_user VALUES ('u','Preserved','ACTIVE',NULL,0,0);
      INSERT INTO billing_feature VALUES ('demo.shared','SHARED','Demo preserved feature',0);
      INSERT INTO billing_seat_type VALUES ('demo.standard','Preserved seat name',0);
      INSERT INTO billing_plan_version VALUES ('demo.plan',1,'Preserved plan','u',0);
      INSERT INTO billing_plan_personal_feature VALUES ('demo.plan',1,'demo.shared');
      INSERT INTO billing_plan_seat_type VALUES ('demo.plan',1,'demo.standard');
      INSERT INTO billing_plan_seat_feature VALUES ('demo.plan',1,'demo.standard','demo.shared');
      INSERT INTO billing_subscription(id,owner_user_id,plan_id,plan_version,enabled,starts_at,ends_at,created_at,updated_at) VALUES ('old-sub','u','demo.plan',1,1,0,1000,0,0);`)
    const tables = [
      'auth_user',
      'billing_feature',
      'billing_seat_type',
      'billing_plan_version',
      'billing_plan_personal_feature',
      'billing_plan_seat_feature',
      'billing_subscription',
    ]
    const before = tables.map((t) => db.prepare('SELECT * FROM ' + t).all())
    db.exec(readFileSync(new URL('0010_subscription_lifecycle.sql', dir), 'utf8'))
    assert.deepEqual(
      tables.map((t) => db.prepare('SELECT * FROM ' + t).all()),
      before,
    )
    assert.equal(
      db.prepare('SELECT name FROM billing_plan_seat_type').get().name,
      'Preserved seat name',
    )
    assert.equal(db.prepare('SELECT count(*) n FROM billing_user_revision').get().n, 0)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})
