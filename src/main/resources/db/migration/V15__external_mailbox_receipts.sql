-- A consumed mailbox capability must not authorize another provider or another registration.
-- No delivery secret, provider token, or raw mailbox is stored in this receipt.
CREATE TABLE auth_external_mailbox_receipt (
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    verification_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    completed_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (operation_id),
    KEY ix_external_mailbox_receipt_time (completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
