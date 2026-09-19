// Internal infrastructure, not exposed as public token minting/consumption APIs.
// A caller must hash bearer tokens and bind them to client, PKCE/origin/transaction as appropriate.
// Do not consume a receipt and subsequently assume a separate business write is atomic with it.
function digest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('INVALID_DIGEST')
  return value
}
function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_TIMESTAMP')
  return value
}

export class EphemeralStore {
  private readonly db: D1Database
  constructor(db: D1Database) {
    this.db = db
  }

  async prune(now: number): Promise<void> {
    // Bounded cleanup; scheduling and quota sizing are required before enabling public callers.
    await this.db.batch([
      this.db
        .prepare(
          'DELETE FROM auth_one_use WHERE token_hash IN (SELECT token_hash FROM auth_one_use WHERE expires_at<=? LIMIT 100)',
        )
        .bind(timestamp(now)),
      this.db
        .prepare(
          'DELETE FROM auth_rate_bucket WHERE bucket_hash IN (SELECT bucket_hash FROM auth_rate_bucket WHERE expires_at<=? LIMIT 100)',
        )
        .bind(now),
    ])
  }

  async issue(
    tokenHash: string,
    purpose: string,
    bindingHash: string,
    payload: unknown,
    expiresAt: number,
  ): Promise<void> {
    if (!/^[A-Z_]{1,40}$/.test(purpose)) throw new Error('INVALID_PURPOSE')
    const data = JSON.stringify(payload)
    if (!data || data.length > 8192) throw new Error('INVALID_PAYLOAD')
    await this.db
      .prepare(
        'INSERT INTO auth_one_use(token_hash,purpose,binding_hash,payload,expires_at) VALUES (?,?,?,?,?)',
      )
      .bind(digest(tokenHash), purpose, digest(bindingHash), data, timestamp(expiresAt))
      .run()
  }

  async consume(
    tokenHash: string,
    purpose: string,
    bindingHash: string,
    now: number,
  ): Promise<unknown | null> {
    // DELETE ... RETURNING combines validation and consumption in one atomic statement.
    const row = await this.db
      .prepare(
        'DELETE FROM auth_one_use WHERE token_hash=? AND purpose=? AND binding_hash=? AND expires_at>? RETURNING payload',
      )
      .bind(digest(tokenHash), purpose, digest(bindingHash), timestamp(now))
      .first<{ payload: string }>()
    return row ? JSON.parse(row.payload) : null
  }

  async allow(bucketHash: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(windowMs) ||
      windowMs < 1
    )
      throw new Error('INVALID_RATE_POLICY')
    timestamp(now)
    const expiresAt = timestamp(now + windowMs)
    // Never read then write: concurrent requests must not all observe the same remaining slot.
    const row = await this.db
      .prepare(
        `INSERT INTO auth_rate_bucket(bucket_hash,hits,expires_at) VALUES (?,1,?)
      ON CONFLICT(bucket_hash) DO UPDATE SET
      hits=CASE WHEN auth_rate_bucket.expires_at<=? THEN 1 ELSE auth_rate_bucket.hits+1 END,
      expires_at=CASE WHEN auth_rate_bucket.expires_at<=? THEN excluded.expires_at ELSE auth_rate_bucket.expires_at END
      RETURNING hits`,
      )
      .bind(digest(bucketHash), expiresAt, now, now)
      .first<{ hits: number }>()
    if (!row) throw new Error('RATE_STORE_UNAVAILABLE')
    return row.hits <= limit
  }
}
