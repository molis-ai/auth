-- Optional LOCAL login clients for the Work and Club test fixtures.
-- Execute only against a disposable/local database. Creates no users, credentials,
-- platform permissions, managed tenants, subscriptions or seats.
-- Existing registrations are never overwritten, enabled or silently re-profiled.
INSERT OR IGNORE INTO auth_environment(id,kind,auth_origin,delivery_mode,provider_mode,created_at,updated_at)
VALUES ('unified-local','LOCAL','http://127.0.0.1:8787','MOCK','MOCK',0,0);

INSERT OR IGNORE INTO auth_application(id,name)
VALUES ('molis-work-unified-local-app','Molis Work Local'),('molis-club-unified-local-app','Molis Club Local');
INSERT OR IGNORE INTO auth_client(id,client_id,application_id,client_type,redirects,environment_id,allowed_origins)
VALUES ('molis-work-unified-local-client','molis-work-unified-local','molis-work-unified-local-app','MACOS',
        '["http://127.0.0.1:4207/account/callback"]','unified-local','["http://127.0.0.1:4207"]'),
       ('molis-club-unified-local-client','molis-club-unified-local','molis-club-unified-local-app','WEB',
        '["http://127.0.0.1:3000/account/callback"]','unified-local','["http://127.0.0.1:3000"]');
