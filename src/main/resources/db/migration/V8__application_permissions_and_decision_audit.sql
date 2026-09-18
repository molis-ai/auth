CREATE TABLE auth_application_permission (
    application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (application_id,action),
    CONSTRAINT fk_application_permission FOREIGN KEY (application_id) REFERENCES auth_application(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Empty application catalog means no business actions; never automatically grant all existing apps.
ALTER TABLE auth_audit_event
    ADD COLUMN actor_service_client_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN requested_action VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN denial_reason VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN resource_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN resource_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD UNIQUE KEY uk_audit_decision (decision_id);
