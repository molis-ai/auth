CREATE TABLE auth_application (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
 version INTEGER NOT NULL DEFAULT 0, is_console INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE auth_client (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, application_id TEXT NOT NULL REFERENCES auth_application(id),
 client_type TEXT NOT NULL CHECK(client_type IN ('WEB','MACOS','CLI')), status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
 version INTEGER NOT NULL DEFAULT 0, scopes TEXT NOT NULL, redirects TEXT NOT NULL
);
CREATE TABLE auth_audit_event (
 id TEXT PRIMARY KEY, action TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('SUCCESS','DENIED')),
 actor_user_id TEXT, target_user_id TEXT, space_id TEXT, application_id TEXT,
 request_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, change_summary TEXT, denial_reason TEXT
);
CREATE INDEX ix_audit_user_time ON auth_audit_event(target_user_id,occurred_at,id);
CREATE INDEX ix_audit_space_time ON auth_audit_event(space_id,occurred_at,id);
-- A failed assertion rolls back the whole D1 batch. Rows are deleted inside successful batches.
CREATE TABLE auth_write_guard (id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
