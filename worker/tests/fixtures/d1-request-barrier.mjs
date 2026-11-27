import worker, { PasswordKdf } from './index.js'

export { PasswordKdf }

const points = {
  claim: ['first', 'SET revision=revision+1,status='],
  finish: ['first', "SET payload=?,status='READY',busy_until=0"],
  cleanup: ['first', "SET status='READY',busy_until=0"],
  save: ['batch', 'UPDATE auth_web_session SET payload=? WHERE id_hash=?'],
  business: ['batch', 'UPDATE auth_user SET display_name='],
  'refresh-used': ['first', 'FROM auth_login_refresh_token t JOIN auth_login_session s'],
  'refresh-race': ['batch', 'UPDATE auth_login_refresh_token SET used_at='],
  promote: ['batch', 'INSERT INTO auth_web_session(id_hash,payload,status,expires_at)'],
  'session-read-after': ['first', 'SELECT revision,status,busy_until,payload', 'after'],
  'account-read-after': ['batch', 'credential_session', 'after'],
  'activity-credential-after': ['first', 'credential_session', 'after'],
  'managed-list-before': ['batch', 'WITH actor AS (SELECT'],
  'managed-list-after': ['batch', 'WITH actor AS (SELECT', 'after'],
  'first-phone-binding': ['first', 'FROM auth_user_phone p JOIN auth_user u', 'after'],
}

class D1Database {
  constructor(db, pause, transform = (sql) => sql, plans) {
    this.db = db
    this.pause = pause
    this.transform = transform
    this.plans = plans
  }

  prepare(sql, statement = this.db.prepare(this.transform(sql)), values = []) {
    return {
      sql,
      statement,
      values,
      bind: (...args) => this.prepare(sql, statement.bind(...args), args),
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
    if (this.plans) {
      for (const { sql, values } of statements) {
        if (
          sql.startsWith('WITH actor AS (SELECT') &&
          sql.includes('LIMIT CASE WHEN EXISTS(SELECT 1 FROM actor)') &&
          sql.endsWith('THEN ? ELSE 0 END')
        ) {
          const plan = await this.db
            .prepare('EXPLAIN QUERY PLAN ' + sql)
            .bind(...values)
            .all()
          this.plans.push(plan.results.map((row) => row.detail))
        }
      }
    }
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
    const traceTag = [
      'managed-list-trace',
      'managed-list-explain',
      'managed-list-poison',
      'managed-list-broken',
      'web-session-trace',
      'd1-trace',
    ].includes(tag)
    const trace = traceTag || request.headers.get('X-Fixture-D1-Trace') === '1'
    const counts = { read: 0, write: 0 }
    const plans = tag === 'managed-list-explain' ? [] : undefined
    let protectedQueries = 0
    const isProtected = (sql) => sql.startsWith('WITH actor AS (SELECT')
    const count = (statements, moment) => {
      if (!trace || moment !== 'before') return
      const isRead = statements.every((sql) => /^(SELECT|WITH)\b/i.test(sql.trimStart()))
      counts[isRead ? 'read' : 'write']++
      protectedQueries += statements.filter(isProtected).length
    }
    const respond = async (DB) => {
      const response = await worker.prototype.fetch.call({ env: { ...env, DB }, ctx }, request)
      if (trace) {
        response.headers.set('X-Fixture-D1-Calls', JSON.stringify(counts))
        response.headers.set('X-Fixture-Protected-Queries', String(protectedQueries))
      }
      if (plans) response.headers.set('X-Fixture-Query-Plans', JSON.stringify(plans))
      return response
    }
    if (traceTag) {
      const DB = new D1Database(
        env.DB,
        (_operation, statements, moment = 'before') => count(statements, moment),
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
        plans,
      )
      return respond(DB)
    }
    const [point] = tag.split('/')
    const [phase, fragment, timing = 'before'] = points[point]
    let paused = false
    const DB = new D1Database(env.DB, async (operation, statements, moment = 'before') => {
      count(statements, moment)
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
    return respond(DB)
  },
}
