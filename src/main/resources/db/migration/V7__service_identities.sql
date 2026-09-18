-- Service identities and tokens are deliberately separate from user login/token tables.
CREATE TABLE auth_service_client (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    client_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    name VARCHAR(200) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_service_client_id (client_id),
    KEY ix_service_application (application_id),
    CONSTRAINT fk_service_application FOREIGN KEY (application_id) REFERENCES auth_application(id),
    CONSTRAINT ck_service_status CHECK (status IN ('ACTIVE','DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE auth_service_credential (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    service_client_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    secret_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP(6) NOT NULL,
    revoked_at TIMESTAMP(6) NULL,
    active_client CHAR(36) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS
        (CASE WHEN revoked_at IS NULL THEN service_client_id ELSE NULL END) STORED,
    PRIMARY KEY (id),
    UNIQUE KEY uk_service_secret (secret_hash),
    UNIQUE KEY uk_service_active_credential (active_client),
    KEY ix_service_credential_client (service_client_id),
    CONSTRAINT fk_service_credential_client FOREIGN KEY (service_client_id) REFERENCES auth_service_client(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE auth_service_token (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    credential_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    scope VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    issued_at TIMESTAMP(6) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (token_hash),
    KEY ix_service_token_credential (credential_id),
    KEY ix_service_token_expiry (expires_at),
    CONSTRAINT fk_service_token_credential FOREIGN KEY (credential_id) REFERENCES auth_service_credential(id),
    CONSTRAINT ck_service_token_expiry CHECK (expires_at > issued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

ALTER TABLE auth_audit_event
    ADD COLUMN target_service_client_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN service_credential_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;
