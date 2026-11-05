import { createHash } from 'node:crypto'
export const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value
export const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
export const requireValue = (value, message) => {
  if (!value) throw Error(message)
}
export const all = async (db, sql, ...values) =>
  (
    await db
      .prepare(sql)
      .bind(...values)
      .all()
  ).results
export const one = (db, sql, ...values) =>
  db
    .prepare(sql)
    .bind(...values)
    .first()
export const statement = (db, sql, ...values) => db.prepare(sql).bind(...values)
export function sqlitePort(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async all() {
              return { results: sqlite.prepare(sql).all(...values) }
            },
            async first() {
              return sqlite.prepare(sql).get(...values) ?? null
            },
            async run() {
              return sqlite.prepare(sql).run(...values)
            },
          }
        },
      }
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const result = []
        for (const s of statements) result.push(await s.run())
        sqlite.exec('COMMIT')
        return result
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
}
