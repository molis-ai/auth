-- Current environment client only. No accounts, administrator grants or credentials.
INSERT OR IGNORE INTO auth_environment(id,kind,auth_origin,delivery_mode,provider_mode,created_at,updated_at)
VALUES ('auth-preview','TEST','https://auth-preview.adeptify.me','LIVE','LIVE',0,0);
INSERT OR IGNORE INTO auth_application(id,name,is_console) VALUES ('auth-preview-app','Molis Auth',1);
INSERT OR IGNORE INTO auth_client(id,client_id,application_id,client_type,scopes,redirects)
VALUES ('auth-preview-client','molis-auth-web-preview','auth-preview-app','WEB','["account","profile"]','["https://auth-preview.adeptify.me/account/callback"]');
INSERT OR IGNORE INTO auth_client_policy(client_id,policy_profile,environment_id,allowed_origins,created_at,updated_at)
VALUES ('molis-auth-web-preview','unified-account-v2','auth-preview','["https://auth-preview.adeptify.me"]',0,0);
