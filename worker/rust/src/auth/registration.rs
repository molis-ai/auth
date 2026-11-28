//! Product-local email/password and phone transactions; verification never accepts a claimed actor.
use crate::{
    auth::login_sessions::{client, client_guard},
    core::contracts::unified_policy::default_integer as delivery_limit,
    core::http::*,
    core::identity::Auth,
    core::security::*,
    delivery::{self, Message},
};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Method};
const TX: i64 = 600000;
const CODE: i64 = 300000;
pub(crate) fn tx_guard(a: &Auth, t: &Value, n: i64, status: &str) -> Result<D1PreparedStatement> {
    if crate::auth::sensitive_transactions::protected(t) {
        return crate::auth::sensitive_transactions::guard(a, t, n, status);
    }
    a.s.guard(
        "EXISTS(SELECT 1 FROM auth_product_transaction WHERE id=? AND status=? AND expires_at>?)",
        vec![t["id"].clone(), status.into(), n.into()],
    )
}
pub(crate) fn boundary(a: &Auth, t: &Value, user: &str, epoch: i64) -> Result<D1PreparedStatement> {
    a.s.guard("EXISTS(SELECT 1 FROM auth_user u WHERE u.id=? AND u.status='ACTIVE' AND u.session_epoch=? AND COALESCE(u.revoked_before_seq,0)<?)",vec![user.into(),epoch.into(),t["created_seq"].clone()])
}
pub(crate) async fn transaction(a: &Auth, id: &str) -> Result<(Value, Value)> {
    let t =
        a.s.one(
            "SELECT * FROM auth_product_transaction WHERE id=?",
            vec![id.into()],
        )
        .await?;
    check_transaction(a, t).await
}
pub(crate) async fn challenge_transaction(a: &Auth, challenge_id: &str) -> Result<(Value, Value)> {
    let t = a.s.one(
        "SELECT t.* FROM auth_verification_challenge q JOIN auth_product_transaction t ON t.id=q.transaction_id WHERE q.id=?",
        vec![challenge_id.into()],
    ).await?;
    check_transaction(a, t).await
}
async fn check_transaction(a: &Auth, mut t: Value) -> Result<(Value, Value)> {
    let proof = a.header("X-Auth-Initiator-Proof");
    ensure(
        token(&proof) && !t.is_null() && t["initiator_hash"] == challenge(&proof),
        401,
        "INVALID_CREDENTIALS",
    )?;
    let c = client(a, &text(&t, "client_id")).await?;
    if crate::auth::sensitive_transactions::protected(&t) {
        let (s, _) = crate::auth::login_sessions::active(a).await?;
        t["_access_hash"] = s["access_hash"].clone();
        ensure(
            s["id"] == t["login_session_id"] && s["user_id"] == t["user_id"],
            403,
            "FORBIDDEN",
        )?;
    }
    ensure(
        t["environment_id"] == c["environment_id"]
            && contains(&parsed(&c, "redirects")?, &t["redirect_uri"]),
        403,
        "POLICY_MISMATCH",
    )?;
    Ok((t, c))
}
pub(crate) async fn begin(a: &Auth, b: &Value) -> Result<Value> {
    shape("CreateTransactionRequest", b)?;
    if crate::auth::sensitive_transactions::protected(b) {
        return crate::auth::sensitive_transactions::begin(a, b).await;
    }
    let (t, _) = begin_unprotected(a, b).await?;
    Ok(json!({
        "transactionId":t["id"],"status":t["status"],
        "nextStep":if t["method"]=="EMAIL_PASSWORD" || t["method"]=="ACCOUNT_PASSWORD"{"PASSWORD_LOGIN"}else if t["method"]=="GOOGLE" || t["method"]=="GITHUB"{"START_PROVIDER"}else{"REQUEST_CHALLENGE"},
        "expiresAt":iso(&t["expires_at"])
    }))
}
pub(crate) async fn begin_login(a: &Auth, b: &Value) -> Result<(Value, Value)> {
    shape("CreateTransactionRequest", b)?;
    ensure(b["purpose"] == "LOGIN", 400, "INVALID_REQUEST")?;
    begin_unprotected(a, b).await
}
async fn begin_unprotected(a: &Auth, b: &Value) -> Result<(Value, Value)> {
    ensure(
        (b["purpose"] == "LOGIN"
            && (b["method"] == "EMAIL_PASSWORD"
                || b["method"] == "ACCOUNT_PASSWORD"
                || b["method"] == "PHONE_OTP"
                || b["method"] == "EMAIL_CODE"
                || b["method"] == "GOOGLE"
                || b["method"] == "GITHUB"))
            || (b["purpose"] == "EMAIL_SIGNUP" && b["method"] == "EMAIL_CODE")
            || (b["purpose"] == "PASSWORD_RESET" && b["method"] == "EMAIL_CODE"),
        501,
        "UNIFIED_ACCOUNT_NOT_IMPLEMENTED",
    )?;
    let c = client(a, &text(b, "clientId")).await?;
    ensure(
        contains(&parsed(&c, "redirects")?, &b["redirectUri"]),
        400,
        "INVALID_REQUEST",
    )?;
    a.rate_ip("auth:begin", 60).await?;
    let n = now();
    let t = a.s.batch_returning(
        vec![client_guard(a,&c)?,a.s.statement("INSERT INTO auth_security_sequence(kind,created_at) VALUES ('TRANSACTION',?)",vec![n.into()])?],
        a.s.statement(
            "INSERT INTO auth_product_transaction(id,client_id,environment_id,purpose,method,initiator_hash,redirect_uri,product_state,product_state_hash,pkce_challenge,created_seq,created_at,expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,(SELECT MAX(seq) FROM auth_security_sequence),?,?)
            RETURNING id,client_id,environment_id,purpose,method,product_state,created_seq,expires_at,status",
            vec![uuid().into(),c["client_id"].clone(),c["environment_id"].clone(),b["purpose"].clone(),b["method"].clone(),b["initiatorChallenge"].clone(),b["redirectUri"].clone(),b["state"].clone(),hash(&text(b,"state")).into(),b["codeChallenge"].clone(),n.into(),(n+TX).into()],
        )?,
        "VERSION_CONFLICT",
    ).await?;
    Ok((t, c))
}
fn otp() -> Result<String> {
    loop {
        let digest = hash(&secret());
        let prefix = digest.get(..8).ok_or_else(Failure::unavailable)?;
        let value = u32::from_str_radix(prefix, 16).map_err(|_| Failure::unavailable())?;
        if value < 4_294_000_000 {
            return Ok(format!("{:06}", value % 1_000_000));
        }
    }
}
pub(crate) async fn send(a: &Auth, t: &Value, c: &Value, b: &Value) -> Result<Value> {
    shape("ChallengeRequest", b)?;
    ensure(
        (t["method"] == "EMAIL_CODE" && b["channel"] == "EMAIL")
            || (t["method"] == "PHONE_OTP" && b["channel"] == "SMS"),
        400,
        "INVALID_REQUEST",
    )?;
    let target = if b["channel"] == "EMAIL" {
        email(&b["address"])?
    } else {
        text(b, "address")
    };
    crate::auth::test_admission::Admission::load(a)?.target(&target)?;
    ensure(
        c["delivery_mode"] == "LIVE"
            || crate::delivery::supports_mock_delivery(&c["kind"], &c["delivery_mode"]),
        503,
        "UPSTREAM_UNAVAILABLE",
    )?;
    if t["purpose"] == "REAUTH" {
        ensure(
            !a.s.one(
                "SELECT id FROM auth_user_phone WHERE user_id=? AND canonical_phone=?",
                vec![t["user_id"].clone(), target.clone().into()],
            )
            .await?
            .is_null(),
            401,
            "INVALID_CREDENTIALS",
        )?;
    }
    let channel = text(b, "channel");
    let subject = format!("{channel}:{target}");
    let window = delivery_limit("sendQuotaWindowSeconds") * 1000;
    let reserved_at = a
        .rate_batch(&[
            ("delivery:ip", &a.client_ip, 60, 60_000),
            (
                "delivery:ip-hour",
                &a.client_ip,
                delivery_limit("sendQuotaPerIp"),
                window,
            ),
            (
                "delivery:target",
                &subject,
                delivery_limit("sendQuotaPerTarget"),
                window,
            ),
            (
                "delivery:client",
                &text(c, "client_id"),
                delivery_limit("sendQuotaPerClient"),
                window,
            ),
            ("delivery:resend", &subject, 1, 60_000),
        ])
        .await?;
    let n = now();
    let id = uuid();
    let delivery = uuid();
    let credential = otp()?;
    let expires = (n + CODE).min(number(t, "expires_at"));
    let m = Message {
        #[cfg(feature = "mock-delivery")]
        id: &delivery,
        target: &target,
        template: t["purpose"].as_str().unwrap_or("PHONE_LOGIN"),
        credential: &credential,
        expires,
    };
    let mut writes=vec![client_guard(a,c)?,tx_guard(a,t,n,"PENDING")?,a.s.statement("UPDATE auth_verification_challenge SET invalidated_at=? WHERE transaction_id=? AND invalidated_at IS NULL",vec![n.into(),t["id"].clone()])?,a.s.statement("UPDATE auth_identity_proof SET consumed_at=? WHERE transaction_id=? AND kind='VERIFICATION' AND consumed_at IS NULL",vec![n.into(),t["id"].clone()])?,a.s.statement("INSERT INTO auth_verification_challenge(id,transaction_id,channel,canonical_target,credential_hash,delivery_id,delivery_status,max_attempts,created_at,expires_at) VALUES (?,?,?,?,?,?,'ACCEPTED',5,?,?)",vec![id.clone().into(),t["id"].clone(),channel.clone().into(),target.clone().into(),hash(&format!("{id}:{credential}")).into(),delivery.clone().into(),n.into(),expires.into()])?];
    // Unknown reset targets get the same accepted response, without delivery or account creation.
    let password_reset = t["purpose"] == "PASSWORD_RESET";
    let deliver = if password_reset {
        !a.s.one("SELECT e.id FROM auth_user_email e JOIN auth_user u ON u.id=e.user_id WHERE e.canonical_email=? AND e.verified_at IS NOT NULL AND u.status='ACTIVE'",vec![target.clone().into()]).await?.is_null()
    } else {
        true
    };
    let receipt = json!({"challengeId":id,"expiresAt":iso(&json!(expires)),"retryAfterSeconds":60});
    if c["delivery_mode"] == "LIVE" {
        if channel == "SMS" {
            writes.push(a.s.statement("UPDATE auth_verification_challenge SET verifier='ALIYUN',credential_hash='',delivery_status='PENDING' WHERE id=?",vec![id.clone().into()])?);
        } else {
            writes.push(a.s.statement(
                "UPDATE auth_verification_challenge SET delivery_status='PENDING' WHERE id=?",
                vec![id.clone().into()],
            )?);
        }
        a.s.batch(writes, "VERSION_CONFLICT").await?;
        if !deliver {
            return Ok(receipt);
        }
        let delivery_started = now();
        let sent = crate::delivery::send_live(a, t, c, &channel, &id, &m).await;
        crate::core::telemetry::verification(
            a,
            "auth.verification.sent",
            &channel,
            true,
            delivery_started,
            &sent,
        );
        if let Err(error) = sent {
            if password_reset {
                a.s.log_failure("mail.password_reset", &error, delivery_started);
                // Keep the challenge pending so even a late delivery cannot authorize a reset.
                return Ok(receipt);
            }
            // Release only this failed resend reservation. Other quotas still account for the attempt.
            if let Err(release) =
                a.s.run(
                    "DELETE FROM auth_rate_bucket WHERE bucket_hash=? AND expires_at=?",
                    vec![
                        hash(&format!("delivery:resend:{subject}")).into(),
                        (reserved_at + 60_000).into(),
                    ],
                )
                .await
            {
                a.s.log_failure("delivery.resend_release", &release, delivery_started);
            }
            return Err(error);
        }
        let completed = now();
        a.s.batch(vec![client_guard(a,c)?,tx_guard(a,t,completed,"PENDING")?,a.s.guard("EXISTS(SELECT 1 FROM auth_verification_challenge WHERE id=? AND invalidated_at IS NULL AND expires_at>?)",vec![id.clone().into(),completed.into()])?,a.s.statement("UPDATE auth_verification_challenge SET delivery_status='ACCEPTED' WHERE id=?",vec![id.clone().into()])?],"VERSION_CONFLICT").await?;
        return Ok(receipt);
    }
    let started = now();
    if deliver {
        writes.push(delivery::enqueue_mock(a, c, &m, &channel)?);
    }
    let result = a.s.batch(writes, "VERSION_CONFLICT").await;
    if deliver {
        crate::core::telemetry::verification(
            a,
            "auth.verification.sent",
            &channel,
            false,
            started,
            &result,
        );
    }
    result?;
    Ok(receipt)
}
pub(crate) async fn authenticate_challenge(
    a: &Auth,
    t: &Value,
    c: &Value,
    q: &Value,
    id: &str,
    credential: &str,
) -> Result<()> {
    let n = now();
    ensure(
        !q.is_null()
            && q["delivery_status"] == "ACCEPTED"
            && q["consumed_at"].is_null()
            && q["invalidated_at"].is_null()
            && number(q, "expires_at") > n
            && number(q, "attempts") < 5,
        401,
        "INVALID_CREDENTIALS",
    )?;
    crate::auth::test_admission::Admission::load(a)?.target(&text(q, "canonical_target"))?;
    let remote = q["verifier"] == "ALIYUN";
    let supported = if remote {
        c["delivery_mode"] == "LIVE"
    } else {
        crate::delivery::supports_mock_delivery(&c["kind"], &c["delivery_mode"])
            || (c["delivery_mode"] == "LIVE" && q["channel"] == "EMAIL")
    };
    ensure(supported, 503, "UPSTREAM_UNAVAILABLE")?;
    // Claim one attempt before comparing any credential. The transaction guard
    // and conditional update serialize competing checks on the same challenge.
    let started = now();
    a.s.batch(vec![
        client_guard(a,c)?,
        tx_guard(a,t,started,"PENDING")?,
        a.s.guard(
            "EXISTS(SELECT 1 FROM auth_verification_challenge
             WHERE id=? AND consumed_at IS NULL AND invalidated_at IS NULL AND attempts<max_attempts AND expires_at>?)",
            vec![id.into(),started.into()],
        )?,
        a.s.statement("UPDATE auth_verification_challenge SET attempts=attempts+1 WHERE id=?",vec![id.into()])?,
    ], "VERSION_CONFLICT").await?;
    let matched = if remote {
        crate::delivery::sms_auth::verify(a, id, &text(q, "canonical_target"), credential).await?
    } else {
        q["credential_hash"] == hash(&format!("{id}:{}", credential))
    };
    ensure(matched, 401, "INVALID_CREDENTIALS")?;
    Ok(())
}

pub(crate) async fn verify(a: &Auth, t: &Value, c: &Value, id: &str, b: &Value) -> Result<Value> {
    let started = now();
    shape("VerifyChallengeRequest", b)?;
    a.rate_ip("auth:verify", 120).await?;
    let q =
        a.s.one(
            "SELECT * FROM auth_verification_challenge WHERE id=? AND transaction_id=?",
            vec![id.into(), t["id"].clone()],
        )
        .await?;
    authenticate_challenge(a, t, c, &q, id, &text(b, "credential")).await?;
    let n = now();
    let proof = secret();
    let expires = (n + CODE).min(number(t, "expires_at"));
    let target = text(&q, "canonical_target");
    // Check ownership before revealing a conflict, and before asking for a password.
    if t["purpose"] == "EMAIL_SIGNUP" {
        let existing =
            a.s.one(
                "SELECT id FROM auth_user_email WHERE canonical_email=?",
                vec![target.clone().into()],
            )
            .await?;
        ensure(existing.is_null(), 409, "IDENTITY_IN_USE")?;
    }
    let mut writes=vec![client_guard(a,c)?,tx_guard(a,t,n,"PENDING")?,a.s.guard("EXISTS(SELECT 1 FROM auth_verification_challenge WHERE id=? AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>?)",vec![id.into(),n.into()])?,a.s.statement("UPDATE auth_verification_challenge SET consumed_at=? WHERE id=?",vec![n.into(),id.into()])?,a.s.statement("INSERT INTO auth_identity_proof(token_hash,transaction_id,kind,binding_hash,verified_identity,created_at,expires_at) VALUES (?,?,'VERIFICATION',?,?,?,?)",vec![hash(&proof).into(),t["id"].clone(),hash(id).into(),json!({"channel":q["channel"],"target":target}).to_string().into(),n.into(),expires.into()])?];
    if crate::auth::sensitive_transactions::protected(t) {
        writes.extend(
            crate::auth::sensitive_transactions::verified(
                a,
                t,
                &json!({"type":if q["channel"]=="EMAIL"{"EMAIL"}else{"PHONE"},"target":target}),
                n,
            )
            .await?,
        );
    }
    if t["purpose"] == "PASSWORD_RESET" {
        let user=a.s.one("SELECT e.id binding_id,e.user_id,u.session_epoch,u.identity_version FROM auth_user_email e JOIN auth_user u ON u.id=e.user_id WHERE e.canonical_email=? AND e.verified_at IS NOT NULL AND u.status='ACTIVE'",vec![target.into()]).await?;
        ensure(!user.is_null(), 401, "INVALID_CREDENTIALS")?;
        let epoch = number(&user, "session_epoch");

        writes.push(boundary(a, t, &text(&user, "user_id"), epoch)?);
        writes.push(a.s.guard("EXISTS(SELECT 1 FROM auth_user_email WHERE id=? AND user_id=? AND verified_at IS NOT NULL)",vec![user["binding_id"].clone(),user["user_id"].clone()])?);
        writes.push(a.s.statement("UPDATE auth_product_transaction SET user_id=?,user_epoch=?,binding_id=?,target=?,status='VERIFIED' WHERE id=?",vec![user["user_id"].clone(),epoch.into(),user["binding_id"].clone(),json!({"identityVersion":number(&user,"identity_version")}).to_string().into(),t["id"].clone()])?);
    }
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    crate::core::telemetry::verification(
        a,
        "auth.verification.verified",
        q["channel"].as_str().unwrap_or_default(),
        c["delivery_mode"] == "LIVE",
        started,
        &Ok(()),
    );
    Ok(json!({"verificationProof":proof,"expiresAt":iso(&json!(expires))}))
}
pub(crate) fn new_user(a: &Auth, id: &str, n: i64) -> Result<Vec<D1PreparedStatement>> {
    Ok(vec![a.s.statement("INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,'Molis 用户','ACTIVE',?,?)",vec![id.into(),n.into(),n.into()])?])
}
async fn code_identity(a: &Auth, is_email: bool, target: &str) -> Result<Value> {
    a.s.one(if is_email {
        "SELECT p.user_id,u.session_epoch,u.status FROM auth_user_email p JOIN auth_user u ON u.id=p.user_id WHERE p.canonical_email=?"
    } else {
        "SELECT p.user_id,u.session_epoch,u.status FROM auth_user_phone p JOIN auth_user u ON u.id=p.user_id WHERE p.canonical_phone=?"
    }, vec![target.into()]).await
}

pub(crate) struct PasswordIdentity {
    pub address: String,
    is_phone: bool,
}

impl PasswordIdentity {
    pub(crate) fn new(a: &Auth, identifier: &Value, accepts_phone: bool) -> Result<Self> {
        let raw = identifier.as_str().ok_or_else(Failure::invalid_request)?;
        let is_phone = raw.starts_with("+86");
        ensure(!is_phone || accepts_phone, 400, "INVALID_REQUEST")?;
        let address = if is_phone {
            raw.to_owned()
        } else {
            email(identifier)?
        };
        crate::auth::test_admission::Admission::load(a)?.target(&address)?;
        Ok(Self { address, is_phone })
    }

    pub(crate) fn subject(&self, binding: &str) -> String {
        let (table, column) = if self.is_phone {
            ("auth_user_phone", "canonical_phone")
        } else {
            ("auth_user_email", "canonical_email")
        };
        format!(
            "(SELECT user_id FROM {table} WHERE {column}={binding} AND verified_at IS NOT NULL)"
        )
    }

    pub(crate) fn lookup(&self, a: &Auth) -> Result<D1PreparedStatement> {
        a.s.statement(
            &format!(
                "SELECT u.id,u.status,u.session_epoch,l.password_hash
                FROM auth_user u JOIN auth_local_credential l ON l.user_id=u.id WHERE u.id={}",
                self.subject("?1")
            ),
            vec![self.address.clone().into()],
        )
    }

    pub(crate) async fn verify(
        &self,
        a: &Auth,
        candidate: &Value,
        password: &str,
    ) -> Result<D1PreparedStatement> {
        let encoded = candidate["password_hash"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{VERSION}{}", "00".repeat(48)));
        ensure(
            matches(password, &encoded, a).await? && candidate["status"] == "ACTIVE",
            401,
            "INVALID_CREDENTIALS",
        )?;
        a.s.guard(
            &format!(
                "EXISTS(SELECT 1 FROM auth_local_credential l JOIN auth_user u ON u.id=l.user_id
                WHERE l.user_id={} AND l.user_id=? AND l.password_hash=?
                  AND u.status='ACTIVE' AND u.session_epoch=?)",
                self.subject("?")
            ),
            vec![
                self.address.clone().into(),
                candidate["id"].clone(),
                encoded.into(),
                candidate["session_epoch"].clone(),
            ],
        )
    }
}

pub(crate) async fn identify(
    a: &Auth,
    t: &mut Value,
    c: &Value,
    op: &str,
    b: &Value,
) -> Result<Value> {
    if crate::auth::sensitive_transactions::protected(t) {
        return crate::auth::sensitive_transactions::identify(a, t, c, op, b).await;
    }
    if !identify_once(a, t, c, op, b, true).await? {
        // The failed batch left this transaction's proof unused. Retry only against
        // an existing binding, keeping the ordinary proof and commit-time checks.
        ensure(
            identify_once(a, t, c, op, b, false).await?,
            409,
            "ALREADY_EXISTS",
        )?;
    }
    Ok(json!({"status":"VERIFIED","nextStep":"COMPLETE"}))
}

async fn identify_once(
    a: &Auth,
    t: &mut Value,
    c: &Value,
    op: &str,
    b: &Value,
    allow_new_code_identity: bool,
) -> Result<bool> {
    let n = now();
    let mut writes = vec![client_guard(a, c)?, tx_guard(a, t, n, "PENDING")?];
    let mut creating_code_identity = false;
    let user: String;
    let epoch: i64;
    if op == "email-signup" {
        a.rate_ip("auth:email-signup", 60).await?;
    }
    if op == "password" {
        shape("PasswordLoginRequest", b)?;
        ensure(
            t["purpose"] == "LOGIN"
                && (t["method"] == "EMAIL_PASSWORD" || t["method"] == "ACCOUNT_PASSWORD"),
            400,
            "INVALID_REQUEST",
        )?;
        let identifier = b.get("identifier").unwrap_or(&b["email"]);
        let identity = PasswordIdentity::new(a, identifier, t["method"] == "ACCOUNT_PASSWORD")?;
        a.rate_batch(&[
            ("auth:password", &a.client_ip, 30, 60_000),
            ("auth:password-target", &identity.address, 10, 300_000),
        ])
        .await?;
        let candidate = a.s.first(identity.lookup(a)?).await?;
        writes.push(identity.verify(a, &candidate, &text(b, "password")).await?);
        user = text(&candidate, "id");
        epoch = number(&candidate, "session_epoch");
    } else {
        shape(
            if op == "code" {
                "CodeLoginRequest"
            } else if op == "phone" {
                "PhoneLoginRequest"
            } else {
                "EmailSignupRequest"
            },
            b,
        )?;
        ensure(
            ((op == "phone" || op == "code")
                && t["purpose"] == "LOGIN"
                && (t["method"] == "PHONE_OTP" || (op == "code" && t["method"] == "EMAIL_CODE")))
                || (op == "email-signup"
                    && t["purpose"] == "EMAIL_SIGNUP"
                    && t["method"] == "EMAIL_CODE"),
            400,
            "INVALID_REQUEST",
        )?;
        let digest = hash(&text(b, "verificationProof"));
        let p=a.s.one("SELECT * FROM auth_identity_proof WHERE token_hash=? AND transaction_id=? AND kind='VERIFICATION' AND consumed_at IS NULL AND expires_at>?",vec![digest.clone().into(),t["id"].clone(),n.into()]).await?;
        ensure(!p.is_null(), 401, "INVALID_CREDENTIALS")?;
        let identity = parsed(&p, "verified_identity")?;
        let target = text(&identity, "target");
        crate::auth::test_admission::Admission::load(a)?.target(&target)?;
        writes.push(a.s.guard("EXISTS(SELECT 1 FROM auth_identity_proof WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?)",vec![digest.clone().into(),n.into()])?);
        writes.push(a.s.statement(
            "UPDATE auth_identity_proof SET consumed_at=? WHERE token_hash=?",
            vec![n.into(), digest.into()],
        )?);
        if op == "email-signup" {
            ensure(
                identity["channel"] == "EMAIL" && target == email(&b["email"])?,
                400,
                "INVALID_REQUEST",
            )?;
            let encoded = encode(&text(b, "password"), a).await.map_err(|e| {
                if e.code == "INVALID_PASSWORD" || e.code == "PASSWORD_BLOCKED" {
                    Failure {
                        status: 400,
                        code: "INVALID_REQUEST",
                    }
                } else {
                    e
                }
            })?;
            user = uuid();
            epoch = 0;
            writes.extend(new_user(a, &user, n)?);
            writes.push(a.s.statement(
                "INSERT INTO auth_user_email VALUES (?,?,?,?,?)",
                vec![
                    uuid().into(),
                    user.clone().into(),
                    target.into(),
                    n.into(),
                    n.into(),
                ],
            )?);
            writes.push(a.s.statement(
                "INSERT INTO auth_local_credential VALUES (?,?,?)",
                vec![user.clone().into(), encoded.into(), n.into()],
            )?);
        } else {
            let is_email = t["method"] == "EMAIL_CODE";
            ensure(
                identity["channel"] == if is_email { "EMAIL" } else { "SMS" },
                400,
                "INVALID_REQUEST",
            )?;
            let existing = code_identity(a, is_email, &target).await?;
            if existing.is_null() {
                ensure(allow_new_code_identity, 409, "ALREADY_EXISTS")?;
                creating_code_identity = true;
                user = uuid();
                epoch = 0;
                writes.extend(new_user(a, &user, n)?);
                writes.push(a.s.statement(
                    if is_email {
                        "INSERT INTO auth_user_email VALUES (?,?,?,?,?)"
                    } else {
                        "INSERT INTO auth_user_phone VALUES (?,?,?,?,?)"
                    },
                    vec![
                        uuid().into(),
                        user.clone().into(),
                        target.into(),
                        n.into(),
                        n.into(),
                    ],
                )?);
            } else {
                ensure(existing["status"] == "ACTIVE", 401, "INVALID_CREDENTIALS")?;
                user = text(&existing, "user_id");
                epoch = number(&existing, "session_epoch");
                writes.push(a.s.guard(
                    if is_email { "EXISTS(SELECT 1 FROM auth_user_email WHERE user_id=? AND canonical_email=? AND verified_at IS NOT NULL)" } else { "EXISTS(SELECT 1 FROM auth_user_phone WHERE user_id=? AND canonical_phone=? AND verified_at IS NOT NULL)" },
                    vec![user.clone().into(), target.into()],
                )?);
            }
        }
    }

    writes.push(boundary(a, t, &user, epoch)?);
    writes.push(a.s.statement(
        "UPDATE auth_product_transaction SET status='VERIFIED',user_id=?,user_epoch=? WHERE id=?",
        vec![user.clone().into(), epoch.into(), t["id"].clone()],
    )?);
    // Password KDF is an awaited external computation: recheck freshness at commit.
    writes.insert(0, tx_guard(a, t, now(), "PENDING")?);
    if b.get("verificationProof").is_some() {
        writes.push(a.s.guard(
            "EXISTS(SELECT 1 FROM auth_identity_proof WHERE token_hash=? AND expires_at>?)",
            vec![hash(&text(b, "verificationProof")).into(), now().into()],
        )?);
    }
    writes.push(crate::audit::account(
        a,
        "account.verify",
        user.clone().into(),
        &t["client_id"],
        Value::Null,
    )?);
    match a.s.batch(writes, "VERSION_CONFLICT").await {
        Err(error) if creating_code_identity && error.code == "ALREADY_EXISTS" => Ok(false),
        result => {
            result?;
            t["status"] = "VERIFIED".into();
            t["user_id"] = user.into();
            t["user_epoch"] = epoch.into();
            t["observed_new_user"] = (creating_code_identity || op == "email-signup").into();
            Ok(true)
        }
    }
}
pub(crate) async fn complete(a: &Auth, t: &Value, c: &Value) -> Result<Value> {
    if crate::auth::sensitive_transactions::protected(t) {
        return crate::auth::sensitive_transactions::complete(a, t, c).await;
    }
    let n = now();
    ensure(t["status"] == "VERIFIED", 409, "VERSION_CONFLICT")?;
    let reset = t["purpose"] == "PASSWORD_RESET";
    ensure(
        reset || t["purpose"] == "LOGIN" || t["purpose"] == "EMAIL_SIGNUP",
        400,
        "INVALID_REQUEST",
    )?;
    let value = secret();
    let expires = n + if reset { CODE } else { 60000 };
    let user = text(t, "user_id");
    ensure(!user.is_empty(), 401, "INVALID_CREDENTIALS")?;
    let identity_version = if reset {
        parsed(t, "target")?["identityVersion"].clone()
    } else {
        Value::Null
    };
    let verified_identity = if reset {
        json!({"bindingId":t["binding_id"]}).to_string().into()
    } else {
        Value::Null
    };
    let mut writes = vec![
        client_guard(a, c)?,
        a.s.guard(
            "EXISTS(SELECT 1 FROM auth_product_transaction WHERE id=? AND status='VERIFIED' AND expires_at>? AND user_id=? AND user_epoch=? AND created_seq=?)",
            vec![t["id"].clone(),n.into(),user.clone().into(),t["user_epoch"].clone(),t["created_seq"].clone()],
        )?,
        boundary(a, t, &user, number(t, "user_epoch"))?,
    ];
    if reset {
        writes.push(a.s.guard("EXISTS(SELECT 1 FROM auth_user_email e JOIN auth_user u ON u.id=e.user_id WHERE e.id=? AND e.user_id=? AND e.verified_at IS NOT NULL AND u.identity_version=?)",vec![t["binding_id"].clone(),user.clone().into(),identity_version.clone()])?);
    }
    writes.push(a.s.statement(
        "UPDATE auth_product_transaction SET status='CONSUMED',completed_at=? WHERE id=?",
        vec![n.into(), t["id"].clone()],
    )?);
    writes.push(a.s.statement("INSERT INTO auth_identity_proof(token_hash,transaction_id,kind,binding_hash,user_id,user_epoch,identity_version,verified_identity,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",vec![hash(&value).into(),t["id"].clone(),(if reset{"RESET"}else{"LOGIN_CODE"}).into(),hash(&text(t,"id")).into(),user.into(),t["user_epoch"].clone(),identity_version,verified_identity,n.into(),expires.into()])?);
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(if reset {
        json!({"kind":"RESET_PROOF","resetProof":value,"expiresAt":iso(&json!(expires))})
    } else {
        json!({"kind":"LOGIN_CODE","code":value,"state":t["product_state"],"expiresAt":iso(&json!(expires))})
    })
}
pub async fn route(a: &Auth, path: &str, method: Method, b: Value) -> Result<Value> {
    let parts: Vec<_> = path.trim_matches('/').split('/').collect();
    let result = if parts.len() == 4 && method == Method::Post {
        begin(a, &b).await?
    } else {
        ensure(parts.len() >= 5, 501, "UNIFIED_ACCOUNT_NOT_IMPLEMENTED")?;
        let (mut t, c) = transaction(a, parts[4]).await?;
        let n = now();
        if parts.len() == 5 && method == Method::Get {
            let status = if number(&t, "expires_at") <= n
                && (t["status"] == "PENDING" || t["status"] == "VERIFIED")
            {
                "EXPIRED".to_owned()
            } else {
                text(&t, "status")
            };
            let q=a.s.one("SELECT consumed_at,canonical_target FROM auth_verification_challenge WHERE transaction_id=? AND invalidated_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1",vec![t["id"].clone(),n.into()]).await?;
            let next = if status == "VERIFIED" {
                "COMPLETE"
            } else if status != "PENDING" {
                "NONE"
            } else if t["method"] == "EMAIL_PASSWORD" || t["method"] == "ACCOUNT_PASSWORD" {
                "PASSWORD_LOGIN"
            } else if t["method"] == "GOOGLE" || t["method"] == "GITHUB" {
                if t["provider_state_hash"].is_null() {
                    "START_PROVIDER"
                } else {
                    "WAIT_PROVIDER"
                }
            } else if q.is_null() {
                "REQUEST_CHALLENGE"
            } else if q["consumed_at"].is_null() {
                "VERIFY_CHALLENGE"
            } else if t["purpose"] == "LOGIN"
                && (t["method"] == "PHONE_OTP" || t["method"] == "EMAIL_CODE")
            {
                "CODE_LOGIN"
            } else {
                "EMAIL_SIGNUP"
            };
            json!({"transactionId":t["id"],"status":status,"nextStep":next,"expiresAt":iso(&t["expires_at"])})
        } else {
            ensure(
                method == Method::Post,
                501,
                "UNIFIED_ACCOUNT_NOT_IMPLEMENTED",
            )?;
            ensure(number(&t, "expires_at") > n, 409, "TRANSACTION_EXPIRED")?;
            match &parts[5..] {
                ["providers", provider, "start"] => {
                    shape("Empty", &b)?;
                    crate::auth::external_login::start(a, &t, &c, provider).await?
                }
                ["challenges"] => send(a, &t, &c, &b).await?,
                ["challenges", id, "verify"] => verify(a, &t, &c, id, &b).await?,
                [op @ ("password" | "phone" | "code" | "email-signup")] => {
                    match identify(a, &mut t, &c, op, &b).await {
                        Err(e)
                            if ["email-signup", "phone", "code"].contains(op)
                                && e.code == "ALREADY_EXISTS" =>
                        {
                            return Err(Failure {
                                status: 409,
                                code: "IDENTITY_IN_USE",
                            });
                        }
                        other => other?,
                    }
                }
                ["complete"] => {
                    shape("Empty", &b)?;
                    complete(a, &t, &c).await?
                }
                ["cancel"] => {
                    shape("Empty", &b)?;
                    a.s.batch(vec![client_guard(a,&c)?,a.s.guard("EXISTS(SELECT 1 FROM auth_product_transaction WHERE id=? AND status IN ('PENDING','VERIFIED') AND expires_at>?)",vec![t["id"].clone(),n.into()])?,a.s.statement("UPDATE auth_product_transaction SET status='CANCELLED',completed_at=?,provider_pkce_verifier_sealed=NULL WHERE id=?",vec![n.into(),t["id"].clone()])?],"VERSION_CONFLICT").await?;
                    json!({"status":"CANCELLED"})
                }
                _ => {
                    return Err(Failure {
                        status: 501,
                        code: "UNIFIED_ACCOUNT_NOT_IMPLEMENTED",
                    });
                }
            }
        }
    };
    Ok(result)
}
