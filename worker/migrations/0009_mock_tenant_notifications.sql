-- Isolated invitation notifications, never authentication credentials or public capabilities.
CREATE TABLE auth_mock_notification (
 delivery_id TEXT PRIMARY KEY NOT NULL,
 environment_id TEXT NOT NULL REFERENCES auth_environment(id),
 channel TEXT NOT NULL CHECK(channel IN ('EMAIL','SMS')),
 destination TEXT NOT NULL,
 template_key TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object'),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX ix_mock_notification_expiry ON auth_mock_notification(expires_at);
