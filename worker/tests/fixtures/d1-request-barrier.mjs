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
  'session-read-after': ['first', 'SELECT revision,status,busy_until,payload', 'after'],
  'account-read-after': ['batch', 'credential_session', 'after'],
  'cursor-write': ['batch', "INSERT INTO auth_one_use VALUES (?,'V2_TENANT_CURSOR'"],
  'managed-list-before': ['batch', 'WITH actor AS (SELECT'],
  'managed-list-after': ['batch', 'WITH actor AS (SELECT', 'after'],
  'first-phone-binding': ['first', 'FROM auth_user_phone p JOIN auth_user u', 'after'],
}

class D1Database {
  constructor(db, pause, transform = (sql) => sql) {
    this.db = db
    this.pause = pause
    this.transform = transform
  }

  prepare(sql, statement = this.db.prepare(this.transform(sql))) {
    return {
      sql,
      statement,
      bind: (...args) => this.prepare(sql, statement.bind(...args)),
      first: async (...args) => {
        await this.pause('first', [sql])
        const result = await statement.first(...args)
        await this.pause('first', [sql], 'after')
        return result
      },
      all: async (...args) => {
        await this.pause('all', [sql])
        return statement.all(...args)
      },
      run: async (...args) => {
        await this.pause('run', [sql])
        return statement.run(...args)
      },
    }
  }

  async batch(statements) {
    const queries = statements.map((entry) => entry.sql)
    await this.pause('batch', queries)
    const result = await this.db.batch(statements.map((entry) => entry.statement))
    await this.pause('batch', queries, 'after')
    return result
  }
}

export default {
  scheduled(event, env, ctx) {
    return worker.prototype.scheduled.call({ env, ctx }, event)
  },

  async fetch(request, env, ctx) {
    const tag = request.headers.get('X-Fixture-Barrier')
    if (!tag) return worker.prototype.fetch.call({ env, ctx }, request)
    if (tag === 'web-session-missing-config') {
      const { UNIFIED_ACCOUNT_CONFIG, ...bindings } = env
      return worker.prototype.fetch.call({ env: bindings, ctx }, request)
    }
    if (['managed-list-trace', 'managed-list-poison', 'managed-list-broken', 'web-session-trace'].includes(tag)) {
      const counts = { read: 0, write: 0 }
      let protectedQueries = 0
      const isProtected = (sql) => sql.startsWith('WITH actor AS (SELECT')
      const DB = new D1Database(
        env.DB,
        (_operation, statements, moment = 'before') => {
          if (moment === 'before') {
            const isRead = statements.every((sql) => /^(SELECT|WITH)\b/i.test(sql))
            counts[isRead ? 'read' : 'write']++
            protectedQueries += statements.filter(isProtected).length
          }
        },
        (sql) => {
          if (!isProtected(sql)) return sql
          if (tag === 'managed-list-poison')
            return sql.replace(
              ') SELECT * FROM (',
              ") SELECT *, json('invalid') AS fixture_poison FROM (",
            )
          if (tag === 'managed-list-broken')
            return sql.replace(') SELECT * FROM (', ') SELECT * FROM fixture_missing_table JOIN (')
          return sql
        },
      )
      const response = await worker.prototype.fetch.call({ env: { ...env, DB }, ctx }, request)
      response.headers.set('X-Fixture-D1-Calls', JSON.stringify(counts))
      response.headers.set('X-Fixture-Protected-Queries', String(protectedQueries))
      return response
    }
    const [point] = tag.split('/')
    const [phase, fragment, timing = 'before'] = points[point]
    let paused = false
    const DB = new D1Database(env.DB, async (operation, statements, moment = 'before') => {
      if (
        paused ||
        operation !== phase ||
        moment !== timing ||
        !statements.some((sql) => sql.includes(fragment))
      ) {
        return
      }
      paused = true
      const response = await fetch('https://lease-fixture.invalid/' + tag)
      if (!response.ok) throw new Error('Test barrier failed: ' + tag)
    })
    return worker.prototype.fetch.call({ env: { ...env, DB }, ctx }, request)
  },
}
