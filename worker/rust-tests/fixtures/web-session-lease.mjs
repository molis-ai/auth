import worker, { PasswordKdf } from './index.js'

export { PasswordKdf }

const points = {
  claim: ['first', 'SET revision=revision+1,status='],
  finish: ['first', "SET payload=?,status='READY',busy_until=0"],
  cleanup: ['first', "SET status='READY',busy_until=0"],
  save: ['batch', 'UPDATE auth_web_session SET payload=? WHERE id_hash=?'],
  business: ['batch', 'UPDATE auth_user SET display_name='],
  'refresh-used': ['first', 'SELECT * FROM auth_login_refresh_token WHERE token_hash='],
  'refresh-race': ['batch', 'UPDATE auth_login_refresh_token SET used_at='],
  promote: ['batch', 'INSERT INTO auth_web_session(id_hash,payload,status,expires_at)'],
}

class D1Database {
  constructor(db, pause) {
    this.db = db
    this.pause = pause
  }

  prepare(sql, statement = this.db.prepare(sql)) {
    return {
      sql,
      statement,
      bind: (...args) => this.prepare(sql, statement.bind(...args)),
      first: async (...args) => {
        await this.pause('first', [sql])
        return statement.first(...args)
      },
      all: (...args) => statement.all(...args),
      run: (...args) => statement.run(...args),
    }
  }

  async batch(statements) {
    await this.pause(
      'batch',
      statements.map((entry) => entry.sql),
    )
    return this.db.batch(statements.map((entry) => entry.statement))
  }
}

export default {
  fetch(request, env, ctx) {
    const tag = request.headers.get('X-Fixture-Barrier')
    if (!tag) return worker.prototype.fetch.call({ env, ctx }, request)
    const [point] = tag.split('/')
    const [phase, fragment] = points[point]
    let paused = false
    const DB = new D1Database(env.DB, async (operation, statements) => {
      if (paused || operation !== phase || !statements.some((sql) => sql.includes(fragment))) return
      paused = true
      const response = await fetch('https://lease-fixture.invalid/' + tag)
      if (!response.ok) throw new Error('Test barrier failed: ' + tag)
    })
    return worker.prototype.fetch.call({ env: { ...env, DB }, ctx }, request)
  },
}
