-- Existing challenges remain local; remote verification is pinned when the challenge is created.
ALTER TABLE auth_verification_challenge ADD COLUMN verifier TEXT NOT NULL DEFAULT 'LOCAL' CHECK(verifier IN ('LOCAL','ALIYUN'));
