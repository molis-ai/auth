-- Current unified-account-v2 schema for a fresh database.
-- Shared user/client/tenant identity tables are created by the preceding files.
-- All stored times are UTC epoch milliseconds.
-- Aggregate transitions use guarded D1 batches in their owning domain. This migration
-- supplies constraints and history, not authentication or subscription endpoints.

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

-- client_id is the public, unique auth_client.client_id, not auth_client.id.
-- A registered V2 policy is required. Redirects are owned by auth_client.redirects
-- and are validated together with this environment.
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

-- Allocate sequence numbers in the same batch as transaction creation or revocation.
-- A server sequence, unlike client clocks, orders anonymous pending transactions
-- against a later account-wide revocation once their user is known.
CREATE TABLE auth_security_sequence (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 kind TEXT NOT NULL CHECK(kind IN ('TRANSACTION','REVOCATION')),
 created_at INTEGER NOT NULL
);
CREATE TABLE auth_user_security (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_user(id),
 -- Account optimistic concurrency is separate from login-method security changes.
 -- Profile edits increment account_version without invalidating identity proofs.
 account_version INTEGER NOT NULL DEFAULT 0 CHECK(account_version>=0),
 identity_version INTEGER NOT NULL DEFAULT 0 CHECK(identity_version>=0),
 session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch>=0),
 revoked_before_seq INTEGER REFERENCES auth_security_sequence(seq),
 updated_at INTEGER NOT NULL
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

-- Every access and refresh token belongs to an explicit V2 login session.
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
 revoked_at INTEGER,
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
 received_at INTEGER NOT NULL,
 PRIMARY KEY(login_session_id,event_id)
);

CREATE TABLE auth_product_transaction (
 id TEXT PRIMARY KEY NOT NULL,
 client_id TEXT NOT NULL,
 environment_id TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('LOGIN','EMAIL_SIGNUP','REAUTH','BIND','REPLACE','PASSWORD_RESET')),
 method TEXT NOT NULL CHECK(method IN ('EMAIL_PASSWORD','PHONE_OTP','GOOGLE','GITHUB','EMAIL_CODE')),
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
 FOREIGN KEY(client_id,environment_id) REFERENCES auth_client_policy(client_id,environment_id),
 FOREIGN KEY(login_session_id,user_id) REFERENCES auth_login_session(id,user_id),
 FOREIGN KEY(login_session_id,client_id) REFERENCES auth_login_session(id,client_id),
 CHECK((purpose='LOGIN' AND method IN ('EMAIL_PASSWORD','PHONE_OTP','GOOGLE','GITHUB'))
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
CREATE TABLE auth_verification_challenge (
 id TEXT PRIMARY KEY NOT NULL,
 transaction_id TEXT NOT NULL REFERENCES auth_product_transaction(id),
 channel TEXT NOT NULL CHECK(channel IN ('EMAIL','SMS')),
 canonical_target TEXT NOT NULL,
 credential_hash TEXT NOT NULL,
 delivery_id TEXT NOT NULL UNIQUE,
 delivery_status TEXT NOT NULL CHECK(delivery_status IN ('PENDING','ACCEPTED','FAILED','UNKNOWN')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 max_attempts INTEGER NOT NULL CHECK(max_attempts>0 AND attempts<=max_attempts),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 next_send_at INTEGER NOT NULL CHECK(next_send_at>=created_at),
 consumed_at INTEGER,
 invalidated_at INTEGER
);
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

-- A managed tenant extends a TEAM explicitly. Its lifecycle and membership owner
-- is the current tenant domain; it has exactly one membership lifecycle.
CREATE UNIQUE INDEX uk_space_id_type ON auth_space(id,space_type);
CREATE TABLE auth_managed_tenant (
 space_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_space(id),
 space_type TEXT NOT NULL DEFAULT 'TEAM' CHECK(space_type='TEAM'),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 entitlement_revision INTEGER NOT NULL DEFAULT 0 CHECK(entitlement_revision>=0),
 managed_by TEXT NOT NULL REFERENCES auth_user(id),
 managed_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 FOREIGN KEY(space_id,space_type) REFERENCES auth_space(id,space_type)
);
CREATE TABLE auth_tenant_membership (
 id TEXT PRIMARY KEY NOT NULL,
 tenant_id TEXT NOT NULL REFERENCES auth_managed_tenant(space_id),
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
 tenant_id TEXT NOT NULL REFERENCES auth_managed_tenant(space_id),
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
 tenant_id TEXT NOT NULL REFERENCES auth_managed_tenant(space_id),
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

CREATE TABLE billing_feature (
 id TEXT PRIMARY KEY NOT NULL,
 product TEXT NOT NULL CHECK(product IN ('WORK','CLUB','SHARED')),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 created_at INTEGER NOT NULL
);
CREATE TABLE billing_seat_type (
 id TEXT PRIMARY KEY NOT NULL,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 created_at INTEGER NOT NULL
);
CREATE TABLE billing_plan_version (
 plan_id TEXT NOT NULL,
 plan_version INTEGER NOT NULL CHECK(plan_version>0),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 created_by TEXT NOT NULL REFERENCES auth_user(id),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(plan_id,plan_version)
);
CREATE TABLE billing_plan_personal_feature (
 plan_id TEXT NOT NULL,
 plan_version INTEGER NOT NULL,
 feature_id TEXT NOT NULL REFERENCES billing_feature(id),
 PRIMARY KEY(plan_id,plan_version,feature_id),
 FOREIGN KEY(plan_id,plan_version) REFERENCES billing_plan_version(plan_id,plan_version)
);
CREATE TABLE billing_plan_seat_type (
 plan_id TEXT NOT NULL,
 plan_version INTEGER NOT NULL,
 seat_type_id TEXT NOT NULL REFERENCES billing_seat_type(id),
 PRIMARY KEY(plan_id,plan_version,seat_type_id),
 FOREIGN KEY(plan_id,plan_version) REFERENCES billing_plan_version(plan_id,plan_version)
);
CREATE TABLE billing_plan_seat_feature (
 plan_id TEXT NOT NULL,
 plan_version INTEGER NOT NULL,
 seat_type_id TEXT NOT NULL,
 feature_id TEXT NOT NULL REFERENCES billing_feature(id),
 PRIMARY KEY(plan_id,plan_version,seat_type_id,feature_id),
 FOREIGN KEY(plan_id,plan_version,seat_type_id) REFERENCES billing_plan_seat_type(plan_id,plan_version,seat_type_id)
);
CREATE TABLE billing_subscription (
 id TEXT PRIMARY KEY NOT NULL,
 owner_user_id TEXT REFERENCES auth_user(id),
 owner_tenant_id TEXT REFERENCES auth_managed_tenant(space_id),
 plan_id TEXT NOT NULL,
 plan_version INTEGER NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 starts_at INTEGER NOT NULL,
 ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 FOREIGN KEY(plan_id,plan_version) REFERENCES billing_plan_version(plan_id,plan_version),
 CHECK((owner_user_id IS NOT NULL AND owner_tenant_id IS NULL) OR (owner_user_id IS NULL AND owner_tenant_id IS NOT NULL)),
 UNIQUE(id,owner_tenant_id)
);
CREATE INDEX ix_subscription_user ON billing_subscription(owner_user_id,ends_at,id);
CREATE INDEX ix_subscription_tenant ON billing_subscription(owner_tenant_id,ends_at,id);
CREATE TABLE billing_seat_pool (
 subscription_id TEXT NOT NULL,
 tenant_id TEXT NOT NULL,
 seat_type_id TEXT NOT NULL REFERENCES billing_seat_type(id),
 quantity INTEGER NOT NULL CHECK(quantity>=0),
 status TEXT NOT NULL DEFAULT 'CURRENT' CHECK(status IN ('CURRENT','RETIRED')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 PRIMARY KEY(subscription_id,seat_type_id),
 FOREIGN KEY(subscription_id,tenant_id) REFERENCES billing_subscription(id,owner_tenant_id),
 CHECK(status<>'RETIRED' OR quantity=0),
 UNIQUE(subscription_id,seat_type_id,tenant_id)
);
-- assignedCount is derived from ASSIGNED rows, not another mutable counter.
-- Retire an empty removed pool instead of deleting history referenced by assignments.
CREATE TABLE billing_seat_assignment (
 id TEXT PRIMARY KEY NOT NULL,
 subscription_id TEXT NOT NULL,
 seat_type_id TEXT NOT NULL,
 tenant_id TEXT NOT NULL,
 membership_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ASSIGNED','ENDED')),
 assigned_at INTEGER NOT NULL,
 ended_at INTEGER,
 end_reason TEXT CHECK(end_reason IN ('RELEASED','REASSIGNED','MEMBER_LEFT','MEMBER_REMOVED')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 FOREIGN KEY(subscription_id,seat_type_id,tenant_id) REFERENCES billing_seat_pool(subscription_id,seat_type_id,tenant_id),
 FOREIGN KEY(membership_id,tenant_id,user_id) REFERENCES auth_tenant_membership(id,tenant_id,user_id),
 CHECK((status='ASSIGNED' AND ended_at IS NULL AND end_reason IS NULL)
   OR (status='ENDED' AND ended_at IS NOT NULL AND end_reason IS NOT NULL))
);
CREATE UNIQUE INDEX uk_seat_current_assignment ON billing_seat_assignment(subscription_id,seat_type_id,membership_id) WHERE status='ASSIGNED';
CREATE INDEX ix_seat_assignment_member ON billing_seat_assignment(membership_id,status,id);
CREATE INDEX ix_seat_assignment_tenant ON billing_seat_assignment(tenant_id,status,assigned_at,id);

-- Only no-secret response summaries belong in these records. Authorization must
-- be rechecked before reading a replay, except the minimal logout receipt contract.
CREATE TABLE auth_management_result (
 actor_user_id TEXT NOT NULL REFERENCES auth_user(id),
 client_id TEXT NOT NULL REFERENCES auth_client_policy(client_id),
 operation TEXT NOT NULL,
 target TEXT NOT NULL,
 idempotency_key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 response_status INTEGER NOT NULL CHECK(response_status BETWEEN 200 AND 499),
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
 revoked_seq INTEGER NOT NULL REFERENCES auth_security_sequence(seq),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX ix_logout_receipt_expiry ON auth_logout_receipt(expires_at);
CREATE TABLE auth_management_audit (
 id TEXT PRIMARY KEY NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES auth_user(id),
 client_id TEXT NOT NULL REFERENCES auth_client_policy(client_id),
 tenant_id TEXT REFERENCES auth_managed_tenant(space_id),
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
