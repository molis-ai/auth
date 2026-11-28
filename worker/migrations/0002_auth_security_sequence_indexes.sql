-- Avoid scans of session and user rows when SQLite validates the sequence references.
CREATE INDEX ix_login_session_created_sequence ON auth_login_session(created_seq);
CREATE INDEX ix_user_revoked_sequence ON auth_user(revoked_before_seq);
