-- Explicit, opt-in LOCAL bootstrap after all migrations through 0011. Not part of local-seed.sql.
-- Execute only against a disposable/local database. Creates no users, credentials,
-- platform permissions, managed tenants, subscriptions or seats.
-- Existing registrations are never overwritten, enabled or silently re-profiled.
INSERT OR IGNORE INTO auth_environment(id,kind,auth_origin,delivery_mode,provider_mode,created_at,updated_at)
VALUES ('unified-local','LOCAL','http://127.0.0.1:8787','MOCK','MOCK',0,0);

INSERT OR IGNORE INTO auth_application(id,name)
VALUES ('molis-work-unified-local-app','Molis Work Local'),('molis-club-unified-local-app','Molis Club Local');
INSERT OR IGNORE INTO auth_client(id,client_id,application_id,client_type,scopes,redirects)
VALUES ('molis-work-unified-local-client','molis-work-unified-local','molis-work-unified-local-app','MACOS','["account","profile"]','["http://127.0.0.1:4207/account/callback"]'),
       ('molis-club-unified-local-client','molis-club-unified-local','molis-club-unified-local-app','WEB','["account","profile"]','["http://127.0.0.1:3000/account/callback"]');

INSERT OR IGNORE INTO auth_client_policy(client_id,policy_profile,environment_id,allowed_origins,created_at,updated_at)
SELECT client_id,'unified-account-v2','unified-local','["http://127.0.0.1:4207"]',0,0 FROM auth_client
WHERE id='molis-work-unified-local-client' AND client_id='molis-work-unified-local'
  AND application_id='molis-work-unified-local-app' AND client_type='MACOS';
INSERT OR IGNORE INTO auth_client_policy(client_id,policy_profile,environment_id,allowed_origins,created_at,updated_at)
SELECT client_id,'unified-account-v2','unified-local','["http://127.0.0.1:3000"]',0,0 FROM auth_client
WHERE id='molis-club-unified-local-client' AND client_id='molis-club-unified-local'
  AND application_id='molis-club-unified-local-app' AND client_type='WEB';

-- Explicit product registration for these isolated clients only (requires 0011).
-- Never overwrite an existing product mapping or infer production clients by name.
INSERT OR IGNORE INTO auth_client_product(client_id,product)
SELECT p.client_id,'WORK' FROM auth_client_policy p JOIN auth_client c ON c.client_id=p.client_id
JOIN auth_environment e ON e.id=p.environment_id
WHERE c.id='molis-work-unified-local-client' AND c.application_id='molis-work-unified-local-app'
 AND p.client_id='molis-work-unified-local' AND e.id='unified-local' AND e.kind='LOCAL';
INSERT OR IGNORE INTO auth_client_product(client_id,product)
SELECT p.client_id,'CLUB' FROM auth_client_policy p JOIN auth_client c ON c.client_id=p.client_id
JOIN auth_environment e ON e.id=p.environment_id
WHERE c.id='molis-club-unified-local-client' AND c.application_id='molis-club-unified-local-app'
 AND p.client_id='molis-club-unified-local' AND e.id='unified-local' AND e.kind='LOCAL';
