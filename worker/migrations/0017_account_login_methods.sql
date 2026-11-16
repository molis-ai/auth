-- Extend login methods without discarding existing transactions or proofs.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE auth_product_transaction_new (
 id TEXT PRIMARY KEY NOT NULL,
 client_id TEXT NOT NULL,
 environment_id TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('LOGIN','EMAIL_SIGNUP','REAUTH','BIND','REPLACE','PASSWORD_RESET')),
 method TEXT NOT NULL CHECK(method IN ('ACCOUNT_PASSWORD','EMAIL_PASSWORD','PHONE_OTP','GOOGLE','GITHUB','EMAIL_CODE')),
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','VERIFIED','CONSUMED','CANCELLED','EXPIRED')),
 initiator_hash TEXT NOT NULL,
 redirect_uri TEXT NOT NULL CHECK(length(redirect_uri)>0 AND instr(redirect_uri,'#')=0),
 -- Product state is an opaque correlation value returned on the exact callback.
 -- Unlike a credential, its original value must be recoverable, not only its digest.
 product_state TEXT NOT NULL CHECK(length(product_state)>0),
 product_state_hash TEXT NOT NULL,
 pkce_challenge TEXT NOT NULL,
 user_id TEXT REFERENCES auth_user(id),
 login_session_id TEXT,
 user_epoch INTEGER CHECK(user_epoch>=0),
 session_revision INTEGER CHECK(session_revision>=0),
 operation TEXT,
 target TEXT,
 binding_id TEXT,
 provider_state_hash TEXT UNIQUE,
 -- Provider nonce/PKCE are independent of the product's PKCE challenge.
 -- Only a nonce digest and sealed provider verifier belong in this table.
 provider_nonce_hash TEXT,
 provider_pkce_verifier_sealed TEXT,
 browser_hash TEXT,
 created_seq INTEGER NOT NULL UNIQUE REFERENCES auth_security_sequence(seq),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 completed_at INTEGER,
 identity_version INTEGER CHECK(identity_version>=0),
 verified_identity TEXT CHECK(verified_identity IS NULL OR (json_valid(verified_identity) AND json_type(verified_identity)='object')),
 FOREIGN KEY(client_id,environment_id) REFERENCES auth_client_policy(client_id,environment_id),
 FOREIGN KEY(login_session_id,user_id) REFERENCES auth_login_session(id,user_id),
 FOREIGN KEY(login_session_id,client_id) REFERENCES auth_login_session(id,client_id),
 CHECK((purpose='LOGIN' AND method IN ('ACCOUNT_PASSWORD','EMAIL_CODE','EMAIL_PASSWORD','PHONE_OTP','GOOGLE','GITHUB'))
   OR (purpose IN ('EMAIL_SIGNUP','PASSWORD_RESET') AND method='EMAIL_CODE')
   OR (purpose='REAUTH' AND method IN ('EMAIL_PASSWORD','PHONE_OTP','GOOGLE','GITHUB'))
   OR (purpose IN ('BIND','REPLACE') AND method IN ('EMAIL_CODE','PHONE_OTP','GOOGLE','GITHUB'))),
 CHECK(purpose NOT IN ('REAUTH','BIND','REPLACE') OR
   (user_id IS NOT NULL AND login_session_id IS NOT NULL AND user_epoch IS NOT NULL AND session_revision IS NOT NULL)),
 CHECK(purpose<>'REAUTH' OR (operation IS NOT NULL AND target IS NOT NULL)),
 CHECK(purpose<>'REPLACE' OR binding_id IS NOT NULL)
);
INSERT INTO auth_product_transaction_new (id,client_id,environment_id,purpose,method,status,initiator_hash,redirect_uri,product_state,product_state_hash,pkce_challenge,user_id,login_session_id,user_epoch,session_revision,operation,target,binding_id,provider_state_hash,provider_nonce_hash,provider_pkce_verifier_sealed,browser_hash,created_seq,created_at,expires_at,completed_at,identity_version,verified_identity) SELECT id,client_id,environment_id,purpose,method,status,initiator_hash,redirect_uri,product_state,product_state_hash,pkce_challenge,user_id,login_session_id,user_epoch,session_revision,operation,target,binding_id,provider_state_hash,provider_nonce_hash,provider_pkce_verifier_sealed,browser_hash,created_seq,created_at,expires_at,completed_at,identity_version,verified_identity FROM auth_product_transaction;
DROP TABLE auth_product_transaction;
ALTER TABLE auth_product_transaction_new RENAME TO auth_product_transaction;
CREATE INDEX ix_product_transaction_expiry ON auth_product_transaction(expires_at);
CREATE INDEX ix_product_transaction_user ON auth_product_transaction(user_id,status);
PRAGMA defer_foreign_keys = OFF;
