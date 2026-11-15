-- One-use browser-bound bridge from an existing product session into Auth management.
CREATE TABLE auth_management_handoff (
 id TEXT PRIMARY KEY NOT NULL,
 source_session TEXT NOT NULL REFERENCES auth_login_session(id),
 source_revision INTEGER NOT NULL,
 source_client TEXT NOT NULL,
 redirect_uri TEXT NOT NULL,
 initiator_challenge TEXT NOT NULL,
 browser_hash TEXT,
 code_hash TEXT,
 expires_at INTEGER NOT NULL,
 consumed_at INTEGER
);
CREATE INDEX ix_management_handoff_expiry ON auth_management_handoff(expires_at);
