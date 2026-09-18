ALTER TABLE auth_application ADD COLUMN version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE auth_login_client ADD COLUMN version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE auth_audit_event
    ADD COLUMN target_login_client_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN change_summary VARCHAR(255) NULL;
