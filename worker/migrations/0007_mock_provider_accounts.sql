-- Synthetic, isolated provider identities. No public endpoint can create these rows.
CREATE TABLE auth_mock_provider_account (
 id TEXT PRIMARY KEY NOT NULL,
 environment_id TEXT NOT NULL REFERENCES auth_environment(id),
 provider TEXT NOT NULL CHECK(provider IN ('GOOGLE','GITHUB')),
 subject TEXT NOT NULL,
 label TEXT NOT NULL,
 email TEXT,
 email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
 UNIQUE(environment_id,provider,subject)
);
