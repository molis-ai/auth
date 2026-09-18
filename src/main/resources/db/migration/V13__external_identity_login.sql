-- OIDC issuer/subject are opaque, byte-exact identifiers (including case).
ALTER TABLE auth_external_identity
    MODIFY issuer VARBINARY(255) NOT NULL,
    MODIFY subject VARBINARY(255) NOT NULL;

-- A verified provider registration + nonce has one login result across Auth nodes.
-- No raw provider ID/access/refresh token, nonce or credential is persisted here.
CREATE TABLE auth_external_login_receipt (
    verification_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    issuer VARBINARY(255) NOT NULL,
    subject VARBINARY(255) NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    authentication_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    registered BOOLEAN NOT NULL,
    completed_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (verification_hash),
    KEY ix_external_receipt_time (completed_at),
    CONSTRAINT fk_external_receipt_user FOREIGN KEY (user_id) REFERENCES auth_user(id),
    CONSTRAINT fk_external_receipt_root FOREIGN KEY (authentication_id) REFERENCES auth_authentication_session(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
