CREATE TABLE auth_space_invitation (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    invited_email VARCHAR(254) NOT NULL,
    inviter_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) NOT NULL,
    accepted_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at TIMESTAMP(6) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    pending_email VARCHAR(254) GENERATED ALWAYS AS (CASE WHEN status='PENDING' THEN invited_email ELSE NULL END) STORED,
    PRIMARY KEY(id),
    UNIQUE KEY uk_pending_invitation(space_id,pending_email),
    KEY ix_invitation_email(invited_email,status,expires_at,id),
    CONSTRAINT fk_invitation_space FOREIGN KEY(space_id) REFERENCES auth_space(id),
    CONSTRAINT fk_invitation_inviter FOREIGN KEY(inviter_user_id) REFERENCES auth_user(id),
    CONSTRAINT fk_invitation_acceptor FOREIGN KEY(accepted_by) REFERENCES auth_user(id),
    CONSTRAINT ck_invitation_status CHECK(status IN('PENDING','ACCEPTED','DECLINED','REVOKED','EXPIRED')),
    CONSTRAINT ck_invitation_acceptor CHECK((status='ACCEPTED' AND accepted_by IS NOT NULL) OR (status<>'ACCEPTED' AND accepted_by IS NULL)),
    CONSTRAINT ck_invitation_expiry CHECK(expires_at>created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
ALTER TABLE auth_audit_event ADD COLUMN invitation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;
