ALTER TABLE auth_mail_outbox
    DROP CHECK ck_mail_status,
    ADD COLUMN payload_encrypted TEXT CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN expires_at TIMESTAMP(6) NULL,
    ADD COLUMN lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN lease_until TIMESTAMP(6) NULL,
    ADD COLUMN last_error_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT ck_mail_status CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
    ADD CONSTRAINT ck_mail_lease CHECK (
        (status = 'SENDING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
        OR (status <> 'SENDING' AND lease_token IS NULL AND lease_until IS NULL)
    ),
    ADD KEY ix_mail_lease (status, lease_until, id);
