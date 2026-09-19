-- Explicit local-only bootstrap. No users, administrator grants, passwords or production URLs.
INSERT OR IGNORE INTO auth_application(id,name,is_console) VALUES ('00000000-0000-4000-8000-000000000001','Molis Auth Console',1);
INSERT OR IGNORE INTO auth_client(id,client_id,application_id,client_type,scopes,redirects)
VALUES ('00000000-0000-4000-8000-000000000002','molis-auth-console','00000000-0000-4000-8000-000000000001','WEB','["account","profile"]','["http://127.0.0.1:8787/console/callback"]');
