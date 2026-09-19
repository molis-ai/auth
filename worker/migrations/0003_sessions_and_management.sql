CREATE TABLE auth_application (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
 version INTEGER NOT NULL DEFAULT 0, actions TEXT NOT NULL DEFAULT '[]', grants TEXT NOT NULL DEFAULT '{}', is_console INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE auth_client (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, application_id TEXT NOT NULL REFERENCES auth_application(id),
 client_type TEXT NOT NULL CHECK(client_type IN ('WEB','MACOS','CLI')), status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
 version INTEGER NOT NULL DEFAULT 0, scopes TEXT NOT NULL, redirects TEXT NOT NULL
);
CREATE TABLE auth_authentication (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_user(id), cookie_hash TEXT UNIQUE,
 created_at INTEGER NOT NULL, activity_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX ix_authentication_user ON auth_authentication(user_id);
CREATE TABLE auth_transaction (
 token_hash TEXT PRIMARY KEY, context TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'READY', expires_at INTEGER NOT NULL,
 authentication_id TEXT REFERENCES auth_authentication(id), proof_hash TEXT, browser_hash TEXT
);
CREATE INDEX ix_transaction_expiry ON auth_transaction(expires_at);
CREATE TABLE auth_code (
 token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES auth_client(client_id), redirect_uri TEXT NOT NULL,
 challenge TEXT NOT NULL, scopes TEXT NOT NULL, authentication_id TEXT NOT NULL REFERENCES auth_authentication(id),
 expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE auth_grant (
 id TEXT PRIMARY KEY, authentication_id TEXT NOT NULL REFERENCES auth_authentication(id),
 client_id TEXT NOT NULL REFERENCES auth_client(client_id), scopes TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX ix_grant_authentication ON auth_grant(authentication_id);
CREATE TABLE auth_access_token (
 token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES auth_grant(id), expires_at INTEGER NOT NULL
);
CREATE TABLE auth_refresh_token (
 token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES auth_grant(id), expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE INDEX ix_access_expiry ON auth_access_token(expires_at);
CREATE INDEX ix_refresh_grant ON auth_refresh_token(grant_id);
CREATE TABLE auth_audit_event (
 id TEXT PRIMARY KEY, action TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('SUCCESS','DENIED')),
 actor_user_id TEXT, target_user_id TEXT, space_id TEXT, application_id TEXT,
 request_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, change_summary TEXT, denial_reason TEXT
);
CREATE INDEX ix_audit_user_time ON auth_audit_event(target_user_id,occurred_at,id);
CREATE INDEX ix_audit_space_time ON auth_audit_event(space_id,occurred_at,id);
CREATE TABLE auth_invitation (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES auth_space(id), invited_email TEXT NOT NULL,
 recipient_user_id TEXT NOT NULL REFERENCES auth_user(id), inviter_user_id TEXT NOT NULL REFERENCES auth_user(id),
 status TEXT NOT NULL CHECK(status IN ('PENDING','ACCEPTED','DECLINED','REVOKED')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX ix_invitation_recipient ON auth_invitation(recipient_user_id,status,created_at,id);
CREATE INDEX ix_invitation_space ON auth_invitation(space_id,created_at,id);
-- A failed assertion rolls back the whole D1 batch. Rows are deleted inside successful batches.
CREATE TABLE auth_write_guard (id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
