-- Provider display metadata is separate from login identity and verified local email.
CREATE TABLE auth_external_profile (
 issuer TEXT NOT NULL, subject TEXT NOT NULL,
 display_name TEXT, email TEXT, avatar_url TEXT,
 PRIMARY KEY (issuer,subject),
 FOREIGN KEY (issuer,subject) REFERENCES auth_external_identity(issuer,subject) ON DELETE CASCADE
);
CREATE TABLE auth_profile_customization (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_user(id),
 name_customized INTEGER NOT NULL DEFAULT 0,
 avatar_customized INTEGER NOT NULL DEFAULT 0
);
-- Existing edited profiles predate explicit flags; preserve their choices conservatively.
INSERT INTO auth_profile_customization(user_id,name_customized,avatar_customized)
SELECT id,1,1 FROM auth_user WHERE updated_at>created_at;
