import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { EphemeralStore } from '../src/infrastructure/ephemeral-store.ts'

test('one-use receipt validates purpose/binding/expiry and cannot be replayed', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(
      readFileSync(new URL('../migrations/0002_ephemeral_primitives.sql', import.meta.url), 'utf8'),
    )
    const adapter = {
      prepare(sql: string) {
        return {
          bind(...args: (string | number)[]) {
            return {
              async run() {
                return db.prepare(sql).run(...args)
              },
              async first() {
                return db.prepare(sql).get(...args) ?? null
              },
            }
          },
        }
      },
    } as unknown as D1Database
    const store = new EphemeralStore(adapter)
    const token = 'a'.repeat(64),
      binding = 'b'.repeat(64)
    await store.issue(token, 'LOGIN', binding, { id: 'synthetic' }, 100)
    assert.equal(await store.consume(token, 'OTHER', binding, 1), null)
    assert.equal(await store.consume(token, 'LOGIN', 'c'.repeat(64), 1), null)
    assert.deepEqual(await store.consume(token, 'LOGIN', binding, 99), { id: 'synthetic' })
    assert.equal(await store.consume(token, 'LOGIN', binding, 99), null)
    await store.issue(token, 'LOGIN', binding, {}, 100)
    assert.equal(await store.consume(token, 'LOGIN', binding, 100), null)
    await assert.rejects(store.issue(token, 'LOGIN', binding, {}, 200))
    await assert.rejects(store.issue('raw-token', 'LOGIN', binding, {}, 200))
    assert.equal(await store.allow(binding, 2, 10, 100), true)
    assert.equal(await store.allow(binding, 2, 10, 101), true)
    assert.equal(await store.allow(binding, 2, 10, 102), false)
    assert.equal(await store.allow(binding, 2, 10, 110), true)
  } finally {
    db.close()
  }
})
