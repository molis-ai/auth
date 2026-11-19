-- Auth and Club client registration for auth.molis.ai, after the production schema upgrade.
INSERT INTO auth_environment(id, kind, auth_origin, delivery_mode, provider_mode, created_at, updated_at)
VALUES ('auth-production', 'PRODUCTION', 'https://auth.molis.ai', 'LIVE', 'LIVE',
        unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO auth_application(id, name, is_console) VALUES
  ('auth-production-app', 'Molis Auth', 1),
  ('molis-club-production-app', 'Molis Club', 0);

INSERT INTO auth_client(id, client_id, application_id, client_type, scopes, redirects) VALUES
  ('auth-production-client', 'molis-auth-web-production', 'auth-production-app', 'WEB',
   '["account","profile"]', '["https://auth.molis.ai/account/callback"]'),
  ('molis-club-production-client', 'molis-club-production', 'molis-club-production-app', 'WEB',
   '["account","profile"]', '["https://molis.ai/account/callback"]');

INSERT INTO auth_client_policy(client_id, policy_profile, environment_id, allowed_origins, created_at, updated_at) VALUES
  ('molis-auth-web-production', 'unified-account-v2', 'auth-production', '["https://auth.molis.ai"]',
   unixepoch() * 1000, unixepoch() * 1000),
  ('molis-club-production', 'unified-account-v2', 'auth-production', '["https://molis.ai"]',
   unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO auth_client_product(client_id, product) VALUES ('molis-club-production', 'CLUB');
