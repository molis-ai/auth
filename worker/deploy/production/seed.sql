-- Environment-specific system records only. Never creates users or passwords.
INSERT OR IGNORE INTO auth_application(id,name,is_console)
VALUES ('00000000-0000-4000-8000-000000000001','Molis Auth Console',1);
INSERT INTO auth_client(id,client_id,application_id,client_type,scopes,redirects)
VALUES ('00000000-0000-4000-8000-000000000002','molis-auth-console','00000000-0000-4000-8000-000000000001','WEB','["account","profile"]','["https://molis-auth-production.sparkling-silence-0a49.workers.dev/console/callback"]')
ON CONFLICT(id) DO UPDATE SET redirects=excluded.redirects
WHERE auth_client.client_id='molis-auth-console'
AND auth_client.application_id='00000000-0000-4000-8000-000000000001';
