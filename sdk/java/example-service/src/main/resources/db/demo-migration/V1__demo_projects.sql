-- Business-owned demo schema; provision in a separate database, never the Auth database.
CREATE TABLE demo_project (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    space_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    name VARCHAR(120) NOT NULL,
    state VARCHAR(16) NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    KEY ix_demo_space (space_id,id),
    CONSTRAINT ck_demo_state CHECK (state IN ('EDITABLE','LOCKED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
