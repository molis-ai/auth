import { Failure } from '../shared/http.ts'
export type Value = string | number | null
export class Store {
  readonly db: D1Database
  authorizationGuard?: () => D1PreparedStatement
  constructor(db: D1Database) {
    this.db = db
  }
  statement(sql: string, ...values: Value[]) {
    return this.db.prepare(sql).bind(...values)
  }
  one<T>(sql: string, ...values: Value[]): Promise<T | null> {
    return this.statement(sql, ...values).first<T>()
  }
  async all<T>(sql: string, ...values: Value[]): Promise<T[]> {
    return (await this.statement(sql, ...values).all<T>()).results
  }
  async run(sql: string, ...values: Value[]) {
    return this.statement(sql, ...values).run()
  }
  guard(condition: string, values: Value[] = []) {
    return this.statement(
      `INSERT INTO auth_write_guard(id,ok) VALUES (?,CASE WHEN (${condition}) THEN 1 ELSE 0 END)`,
      crypto.randomUUID(),
      ...values,
    )
  }
  async batch(statements: D1PreparedStatement[], conflict = 'VERSION_CONFLICT') {
    try {
      return await this.db.batch([
        ...(this.authorizationGuard ? [this.authorizationGuard()] : []),
        ...statements,
        this.statement('DELETE FROM auth_write_guard'),
      ])
    } catch (e) {
      if (String(e).includes('CHECK constraint failed')) throw new Failure(409, conflict)
      if (String(e).includes('UNIQUE constraint failed')) throw new Failure(409, 'ALREADY_EXISTS')
      throw e
    }
  }
  audit(
    action: string,
    actor: string | null,
    requestId: string,
    options: {
      target?: string
      space?: string
      app?: string
      summary?: string
      denied?: boolean
    } = {},
  ) {
    return this.statement(
      'INSERT INTO auth_audit_event(id,action,outcome,actor_user_id,target_user_id,space_id,application_id,request_id,occurred_at,change_summary) VALUES (?,?,?,?,?,?,?,?,?,?)',
      crypto.randomUUID(),
      action,
      options.denied ? 'DENIED' : 'SUCCESS',
      actor,
      options.target ?? actor,
      options.space ?? null,
      options.app ?? null,
      requestId,
      Date.now(),
      options.summary ?? null,
    )
  }
}
