//! AUTH-06: authenticated identity verification, without account creation.
use crate::{
    http::*,
    identity::Auth,
    login_sessions,
    registration::{boundary, tx_guard},
    security::*,
};
use serde_json::{Value, json};
use worker::D1PreparedStatement;

pub fn protected(t: &Value) -> bool {
    matches!(text(t, "purpose").as_str(), "REAUTH" | "BIND" | "REPLACE")
}
pub fn shape(n: &str, b: &Value) -> Result<()> {
    ensure(
        crate::unified_contracts::validate_named(n, b).is_ok(),
        400,
        "INVALID_REQUEST",
    )
}
pub fn guard(a: &Auth, t: &Value, n: i64, status: &str) -> Result<D1PreparedStatement> {
    a.s.guard("EXISTS(SELECT 1 FROM auth_product_transaction t JOIN auth_login_session s ON s.id=t.login_session_id JOIN auth_user_security us ON us.user_id=t.user_id JOIN auth_user u ON u.id=t.user_id WHERE t.id=? AND t.status=? AND t.expires_at>? AND s.user_id=t.user_id AND s.client_id=t.client_id AND s.revoked_at IS NULL AND s.user_epoch=t.user_epoch AND us.session_epoch=t.user_epoch AND s.session_revision=t.session_revision AND us.identity_version=t.identity_version AND s.last_active_at+2592000000>? AND s.absolute_expires_at>? AND u.status='ACTIVE' AND COALESCE(us.revoked_before_seq,0)<t.created_seq AND (? IS NULL OR EXISTS(SELECT 1 FROM auth_login_access_token a WHERE a.token_hash=? AND a.login_session_id=s.id AND a.expires_at>? AND a.user_epoch=s.user_epoch AND a.session_revision=s.session_revision)))",vec![t["id"].clone(),status.into(),n.into(),n.into(),n.into(),t["_access_hash"].clone(),t["_access_hash"].clone(),n.into()])
}
pub async fn binding(a: &Auth, user: &str, id: &str) -> Result<Value> {
    let rows=a.s.all("SELECT id,'EMAIL' type,canonical_email target,verified_at FROM auth_user_email WHERE user_id=? AND id=? UNION ALL SELECT id,'PHONE',canonical_phone,verified_at FROM auth_user_phone WHERE user_id=? AND id=? UNION ALL SELECT id,provider,subject,created_at FROM auth_external_identity WHERE user_id=? AND id=? AND provider IN ('GOOGLE','GITHUB')",vec![user.into(),id.into(),user.into(),id.into(),user.into(),id.into()]).await?;
    rows.first().cloned().ok_or(Failure {
        status: 404,
        code: "NOT_FOUND",
    })
}
pub async fn begin(a: &Auth, b: &Value) -> Result<Value> {
    let (s, c) = login_sessions::active(a).await?;
    ensure(
        b["clientId"] == s["client_id"] && contains(&parsed(&c, "redirects")?, &b["redirectUri"]),
        400,
        "INVALID_REQUEST",
    )?;
    if b["purpose"] == "REPLACE"
        || b["purpose"] == "REAUTH"
            && (b["operation"] == "REPLACE_METHOD" || b["operation"] == "UNLINK_METHOD")
    {
        binding(
            a,
            &text(&s, "user_id"),
            &if b["purpose"] == "REPLACE" {
                text(b, "bindingId")
            } else {
                text(&b["target"], "bindingId")
            },
        )
        .await?;
    }
    if b["purpose"] == "BIND" || b["purpose"] == "REPLACE" {
        ensure(b["method"] != "EMAIL_CODE", 403, "FORBIDDEN")?;
    }
    if b["purpose"] == "REAUTH" && b["operation"] == "BIND_METHOD" {
        ensure(b["target"]["method"] != "EMAIL", 403, "FORBIDDEN")?;
    }
    if b["purpose"] == "REPLACE"
        || (b["purpose"] == "REAUTH"
            && (b["operation"] == "REPLACE_METHOD" || b["operation"] == "UNLINK_METHOD"))
    {
        let id = if b["purpose"] == "REPLACE" {
            text(b, "bindingId")
        } else {
            text(&b["target"], "bindingId")
        };
        ensure(
            binding(a, &text(&s, "user_id"), &id).await?["type"] != "EMAIL",
            403,
            "FORBIDDEN",
        )?;
    }
    a.rate_ip("v2-sensitive-start", 60).await?;
    let us =
        a.s.one(
            "SELECT * FROM auth_user_security WHERE user_id=?",
            vec![s["user_id"].clone()],
        )
        .await?;
    let id = uuid();
    let n = now();
    let use_session = b["purpose"] == "REAUTH" && b["useSession"] == true;
    a.s.batch(vec![login_sessions::client_guard(a,&c)?,login_sessions::active_guard(a,&s)?,
        a.s.guard("EXISTS(SELECT 1 FROM auth_user_security WHERE user_id=? AND identity_version=?)",vec![s["user_id"].clone(),us["identity_version"].clone()])?,
        a.s.statement("INSERT INTO auth_security_sequence(kind,created_at) VALUES ('TRANSACTION',?)",vec![n.into()])?,
        a.s.statement("INSERT INTO auth_product_transaction(id,client_id,environment_id,purpose,method,initiator_hash,redirect_uri,product_state,product_state_hash,pkce_challenge,user_id,login_session_id,user_epoch,session_revision,identity_version,operation,target,binding_id,created_seq,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT MAX(seq) FROM auth_security_sequence),?,?)",vec![id.clone().into(),s["client_id"].clone(),c["environment_id"].clone(),b["purpose"].clone(),b["method"].clone(),b["initiatorChallenge"].clone(),b["redirectUri"].clone(),b["state"].clone(),hash(&text(b,"state")).into(),b["codeChallenge"].clone(),s["user_id"].clone(),s["id"].clone(),s["user_epoch"].clone(),s["session_revision"].clone(),us["identity_version"].clone(),b["operation"].clone(),b.get("target").map(|x|Value::String(x.to_string())).unwrap_or(Value::Null),b["bindingId"].clone(),n.into(),(n+600000).into()])?],"VERSION_CONFLICT").await?;
    if use_session {
        // Session authorization remains operation-scoped; no second identity challenge.
        let identity = json!({"type":"SESSION","sessionId":s["id"]});
        a.s.batch(vec![login_sessions::client_guard(a,&c)?,login_sessions::active_guard(a,&s)?,
            owner_guard(a,&text(&s,"user_id"),&identity)?,
            a.s.guard("EXISTS(SELECT 1 FROM auth_user_security WHERE user_id=? AND identity_version=?)",vec![s["user_id"].clone(),us["identity_version"].clone()])?,
            a.s.statement("UPDATE auth_product_transaction SET status='VERIFIED',verified_identity=? WHERE id=? AND status='PENDING'",vec![identity.to_string().into(),id.clone().into()])?
        ],"VERSION_CONFLICT").await?;
        return Ok(
            json!({"transactionId":id,"status":"VERIFIED","expiresAt":iso(&json!(n+600000)),"nextStep":"COMPLETE"}),
        );
    }
    Ok(
        json!({"transactionId":id,"status":"PENDING","expiresAt":iso(&json!(n+600000)),"nextStep":match text(b,"method").as_str(){"EMAIL_PASSWORD"=>"PASSWORD_LOGIN","GOOGLE"|"GITHUB"=>"START_PROVIDER",_=>"REQUEST_CHALLENGE"}}),
    )
}
pub fn owner_guard(a: &Auth, user: &str, identity: &Value) -> Result<D1PreparedStatement> {
    let (sql, args) = match text(identity, "type").as_str() {
        "SESSION" => (
            "EXISTS(SELECT 1 FROM auth_login_session WHERE id=? AND user_id=? AND revoked_at IS NULL AND last_active_at+2592000000>? AND absolute_expires_at>?)",
            vec![
                identity["sessionId"].clone(),
                user.into(),
                now().into(),
                now().into(),
            ],
        ),
        "EMAIL" => (
            "EXISTS(SELECT 1 FROM auth_user_email e JOIN auth_local_credential c ON c.user_id=e.user_id WHERE e.user_id=? AND e.canonical_email=? AND e.verified_at IS NOT NULL)",
            vec![user.into(), identity["target"].clone()],
        ),
        "PHONE" => (
            "EXISTS(SELECT 1 FROM auth_user_phone WHERE user_id=? AND canonical_phone=?)",
            vec![user.into(), identity["target"].clone()],
        ),
        "GOOGLE" | "GITHUB" => (
            "EXISTS(SELECT 1 FROM auth_external_identity WHERE user_id=? AND provider=? AND issuer=? AND subject=?)",
            vec![
                user.into(),
                identity["type"].clone(),
                identity["issuer"].clone(),
                identity["subject"].clone(),
            ],
        ),
        _ => {
            return Err(Failure {
                status: 400,
                code: "INVALID_REQUEST",
            });
        }
    };
    a.s.guard(sql, args)
}
pub async fn verified(
    a: &Auth,
    t: &Value,
    identity: &Value,
    n: i64,
) -> Result<Vec<D1PreparedStatement>> {
    let mut writes = vec![guard(a, t, n, "PENDING")?];
    if t["purpose"] == "REAUTH" {
        writes.push(owner_guard(a, &text(t, "user_id"), identity)?);
        writes.push(a.s.statement(
            "UPDATE auth_login_session SET identity_verified_at=? WHERE id=?",
            vec![n.into(), t["login_session_id"].clone()],
        )?);
    }
    writes.push(a.s.statement(
        "UPDATE auth_product_transaction SET status='VERIFIED',verified_identity=? WHERE id=?",
        vec![identity.to_string().into(), t["id"].clone()],
    )?);
    Ok(writes)
}
pub async fn identify(a: &Auth, t: &Value, c: &Value, op: &str, b: &Value) -> Result<Value> {
    ensure(
        op == "password" && t["purpose"] == "REAUTH" && t["method"] == "EMAIL_PASSWORD",
        400,
        "INVALID_REQUEST",
    )?;
    shape("PasswordLoginRequest", b)?;
    let address = email(&b["email"])?;
    a.rate_ip("v2-password", 30).await?;
    a.rate("v2-password-target", &address, 10, 300000).await?;
    let candidate=a.s.one("SELECT l.password_hash FROM auth_local_credential l JOIN auth_user_email e ON e.user_id=l.user_id WHERE l.user_id=? AND e.canonical_email=? AND e.verified_at IS NOT NULL",vec![t["user_id"].clone(),address.clone().into()]).await?;
    let encoded = candidate["password_hash"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or(format!("{VERSION}{}", "00".repeat(48)));
    ensure(
        matches(&text(b, "password"), &encoded, &a.env).await? && !candidate.is_null(),
        401,
        "INVALID_CREDENTIALS",
    )?;
    let mut writes = verified(a, t, &json!({"type":"EMAIL","target":address}), now()).await?;
    writes.extend([
        login_sessions::client_guard(a, c)?,
        a.s.guard(
            "EXISTS(SELECT 1 FROM auth_local_credential WHERE user_id=? AND password_hash=?)",
            vec![t["user_id"].clone(), encoded.into()],
        )?,
    ]);
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(json!({"status":"VERIFIED","nextStep":"COMPLETE"}))
}
pub async fn complete(a: &Auth, t: &Value, c: &Value) -> Result<Value> {
    ensure(t["status"] == "VERIFIED", 409, "VERSION_CONFLICT")?;
    let identity = parsed(t, "verified_identity")?;
    let raw = secret();
    let n = now();
    let expires = n + 300000;
    let mut writes = vec![
        login_sessions::client_guard(a, c)?,
        tx_guard(a, t, n, "VERIFIED")?,
        boundary(a, t, &text(t, "user_id"), number(t, "user_epoch"))?,
    ];
    if t["purpose"] == "REAUTH" {
        writes.push(owner_guard(a, &text(t, "user_id"), &identity)?);
    }
    writes.push(a.s.statement(
        "UPDATE auth_product_transaction SET status='CONSUMED',completed_at=? WHERE id=?",
        vec![n.into(), t["id"].clone()],
    )?);
    writes.push(a.s.statement("INSERT INTO auth_identity_proof(token_hash,transaction_id,kind,binding_hash,user_id,login_session_id,user_epoch,identity_version,session_revision,verified_identity,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",vec![hash(&raw).into(),t["id"].clone(),(if t["purpose"]=="REAUTH"{"OPERATION"}else{"NEW_IDENTITY"}).into(),hash(&text(t,"id")).into(),t["user_id"].clone(),t["login_session_id"].clone(),t["user_epoch"].clone(),t["identity_version"].clone(),t["session_revision"].clone(),identity.to_string().into(),n.into(),expires.into()])?);
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(if t["purpose"] == "REAUTH" {
        json!({"kind":"OPERATION_PROOF","operationProof":raw,"expiresAt":iso(&json!(expires))})
    } else {
        json!({"kind":"NEW_IDENTITY_PROOF","newIdentityProof":raw,"expiresAt":iso(&json!(expires))})
    })
}
