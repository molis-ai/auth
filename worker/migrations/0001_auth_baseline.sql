-- Auth schema for a new D1 database. Register clients and environments separately.

CREATE TABLE auth_user (
 id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL CHECK(length(display_name) <= 120),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISABLED')), avatar_data TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 -- Account optimistic concurrency is separate from login-method security changes.
 -- Profile edits increment account_version without invalidating identity proofs.
 account_version INTEGER NOT NULL DEFAULT 0 CHECK(account_version>=0),
 identity_version INTEGER NOT NULL DEFAULT 0 CHECK(identity_version>=0),
 session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch>=0),
 revoked_before_seq INTEGER REFERENCES auth_security_sequence(seq),
 name_customized INTEGER NOT NULL DEFAULT 0,
 avatar_customized INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE auth_user_email (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES auth_user(id),
 canonical_email TEXT NOT NULL UNIQUE, verified_at INTEGER, created_at INTEGER NOT NULL
);

CREATE INDEX ix_user_email_user ON auth_user_email(user_id);

CREATE TABLE auth_local_credential (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_user(id), password_hash TEXT NOT NULL,
 changed_at INTEGER NOT NULL
);

CREATE TABLE auth_external_identity (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES auth_user(id),
 provider TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(issuer,subject)
);

CREATE INDEX ix_external_identity_user ON auth_external_identity(user_id);

CREATE TABLE auth_one_use (
 token_hash TEXT PRIMARY KEY NOT NULL,
 purpose TEXT NOT NULL,
 binding_hash TEXT NOT NULL,
 payload TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);

CREATE INDEX ix_one_use_expiration ON auth_one_use(expires_at);

CREATE TABLE auth_rate_bucket (
 bucket_hash TEXT PRIMARY KEY NOT NULL,
 hits INTEGER NOT NULL CHECK(hits > 0),
 expires_at INTEGER NOT NULL
);

CREATE INDEX ix_rate_bucket_expiration ON auth_rate_bucket(expires_at);

CREATE TABLE auth_application (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
 version INTEGER NOT NULL DEFAULT 0, is_console INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE auth_client (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, application_id TEXT NOT NULL REFERENCES auth_application(id),
 client_type TEXT NOT NULL CHECK(client_type IN ('WEB','MACOS','CLI')), status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
 version INTEGER NOT NULL DEFAULT 0, scopes TEXT NOT NULL, redirects TEXT NOT NULL
);

CREATE TABLE auth_audit_event (
 id TEXT PRIMARY KEY, action TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('SUCCESS','DENIED')),
 actor_user_id TEXT, target_user_id TEXT, space_id TEXT, application_id TEXT,
 request_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, change_summary TEXT, denial_reason TEXT
);

CREATE INDEX ix_audit_user_time ON auth_audit_event(target_user_id,occurred_at,id);

CREATE INDEX ix_audit_space_time ON auth_audit_event(space_id,occurred_at,id);

CREATE TABLE auth_write_guard (id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));

CREATE TABLE auth_environment (
 id TEXT PRIMARY KEY NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('LOCAL','TEST','PRODUCTION')),
 auth_origin TEXT NOT NULL CHECK(
   (substr(auth_origin,1,8)='https://' AND length(auth_origin)>8 AND instr(substr(auth_origin,9),'/')=0)
   OR (substr(auth_origin,1,7)='http://' AND length(auth_origin)>7 AND instr(substr(auth_origin,8),'/')=0)
 ),
 delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('MOCK','LIVE')),
 provider_mode TEXT NOT NULL CHECK(provider_mode IN ('MOCK','LIVE')),
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK(instr(auth_origin,'?')=0 AND instr(auth_origin,'#')=0 AND instr(auth_origin,'@')=0
   AND instr(auth_origin,' ')=0 AND instr(auth_origin,char(9))=0
   AND instr(auth_origin,char(10))=0 AND instr(auth_origin,char(13))=0),
 CHECK(kind<>'PRODUCTION' OR (delivery_mode='LIVE' AND provider_mode='LIVE' AND substr(auth_origin,1,8)='https://')),
 CHECK(substr(auth_origin,1,7)<>'http://' OR kind<>'PRODUCTION')
);

CREATE TABLE auth_client_policy (
 client_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_client(client_id),
 policy_profile TEXT NOT NULL CHECK(policy_profile='unified-account-v2'),
 environment_id TEXT NOT NULL REFERENCES auth_environment(id),
 allowed_origins TEXT NOT NULL CHECK(json_valid(allowed_origins) AND json_type(allowed_origins)='array'),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(client_id,environment_id)
);

CREATE INDEX ix_client_policy_environment ON auth_client_policy(environment_id,client_id);

CREATE TABLE auth_platform_permission (
 user_id TEXT NOT NULL REFERENCES auth_user(id),
 permission TEXT NOT NULL CHECK(length(permission) BETWEEN 1 AND 100),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
 granted_by TEXT NOT NULL REFERENCES auth_user(id),
 granted_at INTEGER NOT NULL,
 revoked_at INTEGER,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 PRIMARY KEY(user_id,permission),
 CHECK((status='ACTIVE' AND revoked_at IS NULL) OR (status='REVOKED' AND revoked_at IS NOT NULL))
);

CREATE TABLE auth_security_sequence (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 kind TEXT NOT NULL CHECK(kind IN ('TRANSACTION','REVOCATION')),
 created_at INTEGER NOT NULL
);

CREATE TABLE auth_user_phone (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES auth_user(id),
 canonical_phone TEXT NOT NULL UNIQUE CHECK(length(canonical_phone)=14
   AND substr(canonical_phone,1,4)='+861' AND substr(canonical_phone,4) NOT GLOB '*[^0-9]*'),
 verified_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);

CREATE INDEX ix_user_phone_user ON auth_user_phone(user_id);

CREATE TABLE auth_login_session (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES auth_user(id),
 client_id TEXT NOT NULL REFERENCES auth_client_policy(client_id),
 authenticated_at INTEGER NOT NULL,
 last_active_at INTEGER NOT NULL,
 absolute_expires_at INTEGER NOT NULL,
 user_epoch INTEGER NOT NULL CHECK(user_epoch>=0),
 session_revision INTEGER NOT NULL DEFAULT 0 CHECK(session_revision>=0),
 created_seq INTEGER NOT NULL REFERENCES auth_security_sequence(seq),
 revoked_at INTEGER, identity_verified_at INTEGER NOT NULL DEFAULT 0,
 CHECK(last_active_at>=authenticated_at AND last_active_at<absolute_expires_at),
 CHECK(absolute_expires_at=authenticated_at+7776000000),
 UNIQUE(id,user_id),
 UNIQUE(id,client_id)
);

CREATE INDEX ix_login_session_user ON auth_login_session(user_id,revoked_at,id);

CREATE INDEX ix_login_session_expiry ON auth_login_session(absolute_expires_at);

CREATE TABLE auth_login_access_token (
 token_hash TEXT PRIMARY KEY NOT NULL,
 login_session_id TEXT NOT NULL REFERENCES auth_login_session(id),
 session_revision INTEGER NOT NULL CHECK(session_revision>=0),
 user_epoch INTEGER NOT NULL CHECK(user_epoch>=0),
 expires_at INTEGER NOT NULL
);

CREATE INDEX ix_login_access_expiry ON auth_login_access_token(expires_at);

CREATE INDEX ix_login_access_session ON auth_login_access_token(login_session_id);

CREATE TABLE auth_login_refresh_token (
 token_hash TEXT PRIMARY KEY NOT NULL,
 login_session_id TEXT NOT NULL REFERENCES auth_login_session(id),
 generation INTEGER NOT NULL CHECK(generation>=0),
 session_revision INTEGER NOT NULL CHECK(session_revision>=0),
 user_epoch INTEGER NOT NULL CHECK(user_epoch>=0),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 used_at INTEGER,
 UNIQUE(login_session_id,generation)
);

CREATE UNIQUE INDEX uk_login_refresh_current ON auth_login_refresh_token(login_session_id) WHERE used_at IS NULL;

CREATE INDEX ix_login_refresh_expiry ON auth_login_refresh_token(expires_at);

CREATE TABLE auth_login_activity (
 login_session_id TEXT NOT NULL REFERENCES auth_login_session(id),
 event_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('OPEN','INTERACT')),
 PRIMARY KEY(login_session_id,event_id)
);

CREATE TABLE auth_verification_challenge (
 id TEXT PRIMARY KEY NOT NULL,
 transaction_id TEXT NOT NULL REFERENCES auth_product_transaction(id),
 channel TEXT NOT NULL CHECK(channel IN ('EMAIL','SMS')),
 canonical_target TEXT NOT NULL,
 credential_hash TEXT NOT NULL,
 delivery_id TEXT NOT NULL UNIQUE,
 delivery_status TEXT NOT NULL CHECK(delivery_status IN ('PENDING','ACCEPTED','FAILED')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 max_attempts INTEGER NOT NULL CHECK(max_attempts>0 AND attempts<=max_attempts),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 consumed_at INTEGER,
 invalidated_at INTEGER
, verifier TEXT NOT NULL DEFAULT 'LOCAL' CHECK(verifier IN ('LOCAL','ALIYUN')));

CREATE INDEX ix_verification_challenge_transaction ON auth_verification_challenge(transaction_id,created_at);

CREATE INDEX ix_verification_challenge_expiry ON auth_verification_challenge(expires_at);

CREATE TABLE auth_identity_proof (
 token_hash TEXT PRIMARY KEY NOT NULL,
 transaction_id TEXT NOT NULL REFERENCES auth_product_transaction(id),
 kind TEXT NOT NULL CHECK(kind IN ('VERIFICATION','LOGIN_CODE','OPERATION','NEW_IDENTITY','RESET')),
 binding_hash TEXT NOT NULL,
 user_id TEXT REFERENCES auth_user(id),
 login_session_id TEXT,
 user_epoch INTEGER CHECK(user_epoch>=0),
 identity_version INTEGER CHECK(identity_version>=0),
 session_revision INTEGER CHECK(session_revision>=0),
 verified_identity TEXT CHECK(verified_identity IS NULL OR (json_valid(verified_identity) AND json_type(verified_identity)='object')),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 consumed_at INTEGER,
 FOREIGN KEY(login_session_id,user_id) REFERENCES auth_login_session(id,user_id),
 CHECK(kind NOT IN ('LOGIN_CODE','OPERATION','NEW_IDENTITY','RESET') OR (user_id IS NOT NULL AND user_epoch IS NOT NULL)),
 CHECK(kind<>'OPERATION' OR (login_session_id IS NOT NULL AND session_revision IS NOT NULL AND identity_version IS NOT NULL))
);

CREATE INDEX ix_identity_proof_expiry ON auth_identity_proof(expires_at);

CREATE INDEX ix_identity_proof_transaction ON auth_identity_proof(transaction_id,kind);

CREATE TABLE auth_tenant (
 id TEXT PRIMARY KEY NOT NULL,
 name TEXT NOT NULL CHECK(length(name) <= 120),
 created_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 entitlement_revision INTEGER NOT NULL DEFAULT 0 CHECK(entitlement_revision>=0),
 managed_by TEXT NOT NULL REFERENCES auth_user(id),
 managed_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);

CREATE TABLE auth_tenant_membership (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL REFERENCES auth_tenant(id),
 user_id TEXT NOT NULL REFERENCES auth_user(id),
 role TEXT NOT NULL CHECK(role IN ('OWNER','ADMIN','MEMBER')),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','LEFT','REMOVED')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 joined_at INTEGER NOT NULL,
 ended_at INTEGER,
 CHECK((status='ACTIVE' AND ended_at IS NULL) OR (status IN ('LEFT','REMOVED') AND ended_at IS NOT NULL)),
 UNIQUE(id,tenant_id),
 UNIQUE(id,tenant_id,user_id)
);

CREATE UNIQUE INDEX uk_tenant_current_member ON auth_tenant_membership(tenant_id,user_id) WHERE status='ACTIVE';

CREATE UNIQUE INDEX uk_tenant_current_owner ON auth_tenant_membership(tenant_id) WHERE status='ACTIVE' AND role='OWNER';

CREATE INDEX ix_tenant_membership_user ON auth_tenant_membership(user_id,status,tenant_id);

CREATE TABLE auth_tenant_invitation (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL REFERENCES auth_tenant(id),
 target_kind TEXT NOT NULL CHECK(target_kind IN ('EMAIL','PHONE','USER')),
 target_email TEXT,
 target_phone TEXT,
 target_user_id TEXT REFERENCES auth_user(id),
 inviter_membership_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','ACCEPTED','DECLINED','REVOKED','EXPIRED')),
 accepted_membership_id TEXT,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 resolved_at INTEGER,
 FOREIGN KEY(inviter_membership_id,tenant_id) REFERENCES auth_tenant_membership(id,tenant_id),
 FOREIGN KEY(accepted_membership_id,tenant_id) REFERENCES auth_tenant_membership(id,tenant_id),
 CHECK((target_kind='EMAIL' AND target_email IS NOT NULL AND target_phone IS NULL AND target_user_id IS NULL)
   OR (target_kind='PHONE' AND target_phone IS NOT NULL AND target_email IS NULL AND target_user_id IS NULL)
   OR (target_kind='USER' AND target_user_id IS NOT NULL AND target_email IS NULL AND target_phone IS NULL)),
 CHECK(status<>'ACCEPTED' OR accepted_membership_id IS NOT NULL)
);

CREATE INDEX ix_tenant_invitation_scope ON auth_tenant_invitation(tenant_id,status,created_at,id);

CREATE INDEX ix_tenant_invitation_user ON auth_tenant_invitation(target_user_id,status,expires_at);

CREATE INDEX ix_tenant_invitation_email ON auth_tenant_invitation(target_email,status,expires_at);

CREATE INDEX ix_tenant_invitation_phone ON auth_tenant_invitation(target_phone,status,expires_at);

CREATE TABLE auth_ownership_transfer (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL REFERENCES auth_tenant(id),
 from_membership_id TEXT NOT NULL,
 to_membership_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','ACCEPTED','CANCELLED','EXPIRED')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 resolved_at INTEGER,
 FOREIGN KEY(from_membership_id,tenant_id) REFERENCES auth_tenant_membership(id,tenant_id),
 FOREIGN KEY(to_membership_id,tenant_id) REFERENCES auth_tenant_membership(id,tenant_id),
 CHECK(from_membership_id<>to_membership_id)
);

CREATE UNIQUE INDEX uk_tenant_pending_transfer ON auth_ownership_transfer(tenant_id) WHERE status='PENDING';

CREATE TABLE auth_management_result (
 actor_user_id TEXT NOT NULL REFERENCES auth_user(id),
 client_id TEXT NOT NULL REFERENCES auth_client_policy(client_id),
 operation TEXT NOT NULL,
 target TEXT NOT NULL,
 idempotency_key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 response_json TEXT NOT NULL CHECK(json_valid(response_json) AND json_type(response_json)='object'),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 PRIMARY KEY(actor_user_id,client_id,operation,target,idempotency_key_hash)
);

CREATE INDEX ix_management_result_expiry ON auth_management_result(expires_at);

CREATE TABLE auth_logout_receipt (
 request_key_hash TEXT PRIMARY KEY NOT NULL,
 proof_hash TEXT NOT NULL,
 login_session_id TEXT NOT NULL REFERENCES auth_login_session(id),
 scope TEXT NOT NULL CHECK(scope IN ('CURRENT_LOGIN','ALL_MOLIS_PRODUCTS')),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at)
);

CREATE INDEX ix_logout_receipt_expiry ON auth_logout_receipt(expires_at);

CREATE TABLE auth_management_audit (
 id TEXT PRIMARY KEY NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES auth_user(id),
 client_id TEXT NOT NULL REFERENCES auth_client_policy(client_id),
 tenant_id TEXT REFERENCES auth_tenant(id),
 operation TEXT NOT NULL,
 target_type TEXT NOT NULL,
 target_id TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('SUCCESS','DENIED')),
 reason TEXT,
 change_summary TEXT CHECK(change_summary IS NULL OR (json_valid(change_summary) AND json_type(change_summary)='object')),
 request_id TEXT NOT NULL,
 occurred_at INTEGER NOT NULL
);

CREATE INDEX ix_management_audit_tenant ON auth_management_audit(tenant_id,occurred_at,id);

CREATE INDEX ix_management_audit_actor ON auth_management_audit(actor_user_id,occurred_at,id);

CREATE TABLE auth_mock_delivery (
 delivery_id TEXT PRIMARY KEY NOT NULL,
 environment_id TEXT NOT NULL REFERENCES auth_environment(id),
 channel TEXT NOT NULL CHECK(channel IN ('EMAIL','SMS')),
 destination TEXT NOT NULL,
 template_key TEXT NOT NULL,
 credential TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at)
);

CREATE INDEX ix_mock_delivery_expiry ON auth_mock_delivery(expires_at);

CREATE TABLE auth_mock_provider_account (
 id TEXT PRIMARY KEY NOT NULL,
 environment_id TEXT NOT NULL REFERENCES auth_environment(id),
 provider TEXT NOT NULL CHECK(provider IN ('GOOGLE','GITHUB')),
 subject TEXT NOT NULL,
 label TEXT NOT NULL,
 email TEXT,
 email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
 UNIQUE(environment_id,provider,subject)
);

CREATE TABLE auth_mock_notification (
 delivery_id TEXT PRIMARY KEY NOT NULL,
 environment_id TEXT NOT NULL REFERENCES auth_environment(id),
 channel TEXT NOT NULL CHECK(channel IN ('EMAIL','SMS')),
 destination TEXT NOT NULL,
 template_key TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object'),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at)
);

CREATE INDEX ix_mock_notification_expiry ON auth_mock_notification(expires_at);

CREATE TABLE auth_client_product (
 client_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_client_policy(client_id),
 product TEXT NOT NULL CHECK(product IN ('WORK','CLUB')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);

CREATE TABLE auth_web_session (
 id_hash TEXT PRIMARY KEY NOT NULL,
 payload TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 status TEXT NOT NULL CHECK(status IN ('READY','BUSY')),
 expires_at INTEGER NOT NULL
, busy_until INTEGER NOT NULL DEFAULT 0 CHECK (busy_until >= 0));

CREATE INDEX ix_web_session_expiry ON auth_web_session(expires_at);

CREATE TABLE auth_external_profile (
 issuer TEXT NOT NULL, subject TEXT NOT NULL,
 display_name TEXT, email TEXT, avatar_url TEXT, username TEXT,
 PRIMARY KEY (issuer,subject),
 FOREIGN KEY (issuer,subject) REFERENCES auth_external_identity(issuer,subject) ON DELETE CASCADE
);

CREATE TABLE "auth_product_transaction" (
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

CREATE INDEX ix_product_transaction_expiry ON auth_product_transaction(expires_at);

CREATE INDEX ix_product_transaction_user ON auth_product_transaction(user_id,status);

CREATE TABLE auth_management_handoff (
 id TEXT PRIMARY KEY NOT NULL,
 source_session TEXT NOT NULL REFERENCES auth_login_session(id),
 source_revision INTEGER NOT NULL,
 source_client TEXT NOT NULL,
 redirect_uri TEXT NOT NULL,
 initiator_challenge TEXT NOT NULL,
 browser_hash TEXT,
 code_hash TEXT,
 expires_at INTEGER NOT NULL,
 consumed_at INTEGER
);

CREATE INDEX ix_management_handoff_expiry ON auth_management_handoff(expires_at);

CREATE INDEX ix_logout_receipt_proof_expiry
ON auth_logout_receipt(proof_hash, expires_at);

CREATE INDEX ix_ownership_transfer_from ON auth_ownership_transfer(from_membership_id,id);
CREATE INDEX ix_ownership_transfer_to ON auth_ownership_transfer(to_membership_id,id);
CREATE INDEX ix_tenant_membership_tenant_status_id ON auth_tenant_membership(tenant_id,status,id);
CREATE INDEX ix_client_application_id ON auth_client(application_id,id);

CREATE INDEX ix_management_audit_time ON auth_management_audit(occurred_at DESC,id DESC);
CREATE INDEX ix_managed_tenant_time ON auth_tenant(managed_at DESC,id DESC);
-- ix_management_audit_tenant already covers tenant-scoped descending reads
-- via a reverse scan over (tenant_id, occurred_at, id).

CREATE INDEX ix_user_email_verified_order
    ON auth_user_email(user_id, created_at, id)
    WHERE verified_at IS NOT NULL;

CREATE INDEX ix_managed_tenant_status_time
    ON auth_tenant(status, managed_at DESC, id DESC);

CREATE INDEX ix_management_audit_outcome_time
    ON auth_management_audit(outcome, occurred_at DESC, id DESC);

CREATE INDEX ix_management_audit_operation_time
    ON auth_management_audit(operation, occurred_at DESC, id DESC);

CREATE INDEX ix_platform_permission_status_user ON auth_platform_permission(permission,status,user_id);
CREATE INDEX ix_management_audit_target_time ON auth_management_audit(target_id,occurred_at DESC,id DESC);
CREATE INDEX ix_user_status_id ON auth_user(status,id);
CREATE INDEX ix_tenant_membership_tenant_user_version ON auth_tenant_membership(tenant_id,user_id,version);
CREATE INDEX ix_tenant_invitation_tenant_id ON auth_tenant_invitation(tenant_id,id);
CREATE INDEX ix_invitation_cleanup ON auth_tenant_invitation(expires_at,id) WHERE status IN ('PENDING','EXPIRED');
CREATE INDEX ix_transfer_cleanup ON auth_ownership_transfer(expires_at,id) WHERE status IN ('PENDING','EXPIRED');
CREATE INDEX ix_logout_receipt_session ON auth_logout_receipt(login_session_id);
CREATE INDEX ix_identity_proof_session ON auth_identity_proof(login_session_id) WHERE login_session_id IS NOT NULL;
CREATE INDEX ix_product_transaction_session ON auth_product_transaction(login_session_id) WHERE login_session_id IS NOT NULL;
CREATE INDEX ix_management_handoff_source ON auth_management_handoff(source_session);
