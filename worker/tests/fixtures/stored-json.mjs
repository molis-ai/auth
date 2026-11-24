import worker from './index.js'

// Catalog JSON is computed by the production query and audit JSON is constrained
// by SQLite. Inject the fixture column after the real read, keeping those rules.
class D1Database {
  constructor(db) {
    this.db = db
  }

  prepare(sql, statement = this.db.prepare(sql)) {
    return {
      sql,
      statement,
      bind: (...values) => this.prepare(sql, statement.bind(...values)),
      all: (...args) => statement.all(...args),
      first: (...args) => statement.first(...args),
      run: (...args) => statement.run(...args),
    }
  }

  async batch(statements) {
    const results = await this.db.batch(statements.map(({ statement }) => statement))
    return Promise.all(
      results.map(async (result, index) => {
        const { sql } = statements[index]
        const column = sql.includes('FROM (SELECT p.*,json_array(')
          ? 'definition'
          : sql.includes('FROM (SELECT * FROM auth_management_audit')
            ? 'change_summary'
            : undefined
        if (!column) return result
        const fixture = await this.db
          .prepare('SELECT raw FROM fixture_stored_json WHERE field=?')
          .bind(column)
          .first()
        if (!fixture) return result
        return {
          ...result,
          results: result.results.map((row) => ({ ...row, [column]: fixture.raw })),
        }
      }),
    )
  }
}

export default {
  fetch(request, env, ctx) {
    const DB = new D1Database(env.DB)
    return worker.prototype.fetch.call({ env: { ...env, DB }, ctx }, request)
  },
}
