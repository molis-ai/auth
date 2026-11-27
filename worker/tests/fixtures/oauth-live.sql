-- Environment and clients for the GitHub and Google LIVE adapter tests.
INSERT INTO auth_environment
  (id, kind, auth_origin, delivery_mode, provider_mode, created_at, updated_at)
VALUES
  ('unified-staging', 'TEST', 'https://auth-staging.molis.ai', 'MOCK', 'LIVE', 0, 0);

INSERT INTO auth_application (id, name)
VALUES
  ('molis-club-staging-app', 'Molis Club Staging'),
  ('molis-work-staging-app', 'Molis Work Staging');

INSERT INTO auth_client (id, client_id, application_id, client_type, redirects, environment_id, allowed_origins)
VALUES
  ('molis-club-staging-client', 'molis-club-staging', 'molis-club-staging-app', 'WEB',
   '["https://club-staging.molis.ai/account/callback"]', 'unified-staging', '["https://club-staging.molis.ai"]'),
  ('molis-work-staging-client', 'molis-work-staging', 'molis-work-staging-app', 'MACOS',
   '["http://127.0.0.1:44207/account/callback"]', 'unified-staging', '["http://127.0.0.1:44207"]');
