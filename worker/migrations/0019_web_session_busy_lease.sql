ALTER TABLE auth_web_session
ADD COLUMN busy_until INTEGER NOT NULL DEFAULT 0 CHECK (busy_until >= 0);
