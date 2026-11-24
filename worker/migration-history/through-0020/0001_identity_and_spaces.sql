-- Fresh V2 identity database. All timestamps are UTC epoch milliseconds.
CREATE TABLE auth_user (
 id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL CHECK(length(display_name) <= 120),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISABLED')), avatar_data TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE auth_user_email (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES auth_user(id),
 canonical_email TEXT NOT NULL UNIQUE, verified_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX ix_user_email_user ON auth_user_email(user_id);
CREATE TABLE auth_local_credential (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_user(id), password_hash TEXT NOT NULL,
 changed_at INTEGER NOT NULL
);
CREATE TABLE auth_external_identity (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES auth_user(id),
 provider TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(issuer,subject)
);
CREATE INDEX ix_external_identity_user ON auth_external_identity(user_id);
CREATE TABLE auth_space (
 id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL CHECK(length(name) <= 120),
 description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 200), avatar_data TEXT,
 space_type TEXT NOT NULL CHECK(space_type IN ('PERSONAL','TEAM')),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','ARCHIVED')),
 personal_user_id TEXT UNIQUE REFERENCES auth_user(id), version INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK((space_type='PERSONAL' AND personal_user_id IS NOT NULL AND status='ACTIVE')
    OR (space_type='TEAM' AND personal_user_id IS NULL))
);
