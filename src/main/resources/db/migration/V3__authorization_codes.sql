CREATE TABLE auth_authorization_code (
    code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    authentication_transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    redirect_uri VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    pkce_challenge CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    issued_at TIMESTAMP(6) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    consumed_at TIMESTAMP(6) NULL,
    PRIMARY KEY (code_hash),
    UNIQUE KEY uk_code_session (session_id),
    UNIQUE KEY uk_code_authentication_transaction (authentication_transaction_id),
    CONSTRAINT fk_code_session FOREIGN KEY (session_id) REFERENCES auth_authorization_session(id),
    CONSTRAINT ck_code_expiry CHECK (expires_at > issued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
