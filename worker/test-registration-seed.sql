-- Test-only Auth registrations for the remote and loopback clients. Run after schema migrations.

INSERT INTO auth_environment(id, kind, auth_origin, delivery_mode, provider_mode, created_at, updated_at)
VALUES ('unified-staging', 'TEST', 'https://auth.test.molis.ai', 'LIVE', 'LIVE', 0, 0),
       ('auth-test-loopback', 'TEST', 'http://127.0.0.1:8787', 'LIVE', 'LIVE', 0, 0)
ON CONFLICT(id) DO NOTHING;

INSERT INTO auth_application(id, name, is_console)
VALUES ('molis-auth-test-console', 'Molis Auth Test', 1),
       ('molis-club-staging-app', 'Molis Club Test', 0),
       ('molis-work-staging-app', 'Molis Work Test', 0)
ON CONFLICT(id) DO NOTHING;

INSERT INTO auth_client(id, client_id, application_id, client_type, scopes, redirects)
VALUES ('molis-auth-web-test', 'molis-auth-web-test', 'molis-auth-test-console', 'WEB', '["account","profile"]', '["https://auth.test.molis.ai/account/callback"]'),
       ('molis-auth-web-test-loopback', 'molis-auth-web-test-loopback', 'molis-auth-test-console', 'WEB', '["account","profile"]', '["http://127.0.0.1:8787/account/callback"]'),
       ('molis-club-test', 'molis-club-test', 'molis-club-staging-app', 'WEB', '["account","profile"]', '["https://test.molis.ai/account/callback"]'),
       ('molis-club-test-loopback', 'molis-club-test-loopback', 'molis-club-staging-app', 'WEB', '["account","profile"]', '["http://127.0.0.1:3000/account/callback"]'),
       ('molis-work-test', 'molis-work-test', 'molis-work-staging-app', 'MACOS', '["account","profile"]', '["http://127.0.0.1:4207/account/callback"]'),
       ('molis-work-test-desktop', 'molis-work-test-desktop', 'molis-work-staging-app', 'MACOS', '["account","profile"]', '["http://127.0.0.1:4173/account/callback"]')
ON CONFLICT(client_id) DO NOTHING;

INSERT INTO auth_client_policy(client_id, policy_profile, environment_id, allowed_origins, created_at, updated_at)
VALUES ('molis-auth-web-test', 'unified-account-v2', 'unified-staging', '["https://auth.test.molis.ai"]', 0, 0),
       ('molis-auth-web-test-loopback', 'unified-account-v2', 'auth-test-loopback', '["http://127.0.0.1:8787"]', 0, 0),
       ('molis-club-test', 'unified-account-v2', 'unified-staging', '["https://test.molis.ai"]', 0, 0),
       ('molis-club-test-loopback', 'unified-account-v2', 'unified-staging', '["http://127.0.0.1:3000"]', 0, 0),
       ('molis-work-test', 'unified-account-v2', 'unified-staging', '["http://127.0.0.1:4207"]', 0, 0),
       ('molis-work-test-desktop', 'unified-account-v2', 'unified-staging', '["http://127.0.0.1:4173"]', 0, 0)
ON CONFLICT(client_id) DO NOTHING;

INSERT INTO auth_client_product(client_id, product)
VALUES ('molis-club-test', 'CLUB'),
       ('molis-club-test-loopback', 'CLUB'),
       ('molis-work-test', 'WORK'),
       ('molis-work-test-desktop', 'WORK')
ON CONFLICT(client_id) DO NOTHING;
