-- Current environment client only. No accounts, administrator grants or credentials.
INSERT OR IGNORE INTO auth_environment(id,kind,auth_origin,delivery_mode,provider_mode,created_at,updated_at)
VALUES ('auth-production','PRODUCTION','https://molis-auth-production.sparkling-silence-0a49.workers.dev','LIVE','LIVE',0,0);
INSERT OR IGNORE INTO auth_application(id,name,is_console) VALUES ('auth-production-app','Molis Auth',1);
INSERT OR IGNORE INTO auth_client(id,client_id,application_id,client_type,scopes,redirects)
VALUES ('auth-production-client','molis-auth-web-production','auth-production-app','WEB','["account","profile"]','["https://molis-auth-production.sparkling-silence-0a49.workers.dev/account/callback"]');
INSERT OR IGNORE INTO auth_client_policy(client_id,policy_profile,environment_id,allowed_origins,created_at,updated_at)
VALUES ('molis-auth-web-production','unified-account-v2','auth-production','["https://molis-auth-production.sparkling-silence-0a49.workers.dev"]',0,0);
