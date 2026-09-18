-- Auth owns identity and space membership, not business projects/resources.
CREATE TABLE auth_user (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    CONSTRAINT ck_user_status CHECK (status IN ('ACTIVE', 'DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Verified mailbox ownership is separate from external provider identity.
-- Canonicalization is performed before lookup/insert; no provider-specific dot/+ stripping.
CREATE TABLE auth_user_email (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    canonical_email VARCHAR(320) NOT NULL,
    verified_at TIMESTAMP(6) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_verified_email (canonical_email),
    KEY ix_user_email_user (user_id),
    CONSTRAINT fk_user_email_user FOREIGN KEY (user_id) REFERENCES auth_user (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE auth_local_credential (
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    changed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (user_id),
    CONSTRAINT fk_local_credential_user FOREIGN KEY (user_id) REFERENCES auth_user (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE auth_external_identity (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    issuer VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_external_identity (issuer, subject),
    KEY ix_external_identity_user (user_id),
    CONSTRAINT fk_external_identity_user FOREIGN KEY (user_id) REFERENCES auth_user (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE auth_space (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    name VARCHAR(120) NOT NULL,
    space_type VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    personal_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_personal_space (personal_user_id),
    CONSTRAINT fk_personal_space_user FOREIGN KEY (personal_user_id) REFERENCES auth_user (id),
    CONSTRAINT ck_space_type CHECK (space_type IN ('PERSONAL', 'TEAM')),
    CONSTRAINT ck_space_status CHECK (status IN ('ACTIVE', 'ARCHIVED')),
    CONSTRAINT ck_personal_space CHECK (
        (space_type = 'PERSONAL' AND personal_user_id IS NOT NULL AND status = 'ACTIVE')
        OR (space_type = 'TEAM' AND personal_user_id IS NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE auth_membership (
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    role VARCHAR(16) NOT NULL,
    -- MySQL unique indexes admit multiple NULL values, but only one OWNER per space.
    owner_space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
        GENERATED ALWAYS AS (CASE WHEN role = 'OWNER' THEN space_id ELSE NULL END) STORED,
    joined_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (space_id, user_id),
    UNIQUE KEY uk_one_owner (owner_space_id),
    KEY ix_membership_user (user_id, space_id),
    CONSTRAINT fk_membership_space FOREIGN KEY (space_id) REFERENCES auth_space (id),
    CONSTRAINT fk_membership_user FOREIGN KEY (user_id) REFERENCES auth_user (id),
    CONSTRAINT ck_membership_role CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- At least one OWNER and personal-space-only ownership are cross-row invariants:
-- creation/transfer services must hold the space row lock and commit the full aggregate.
-- The unique index enforces "at most one"; it does not alone enforce "exactly one".
