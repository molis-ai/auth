-- Receipts make a completed, server-verified mailbox operation idempotent across nodes.
-- IDs are not proofs: only the trusted verification workflow may call account services.
CREATE TABLE auth_account_operation (
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    purpose VARCHAR(32) NOT NULL,
    canonical_email VARCHAR(320) NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    completed_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (operation_id),
    CONSTRAINT fk_account_operation_user FOREIGN KEY (user_id) REFERENCES auth_user(id),
    CONSTRAINT ck_account_operation_purpose CHECK (purpose IN ('REGISTER', 'PASSWORD_RESET'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE auth_audit_event (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    actor_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    target_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    occurred_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (id),
    KEY ix_audit_user_time (target_user_id, occurred_at, id),
    KEY ix_audit_space_time (space_id, occurred_at, id),
    KEY ix_audit_time (occurred_at, id),
    CONSTRAINT ck_audit_outcome CHECK (outcome IN ('SUCCESS', 'DENIED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Only fixed non-secret account notification templates are queued by this slice.
-- Verification/invitation links need their own protected payload design, not plaintext tokens here.
CREATE TABLE auth_mail_outbox (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    recipient_email VARCHAR(320) NOT NULL,
    template_key VARCHAR(64) NOT NULL,
    locale VARCHAR(8) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP(6) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL,
    sent_at TIMESTAMP(6) NULL,
    PRIMARY KEY (id),
    KEY ix_mail_due (status, next_attempt_at, id),
    CONSTRAINT ck_mail_locale CHECK (locale IN ('zh-CN', 'en')),
    CONSTRAINT ck_mail_status CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
    CONSTRAINT ck_mail_attempts CHECK (attempts >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
