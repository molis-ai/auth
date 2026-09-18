CREATE TABLE auth_application_role_permission (
 application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 action VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 allowed BOOLEAN NOT NULL,
 PRIMARY KEY(application_id,role,action),
 CONSTRAINT fk_role_permission_application FOREIGN KEY(application_id) REFERENCES auth_application(id),
 CONSTRAINT ck_role_permission_role CHECK(role IN ('OWNER','ADMIN','MEMBER','VIEWER'))
) ENGINE=InnoDB;
ALTER TABLE auth_audit_event MODIFY COLUMN change_summary TEXT NULL;
