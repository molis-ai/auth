CREATE TABLE auth_service (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, application_id TEXT NOT NULL REFERENCES auth_application(id),
 name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
 credential_id TEXT NOT NULL, secret_hash TEXT NOT NULL
);
CREATE TABLE auth_service_token (
 token_hash TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES auth_service(id), credential_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
