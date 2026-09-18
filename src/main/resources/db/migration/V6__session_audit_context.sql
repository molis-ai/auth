-- Stable audit context, never raw access/refresh/cookie values. No FK: audit survives retention changes.
ALTER TABLE auth_audit_event
    ADD COLUMN application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN authorization_session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;
