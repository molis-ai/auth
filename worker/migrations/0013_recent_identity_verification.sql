-- Recent identity verification is session-owned, never refreshed by browsing or token renewal.
ALTER TABLE auth_login_session ADD COLUMN identity_verified_at INTEGER NOT NULL DEFAULT 0;
