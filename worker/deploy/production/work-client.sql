-- Explicit deployment step after production migrations. No users or test credentials.
INSERT OR IGNORE INTO auth_application(id,name) VALUES ('molis-work-production-app','Molis Work');
INSERT OR IGNORE INTO auth_client(id,client_id,application_id,client_type,scopes,redirects)
VALUES ('molis-work-production-client','molis-work-production','molis-work-production-app','MACOS','["account","profile"]','["http://127.0.0.1:4207/account/callback"]');
INSERT OR IGNORE INTO auth_client_policy(client_id,policy_profile,environment_id,allowed_origins,created_at,updated_at)
VALUES ('molis-work-production','unified-account-v2','auth-production','["http://127.0.0.1:4207"]',0,0);
INSERT OR IGNORE INTO auth_client_product(client_id,product) VALUES ('molis-work-production','WORK');
