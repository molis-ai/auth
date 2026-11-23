-- Environment and clients for the GitHub and Google LIVE adapter tests.
INSERT INTO auth_environment
  (id, kind, auth_origin, delivery_mode, provider_mode, created_at, updated_at)
VALUES
  ('unified-staging', 'TEST', 'https://auth-staging.molis.ai', 'MOCK', 'LIVE', 0, 0);

INSERT INTO auth_application (id, name)
VALUES
  ('molis-club-staging-app', 'Molis Club Staging'),
  ('molis-work-staging-app', 'Molis Work Staging');

INSERT INTO auth_client (id, client_id, application_id, client_type, scopes, redirects)
VALUES
  ('molis-club-staging-client', 'molis-club-staging', 'molis-club-staging-app', 'WEB',
   '["account","profile"]', '["https://club-staging.molis.ai/account/callback"]'),
  ('molis-work-staging-client', 'molis-work-staging', 'molis-work-staging-app', 'MACOS',
   '["account","profile"]', '["http://127.0.0.1:44207/account/callback"]');

INSERT INTO auth_client_policy
  (client_id, policy_profile, environment_id, allowed_origins, created_at, updated_at)
VALUES
  ('molis-club-staging', 'unified-account-v2', 'unified-staging', '["https://club-staging.molis.ai"]', 0, 0),
  ('molis-work-staging', 'unified-account-v2', 'unified-staging', '["http://127.0.0.1:44207"]', 0, 0);

INSERT INTO auth_client_product (client_id, product)
VALUES ('molis-club-staging', 'CLUB'), ('molis-work-staging', 'WORK');
