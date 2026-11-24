-- Auth's own V2 web/BFF session. Credentials and temporary proofs are AES-GCM sealed.
CREATE TABLE auth_web_session (
 id_hash TEXT PRIMARY KEY NOT NULL,
 payload TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 status TEXT NOT NULL CHECK(status IN ('READY','BUSY')),
 expires_at INTEGER NOT NULL
);
CREATE INDEX ix_web_session_expiry ON auth_web_session(expires_at);
