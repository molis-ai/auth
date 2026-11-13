//! Product-local email/password and phone transactions; verification never accepts a claimed actor.
use crate::{
    delivery::{MailSender, Message, Sender, SmsSender},
    http::*,
    identity::Auth,
    login_sessions::{client, client_guard},
    security::*,
};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Method, Response};
const TX: i64 = 600000;
const CODE: i64 = 300000;
fn delivery_limit(name: &str) -> i64 {
    static POLICY: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/unified-account/policy.json"
        ))
        .expect("bundled policy")
    })["defaults"][name]
        .as_i64()
        .expect("delivery limit")
}

fn shape(name: &str, b: &Value) -> Result<()> {
    ensure(
        crate::unified_contracts::validate_named(name, b).is_ok(),
        400,
        "INVALID_REQUEST",
    )
}
pub(crate) fn tx_guard(a: &Auth, t: &Value, n: i64, status: &str) -> Result<D1PreparedStatement> {
    if crate::sensitive_transactions::protected(t) {
        return crate::sensitive_transactions::guard(a, t, n, status);
    }
    a.s.guard(
        "EXISTS(SELECT 1 FROM auth_product_transaction WHERE id=? AND status=? AND expires_at>?)",
        vec![t["id"].clone(), status.into(), n.into()],
    )
}
pub(crate) fn boundary(a: &Auth, t: &Value, user: &str, epoch: i64) -> Result<D1PreparedStatement> {
    a.s.guard("EXISTS(SELECT 1 FROM auth_user_security us JOIN auth_user u ON u.id=us.user_id WHERE us.user_id=? AND u.status='ACTIVE' AND us.session_epoch=? AND COALESCE(us.revoked_before_seq,0)<?)",vec![user.into(),epoch.into(),t["created_seq"].clone()])
}
pub(crate) async fn transaction(a: &Auth, id: &str) -> Result<(Value, Value)> {
    let mut t =
        a.s.one(
            "SELECT * FROM auth_product_transaction WHERE id=?",
            vec![id.into()],
        )
        .await?;
    let proof = a.header("X-Auth-Initiator-Proof");
    ensure(
        token(&proof) && !t.is_null() && t["initiator_hash"] == challenge(&proof),
        401,
        "INVALID_CREDENTIALS",
    )?;
    let c = client(a, &text(&t, "client_id")).await?;
    if crate::sensitive_transactions::protected(&t) {
        let (s, _) = crate::login_sessions::active(a).await?;
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
    if crate::sensitive_transactions::protected(b) {
        return crate::sensitive_transactions::begin(a, b).await;
    }
    ensure(
        (b["purpose"] == "LOGIN"
            && (b["method"] == "EMAIL_PASSWORD"
                || b["method"] == "PHONE_OTP"
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
    a.rate_ip("v2-begin", 60).await?;
    let n = now();
    let id = uuid();
    a.s.batch(vec![client_guard(a,&c)?,a.s.statement("INSERT INTO auth_security_sequence(kind,created_at) VALUES ('TRANSACTION',?)",vec![n.into()])?,a.s.statement("INSERT INTO auth_product_transaction(id,client_id,environment_id,purpose,method,initiator_hash,redirect_uri,product_state,product_state_hash,pkce_challenge,created_seq,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,(SELECT MAX(seq) FROM auth_security_sequence),?,?)",vec![id.clone().into(),c["client_id"].clone(),c["environment_id"].clone(),b["purpose"].clone(),b["method"].clone(),b["initiatorChallenge"].clone(),b["redirectUri"].clone(),b["state"].clone(),hash(&text(b,"state")).into(),b["codeChallenge"].clone(),n.into(),(n+TX).into()])?],"VERSION_CONFLICT").await?;
    Ok(
        json!({"transactionId":id,"status":"PENDING","nextStep":if b["method"]=="EMAIL_PASSWORD"{"PASSWORD_LOGIN"}else if b["method"]=="GOOGLE" || b["method"]=="GITHUB"{"START_PROVIDER"}else{"REQUEST_CHALLENGE"},"expiresAt":iso(&json!(n+TX))}),
    )
}
fn otp() -> String {
    loop {
        let value = u32::from_str_radix(&hash(&secret())[..8], 16).unwrap();
        if value < 4_294_000_000 {
            return format!("{:06}", value % 1_000_000);
        }
    }
}
async fn send(a: &Auth, t: &Value, c: &Value, b: &Value) -> Result<Value> {
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
    a.rate_ip("v2-delivery-ip", 60).await?;
    a.rate(
        "v2-delivery-ip-hour",
        &a.header("CF-Connecting-IP"),
        delivery_limit("sendQuotaPerIp"),
        delivery_limit("sendQuotaWindowSeconds") * 1000,
    )
    .await?;
    a.rate(
        "v2-delivery-target",
        &subject,
        delivery_limit("sendQuotaPerTarget"),
        delivery_limit("sendQuotaWindowSeconds") * 1000,
    )
    .await?;
    a.rate(
        "v2-delivery-client",
        &text(c, "client_id"),
        delivery_limit("sendQuotaPerClient"),
        delivery_limit("sendQuotaWindowSeconds") * 1000,
    )
    .await?;
    a.rate("v2-delivery-resend", &subject, 1, 60000).await?;
    let n = now();
    let id = uuid();
    let delivery = uuid();
    let credential = otp();
    let expires = (n + CODE).min(number(t, "expires_at"));
    let m = Message {
        id: &delivery,
        target: &target,
        template: t["purpose"].as_str().unwrap_or("PHONE_LOGIN"),
        credential: &credential,
        expires,
    };
    let mut writes=vec![client_guard(a,c)?,tx_guard(a,t,n,"PENDING")?,a.s.statement("UPDATE auth_verification_challenge SET invalidated_at=? WHERE transaction_id=? AND invalidated_at IS NULL",vec![n.into(),t["id"].clone()])?,a.s.statement("UPDATE auth_identity_proof SET consumed_at=? WHERE transaction_id=? AND kind='VERIFICATION' AND consumed_at IS NULL",vec![n.into(),t["id"].clone()])?,a.s.statement("INSERT INTO auth_verification_challenge(id,transaction_id,channel,canonical_target,credential_hash,delivery_id,delivery_status,max_attempts,created_at,expires_at,next_send_at) VALUES (?,?,?,?,?,?,'ACCEPTED',5,?,?,?)",vec![id.clone().into(),t["id"].clone(),channel.clone().into(),target.clone().into(),hash(&format!("{id}:{credential}")).into(),delivery.clone().into(),n.into(),expires.into(),(n+60000).into()])?];
    // Unknown reset targets get the same accepted response, without delivery or account creation.
    let deliver = if t["purpose"] == "PASSWORD_RESET" {
        !a.s.one("SELECT e.id FROM auth_user_email e JOIN auth_user u ON u.id=e.user_id WHERE e.canonical_email=? AND e.verified_at IS NOT NULL AND u.status='ACTIVE'",vec![target.clone().into()]).await?.is_null()
    } else {
        true
    };
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
        if deliver {
            crate::delivery::send_live(a, t, c, &channel, &id, &m).await?;
        }
        let completed = now();
        a.s.batch(vec![client_guard(a,c)?,tx_guard(a,t,completed,"PENDING")?,a.s.guard("EXISTS(SELECT 1 FROM auth_verification_challenge WHERE id=? AND invalidated_at IS NULL AND expires_at>?)",vec![id.clone().into(),completed.into()])?,a.s.statement("UPDATE auth_verification_challenge SET delivery_status='ACCEPTED' WHERE id=?",vec![id.clone().into()])?],"VERSION_CONFLICT").await?;
        return Ok(
            json!({"challengeId":id,"expiresAt":iso(&json!(expires)),"retryAfterSeconds":60}),
        );
    }
    if deliver {
        writes.push(if channel == "EMAIL" {
            MailSender::enqueue(a, c, &m)?
        } else {
            SmsSender::enqueue(a, c, &m)?
        });
    } else {
        ensure(
            c["delivery_mode"] == "MOCK" && c["kind"] != "PRODUCTION",
            503,
            "UPSTREAM_UNAVAILABLE",
        )?;
    }
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(json!({"challengeId":id,"expiresAt":iso(&json!(expires)),"retryAfterSeconds":60}))
}
async fn verify(a: &Auth, t: &Value, c: &Value, id: &str, b: &Value) -> Result<Value> {
    shape("VerifyChallengeRequest", b)?;
    a.rate_ip("v2-verify", 120).await?;
    let n = now();
    let q =
        a.s.one(
            "SELECT * FROM auth_verification_challenge WHERE id=? AND transaction_id=?",
            vec![id.into(), t["id"].clone()],
        )
        .await?;
    ensure(
        !q.is_null()
            && q["delivery_status"] == "ACCEPTED"
            && q["consumed_at"].is_null()
            && q["invalidated_at"].is_null()
            && number(&q, "expires_at") > n
            && number(&q, "attempts") < 5,
        401,
        "INVALID_CREDENTIALS",
    )?;
    let matched = if q["verifier"] == "ALIYUN" {
        ensure(c["delivery_mode"] == "LIVE", 503, "UPSTREAM_UNAVAILABLE")?;
        // Reserve an attempt before network I/O, including failed/uncertain requests.
        a.s.batch(vec![client_guard(a,c)?,tx_guard(a,t,now(),"PENDING")?,a.s.guard("EXISTS(SELECT 1 FROM auth_verification_challenge WHERE id=? AND consumed_at IS NULL AND invalidated_at IS NULL AND attempts<max_attempts AND expires_at>?)",vec![id.into(),now().into()])?,a.s.statement("UPDATE auth_verification_challenge SET attempts=attempts+1 WHERE id=?",vec![id.into()])?],"VERSION_CONFLICT").await?;
        crate::sms_auth::verify(a, id, &text(&q, "canonical_target"), &text(b, "credential"))
            .await?
    } else {
        ensure(
            c["delivery_mode"] == "MOCK"
                || (c["delivery_mode"] == "LIVE" && q["channel"] == "EMAIL"),
            503,
            "UPSTREAM_UNAVAILABLE",
        )?;
        q["credential_hash"] == hash(&format!("{id}:{}", text(b, "credential")))
    };
    if !matched {
        if q["verifier"] != "ALIYUN" {
            a.s.batch(vec![client_guard(a,c)?,tx_guard(a,t,n,"PENDING")?,a.s.statement("UPDATE auth_verification_challenge SET attempts=MIN(attempts+1,max_attempts) WHERE id=? AND consumed_at IS NULL AND invalidated_at IS NULL",vec![id.into()])?],"VERSION_CONFLICT").await?;
        }
        return Err(Failure {
            status: 401,
            code: "INVALID_CREDENTIALS",
        });
    }
    let n = now();
    let proof = secret();
    let expires = (n + CODE).min(number(t, "expires_at"));
    let target = text(&q, "canonical_target");
    let mut writes=vec![client_guard(a,c)?,tx_guard(a,t,n,"PENDING")?,a.s.guard("EXISTS(SELECT 1 FROM auth_verification_challenge WHERE id=? AND consumed_at IS NULL AND invalidated_at IS NULL AND (attempts<max_attempts OR (verifier='ALIYUN' AND attempts=max_attempts)) AND expires_at>?)",vec![id.into(),n.into()])?,a.s.statement("UPDATE auth_verification_challenge SET consumed_at=? WHERE id=?",vec![n.into(),id.into()])?,a.s.statement("INSERT INTO auth_identity_proof(token_hash,transaction_id,kind,binding_hash,verified_identity,created_at,expires_at) VALUES (?,?,'VERIFICATION',?,?,?,?)",vec![hash(&proof).into(),t["id"].clone(),hash(id).into(),json!({"channel":q["channel"],"target":target}).to_string().into(),n.into(),expires.into()])?];
    if crate::sensitive_transactions::protected(t) {
        writes.extend(
            crate::sensitive_transactions::verified(
                a,
                t,
                &json!({"type":if q["channel"]=="EMAIL"{"EMAIL"}else{"PHONE"},"target":target}),
                n,
            )
            .await?,
        );
    }
    if t["purpose"] == "PASSWORD_RESET" {
        let user=a.s.one("SELECT e.id binding_id,e.user_id,us.session_epoch,us.identity_version FROM auth_user_email e JOIN auth_user u ON u.id=e.user_id LEFT JOIN auth_user_security us ON us.user_id=e.user_id WHERE e.canonical_email=? AND e.verified_at IS NOT NULL AND u.status='ACTIVE'",vec![target.into()]).await?;
        ensure(!user.is_null(), 401, "INVALID_CREDENTIALS")?;
        let epoch = number(&user, "session_epoch");
        writes.push(a.s.statement(
            "INSERT OR IGNORE INTO auth_user_security(user_id,updated_at) VALUES (?,?)",
            vec![user["user_id"].clone(), n.into()],
        )?);
        writes.push(boundary(a, t, &text(&user, "user_id"), epoch)?);
        writes.push(a.s.guard("EXISTS(SELECT 1 FROM auth_user_email WHERE id=? AND user_id=? AND verified_at IS NOT NULL)",vec![user["binding_id"].clone(),user["user_id"].clone()])?);
        writes.push(a.s.statement("UPDATE auth_product_transaction SET user_id=?,user_epoch=?,binding_id=?,target=?,status='VERIFIED' WHERE id=?",vec![user["user_id"].clone(),epoch.into(),user["binding_id"].clone(),json!({"identityVersion":number(&user,"identity_version")}).to_string().into(),t["id"].clone()])?);
    }
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(json!({"verificationProof":proof,"expiresAt":iso(&json!(expires))}))
}
pub(crate) fn new_user(a: &Auth, id: &str, n: i64) -> Result<Vec<D1PreparedStatement>> {
    Ok(vec![a.s.statement("INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,'Molis 用户','ACTIVE',?,?)",vec![id.into(),n.into(),n.into()])?])
}
async fn identify(a: &Auth, t: &Value, c: &Value, op: &str, b: &Value) -> Result<Value> {
    if crate::sensitive_transactions::protected(t) {
        return crate::sensitive_transactions::identify(a, t, c, op, b).await;
    }
    let n = now();
    let mut writes = vec![client_guard(a, c)?, tx_guard(a, t, n, "PENDING")?];
    let user: String;
    let epoch: i64;
    if op == "password" {
        shape("PasswordLoginRequest", b)?;
        ensure(
            t["purpose"] == "LOGIN" && t["method"] == "EMAIL_PASSWORD",
            400,
            "INVALID_REQUEST",
        )?;
        let address = email(&b["email"])?;
        a.rate_ip("v2-password", 30).await?;
        a.rate("v2-password-target", &address, 10, 300000).await?;
        let candidate=a.s.one("SELECT u.id,u.status,us.session_epoch,l.password_hash FROM auth_user_email e JOIN auth_user u ON u.id=e.user_id JOIN auth_local_credential l ON l.user_id=u.id LEFT JOIN auth_user_security us ON us.user_id=u.id WHERE e.canonical_email=? AND e.verified_at IS NOT NULL",vec![address.clone().into()]).await?;
        let encoded = candidate["password_hash"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or(format!("{VERSION}{}", "00".repeat(48)));
        ensure(
            matches(&text(b, "password"), &encoded, &a.env).await?
                && candidate["status"] == "ACTIVE",
            401,
            "INVALID_CREDENTIALS",
        )?;
        user = text(&candidate, "id");
        epoch = number(&candidate, "session_epoch");
        writes.push(a.s.guard(
            "EXISTS(SELECT 1 FROM auth_local_credential l JOIN auth_user_email e ON e.user_id=l.user_id WHERE l.user_id=? AND l.password_hash=? AND e.canonical_email=? AND e.verified_at IS NOT NULL)",
            vec![user.clone().into(), encoded.into(),address.into()],
        )?);
    } else {
        shape(
            if op == "phone" {
                "PhoneLoginRequest"
            } else {
                "EmailSignupRequest"
            },
            b,
        )?;
        ensure(
            (op == "phone" && t["purpose"] == "LOGIN" && t["method"] == "PHONE_OTP")
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
            let encoded = encode(&text(b, "password"), &a.env).await.map_err(|e| {
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
            ensure(identity["channel"] == "SMS", 400, "INVALID_REQUEST")?;
            let existing=a.s.one("SELECT p.user_id,us.session_epoch,u.status FROM auth_user_phone p JOIN auth_user u ON u.id=p.user_id LEFT JOIN auth_user_security us ON us.user_id=p.user_id WHERE p.canonical_phone=?",vec![target.clone().into()]).await?;
            if existing.is_null() {
                user = uuid();
                epoch = 0;
                writes.extend(new_user(a, &user, n)?);
                writes.push(a.s.statement(
                    "INSERT INTO auth_user_phone VALUES (?,?,?,?,?)",
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
                    "EXISTS(SELECT 1 FROM auth_user_phone WHERE user_id=? AND canonical_phone=?)",
                    vec![user.clone().into(), target.into()],
                )?);
            }
        }
    }
    writes.push(a.s.statement(
        "INSERT OR IGNORE INTO auth_user_security(user_id,updated_at) VALUES (?,?)",
        vec![user.clone().into(), n.into()],
    )?);
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
    writes.push(a.s.audit(
        "account.v2.verify",
        user.into(),
        &a.request_id,
        Value::Null,
        Value::Null,
        Value::Null,
        false,
    )?);
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(json!({"status":"VERIFIED","nextStep":"COMPLETE"}))
}
async fn complete(a: &Auth, t: &Value, c: &Value) -> Result<Value> {
    if crate::sensitive_transactions::protected(t) {
        return crate::sensitive_transactions::complete(a, t, c).await;
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
        tx_guard(a, t, n, "VERIFIED")?,
        boundary(a, t, &user, number(t, "user_epoch"))?,
    ];
    if reset {
        writes.push(a.s.guard("EXISTS(SELECT 1 FROM auth_user_email e JOIN auth_user_security us ON us.user_id=e.user_id WHERE e.id=? AND e.user_id=? AND e.verified_at IS NOT NULL AND us.identity_version=?)",vec![t["binding_id"].clone(),user.clone().into(),identity_version.clone()])?);
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
pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    let parts: Vec<_> = path.trim_matches('/').split('/').collect();
    let b = if method == Method::Post {
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/json"),
            415,
            "INVALID_REQUEST",
        )?;
        serde_json::from_str(&crate::app::bounded(a, 16384).await?)?
    } else {
        json!({})
    };
    let result = if parts.len() == 4 && method == Method::Post {
        begin(a, &b).await?
    } else {
        ensure(parts.len() >= 5, 501, "UNIFIED_ACCOUNT_NOT_IMPLEMENTED")?;
        let (t, c) = transaction(a, parts[4]).await?;
        let n = now();
        if parts.len() == 5 && method == Method::Get {
            let status = if number(&t, "expires_at") <= n
                && (t["status"] == "PENDING" || t["status"] == "VERIFIED")
            {
                "EXPIRED".to_owned()
            } else {
                text(&t, "status")
            };
            let q=a.s.one("SELECT consumed_at FROM auth_verification_challenge WHERE transaction_id=? AND invalidated_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1",vec![t["id"].clone(),n.into()]).await?;
            let next = if status == "VERIFIED" {
                "COMPLETE"
            } else if status != "PENDING" {
                "NONE"
            } else if t["method"] == "EMAIL_PASSWORD" {
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
            } else if t["method"] == "PHONE_OTP" {
                "PHONE_LOGIN"
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
                    crate::external_login::start(a, &t, &c, provider).await?
                }
                ["challenges"] => send(a, &t, &c, &b).await?,
                ["challenges", id, "verify"] => verify(a, &t, &c, id, &b).await?,
                [op @ ("password" | "phone" | "email-signup")] => {
                    match identify(a, &t, &c, op, &b).await {
                        Err(e) if *op == "phone" && e.code == "ALREADY_EXISTS" => {
                            identify(a, &t, &c, op, &b).await?
                        }
                        Err(e) if *op == "email-signup" && e.code == "ALREADY_EXISTS" => {
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
    Ok(json_response(
        json!({"data":result,"requestId":a.request_id}),
        200,
    )?)
}
