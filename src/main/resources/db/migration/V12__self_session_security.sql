-- A login-session ID is audit context, never a cookie/token or an authentication proof.
ALTER TABLE auth_audit_event
    ADD COLUMN authentication_session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;
CREATE INDEX ix_authentication_user_time ON auth_authentication_session(user_id, authenticated_at, id);
