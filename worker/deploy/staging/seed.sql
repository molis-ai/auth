-- Run once against the empty molis-auth-staging D1 after all migrations.
INSERT INTO auth_environment
  (id, kind, auth_origin, delivery_mode, provider_mode, created_at, updated_at)
VALUES
  ('unified-staging', 'TEST', 'https://auth-staging.molis.ai', 'MOCK', 'LIVE', 0, 0);

INSERT INTO auth_application (id, name)
VALUES
  ('molis-club-staging-app', 'Molis Club Staging'),
  ('molis-work-staging-app', 'Molis Work Staging'),
  ('molis-work-tauri-staging-app', 'Molis Work Tauri Staging'),
  ('molis-work-tauri-bootstrap-app', 'Molis Work Tauri Staging Bootstrap');

INSERT INTO auth_client (id, client_id, application_id, client_type, scopes, redirects)
VALUES
  ('molis-club-staging-client', 'molis-club-staging', 'molis-club-staging-app', 'WEB',
   '["account","profile"]', '["https://club-staging.molis.ai/account/callback"]'),
  ('molis-work-staging-client', 'molis-work-staging', 'molis-work-staging-app', 'MACOS',
   '["account","profile"]', '["http://127.0.0.1:44207/account/callback"]'),
  ('molis-work-tauri-staging-client', 'molis-work-tauri-staging', 'molis-work-tauri-staging-app', 'MACOS',
   '["account","profile"]', '["http://127.0.0.1:4173/account/callback"]'),
  ('molis-work-tauri-bootstrap-client', 'molis-work-tauri-bootstrap', 'molis-work-tauri-bootstrap-app', 'MACOS',
   '["account","profile"]', '["http://127.0.0.1:4173/account/callback"]');

-- The installation login uses a separate v1 client (no policy row).
INSERT INTO auth_client_policy
  (client_id, policy_profile, environment_id, allowed_origins, created_at, updated_at)
VALUES
  ('molis-club-staging', 'unified-account-v2', 'unified-staging', '["https://club-staging.molis.ai"]', 0, 0),
  ('molis-work-staging', 'unified-account-v2', 'unified-staging', '["http://127.0.0.1:44207"]', 0, 0),
  ('molis-work-tauri-staging', 'unified-account-v2', 'unified-staging', '["http://127.0.0.1:4173"]', 0, 0);

INSERT INTO auth_client_product (client_id, product)
VALUES ('molis-club-staging', 'CLUB'), ('molis-work-staging', 'WORK'), ('molis-work-tauri-staging', 'WORK');
