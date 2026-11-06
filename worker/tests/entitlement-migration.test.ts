import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'

test('AUTH-10/UAS-28/30: explicit product registry preserves clients and seeds without inference or overwrite', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    const dir = new URL('../migrations/', import.meta.url)
    for (const name of readdirSync(dir)
      .filter((n) => n.endsWith('.sql') && n < '0011')
      .sort())
      db.exec(readFileSync(new URL(name, dir), 'utf8'))
    db.exec(`INSERT INTO auth_application(id,name) VALUES ('app','Existing Work named app');
      INSERT INTO auth_client(id,client_id,application_id,client_type,scopes,redirects) VALUES ('client','molis-work-production','app','WEB','["account"]','["https://example.test/cb"]');`)
    const before = db.prepare('SELECT * FROM auth_client').all()
    db.exec(readFileSync(new URL('0011_entitlement_client_product.sql', dir), 'utf8'))
    assert.deepEqual(db.prepare('SELECT * FROM auth_client').all(), before)
    assert.equal(db.prepare('SELECT count(*) n FROM auth_client_product').get().n, 0)
    const seed = readFileSync(new URL('../unified-account-local-seed.sql', import.meta.url), 'utf8')
    db.exec(seed)
    db.exec(seed)
    assert.deepEqual(
      db
        .prepare('SELECT product FROM auth_client_product ORDER BY product')
        .all()
        .map((r) => r.product),
      ['CLUB', 'WORK'],
    )
    db.exec(
      "UPDATE auth_client_product SET product='CLUB',version=2 WHERE client_id='molis-work-unified-local'",
    )
    db.exec(seed)
    const row = db
      .prepare("SELECT * FROM auth_client_product WHERE client_id='molis-work-unified-local'")
      .get()
    assert.equal(row.product, 'CLUB')
    assert.equal(row.version, 2)
    assert.equal(
      db.prepare("SELECT * FROM auth_client_product WHERE client_id='molis-work-production'").get(),
      undefined,
    )
    assert.throws(() => db.exec("UPDATE auth_client_product SET product='SHARED'"))
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})
