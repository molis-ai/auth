import worker from './index.js'

// Catalog JSON is computed by the production query and audit JSON is constrained
// by SQLite. Inject the fixture column after the real read, keeping those rules.
class D1Database {
  constructor(db) {
    this.db = db
  }

  prepare(sql) {
    const statement = this.db.prepare(sql)
    const column = sql.startsWith('SELECT * FROM (SELECT p.*,json_array(')
      ? 'definition'
      : sql.startsWith("SELECT * FROM (SELECT *, 'immutable' stamp FROM auth_management_audit")
        ? 'change_summary'
        : undefined
    if (!column) return statement
    const db = this.db
    return {
      bind(...values) {
        const bound = statement.bind(...values)
        return {
          async all() {
            const result = await bound.all()
            const fixture = await db
              .prepare('SELECT raw FROM fixture_stored_json WHERE field=?')
              .bind(column)
              .first()
            if (!fixture) return result
            return {
              ...result,
              results: result.results.map((row) => ({ ...row, [column]: fixture.raw })),
            }
          },
        }
      },
    }
  }

  batch(statements) {
    return this.db.batch(statements)
  }
}

export default {
  fetch(request, env, ctx) {
    const DB = new D1Database(env.DB)
    return worker.prototype.fetch.call({ env: { ...env, DB }, ctx }, request)
  },
}
