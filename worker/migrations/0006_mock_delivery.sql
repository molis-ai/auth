-- Isolated delivery inbox, never enabled by a production environment.
-- No public HTTP route exposes these test credentials. Expired messages are deleted.
CREATE TABLE auth_mock_delivery (
 delivery_id TEXT PRIMARY KEY NOT NULL,
 environment_id TEXT NOT NULL REFERENCES auth_environment(id),
 channel TEXT NOT NULL CHECK(channel IN ('EMAIL','SMS')),
 destination TEXT NOT NULL,
 template_key TEXT NOT NULL,
 credential TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX ix_mock_delivery_expiry ON auth_mock_delivery(expires_at);
