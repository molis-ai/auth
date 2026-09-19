-- Strongly consistent one-use receipts, not an eventually consistent KV cache.
-- Only token digests are stored. Binding digests identify the exact authorized transaction.
CREATE TABLE auth_one_use (
 token_hash TEXT PRIMARY KEY NOT NULL,
 purpose TEXT NOT NULL,
 binding_hash TEXT NOT NULL,
 payload TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX ix_one_use_expiration ON auth_one_use(expires_at);
CREATE TABLE auth_rate_bucket (
 bucket_hash TEXT PRIMARY KEY NOT NULL,
 hits INTEGER NOT NULL CHECK(hits > 0),
 expires_at INTEGER NOT NULL
);
CREATE INDEX ix_rate_bucket_expiration ON auth_rate_bucket(expires_at);
