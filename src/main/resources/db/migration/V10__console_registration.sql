-- A deployment bootstrap serialization point, never an administrator or credential seed.
CREATE TABLE auth_console_registration (
    id VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    application_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    login_client_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    PRIMARY KEY (id),
    CONSTRAINT fk_console_application FOREIGN KEY (application_id) REFERENCES auth_application(id),
    CONSTRAINT fk_console_client FOREIGN KEY (login_client_id) REFERENCES auth_login_client(id),
    CONSTRAINT ck_console_registration CHECK ((application_id IS NULL AND login_client_id IS NULL)
        OR (application_id IS NOT NULL AND login_client_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
INSERT INTO auth_console_registration(id) VALUES('console');
