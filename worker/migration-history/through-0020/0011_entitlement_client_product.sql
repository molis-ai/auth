-- Explicit trusted product registration. No existing client is inferred or enrolled.
CREATE TABLE auth_client_product (
 client_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_client_policy(client_id),
 product TEXT NOT NULL CHECK(product IN ('WORK','CLUB')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
