CREATE TABLE auth_application (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    name VARCHAR(120) NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    CONSTRAINT ck_application_status CHECK (status IN ('ACTIVE', 'DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE auth_login_client (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    client_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    client_type VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    allowed_scopes VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_login_client_id (client_id),
    CONSTRAINT fk_login_client_application FOREIGN KEY (application_id) REFERENCES auth_application(id),
    CONSTRAINT ck_login_client_type CHECK (client_type IN ('WEB', 'MACOS', 'CLI')),
    CONSTRAINT ck_login_client_status CHECK (status IN ('ACTIVE', 'DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE auth_login_redirect (
    client_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    redirect_uri VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (client_id, redirect_uri),
    CONSTRAINT fk_redirect_client FOREIGN KEY (client_id) REFERENCES auth_login_client(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- A root authentication is created only after full identity verification.
-- Browser cookie secret is hashed; native full-login roots have no restore cookie.
CREATE TABLE auth_authentication_session (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    cookie_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    authenticated_at TIMESTAMP(6) NOT NULL,
    last_user_activity_at TIMESTAMP(6) NOT NULL,
    revoked_at TIMESTAMP(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_authentication_cookie (cookie_hash),
    KEY ix_authentication_user (user_id, revoked_at),
    CONSTRAINT fk_authentication_user FOREIGN KEY (user_id) REFERENCES auth_user(id),
    CONSTRAINT ck_authentication_activity CHECK (last_user_activity_at >= authenticated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Each application grant inherits the original full-authentication time via the root.
CREATE TABLE auth_authorization_session (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    authentication_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    login_client_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    authorized_scopes VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    last_user_activity_at TIMESTAMP(6) NOT NULL,
    issued_at TIMESTAMP(6) NULL,
    revoked_at TIMESTAMP(6) NULL,
    created_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (id),
    KEY ix_authorization_authentication (authentication_id, revoked_at),
    CONSTRAINT fk_authorization_authentication FOREIGN KEY (authentication_id) REFERENCES auth_authentication_session(id),
    CONSTRAINT fk_authorization_client FOREIGN KEY (login_client_id) REFERENCES auth_login_client(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Retain consumed refresh hashes until their family is beyond its retention horizon.
-- No access or refresh plaintext, and no serialized Spring authorization blob.
CREATE TABLE auth_user_token (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    token_kind VARCHAR(16) NOT NULL,
    scopes VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    issued_at TIMESTAMP(6) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    consumed_at TIMESTAMP(6) NULL,
    live_refresh_session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
        GENERATED ALWAYS AS (
            CASE WHEN token_kind = 'REFRESH' AND consumed_at IS NULL THEN session_id ELSE NULL END
        ) STORED,
    PRIMARY KEY (token_hash),
    UNIQUE KEY uk_one_live_refresh (live_refresh_session_id),
    KEY ix_token_session (session_id, token_kind),
    CONSTRAINT fk_token_session FOREIGN KEY (session_id) REFERENCES auth_authorization_session(id),
    CONSTRAINT ck_user_token_kind CHECK (token_kind IN ('ACCESS', 'REFRESH')),
    CONSTRAINT ck_user_token_expiry CHECK (expires_at > issued_at),
    CONSTRAINT ck_access_not_consumable CHECK (token_kind = 'REFRESH' OR consumed_at IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
