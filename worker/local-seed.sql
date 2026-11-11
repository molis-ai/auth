-- Current local Auth browser client. No accounts, credentials or platform permissions.
INSERT OR IGNORE INTO auth_environment(id,kind,auth_origin,delivery_mode,provider_mode,created_at,updated_at)
VALUES ('unified-local','LOCAL','http://127.0.0.1:8787','MOCK','MOCK',0,0);
INSERT OR IGNORE INTO auth_application(id,name,is_console) VALUES ('00000000-0000-4000-8000-000000000001','Molis Auth',1);
INSERT OR IGNORE INTO auth_client(id,client_id,application_id,client_type,scopes,redirects)
VALUES ('00000000-0000-4000-8000-000000000002','molis-auth-web-local','00000000-0000-4000-8000-000000000001','WEB','["account","profile"]','["http://127.0.0.1:8787/account/callback"]');
INSERT OR IGNORE INTO auth_client_policy(client_id,policy_profile,environment_id,allowed_origins,created_at,updated_at)
VALUES ('molis-auth-web-local','unified-account-v2','unified-local','["http://127.0.0.1:8787"]',0,0);
