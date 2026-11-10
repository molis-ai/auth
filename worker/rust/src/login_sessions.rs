//! Independent v2 sessions. External identity verification is supplied by AUTH-04/05.
use crate::{
    http::*,
    identity::Auth,
    security::{challenge, hash, secret, uuid},
};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Method, Response};
const IDLE: i64 = 2592000000;
const ABSOLUTE: i64 = 7776000000;
const ACCESS: i64 = 900000;
const RECEIPT: i64 = 86400000;
const LIVE: &str = "s.revoked_at IS NULL AND u.status='ACTIVE' AND s.user_epoch=us.session_epoch AND s.last_active_at+2592000000>? AND s.absolute_expires_at>?";
fn shape(name: &str, b: &Value) -> Result<()> {
    ensure(
        crate::unified_contracts::validate_named(name, b).is_ok(),
        400,
        "INVALID_REQUEST",
    )
}
pub(crate) fn view(s: &Value) -> Value {
    json!({"loginSessionId":s["id"],"applicationId":s["application_id"],"clientId":s["client_id"],"authenticatedAt":iso(&s["authenticated_at"]),"lastActiveAt":iso(&s["last_active_at"]),"idleExpiresAt":iso(&json!(number(s,"last_active_at")+IDLE)),"absoluteExpiresAt":iso(&s["absolute_expires_at"]),"sessionRevision":s["session_revision"]})
}
pub(crate) async fn registered_client(a: &Auth, id: &str) -> Result<Value> {
    let config: Value = serde_json::from_str(
        &a.env
            .var("UNIFIED_ACCOUNT_CONFIG")
            .map_err(|_| Failure {
                status: 503,
                code: "UNIFIED_CONFIGURATION_INVALID",
            })?
            .to_string(),
    )?;
    let c=a.s.one("SELECT c.*,p.version policy_version,p.allowed_origins,e.version environment_version,e.id environment_id,e.kind,e.auth_origin,e.delivery_mode,e.provider_mode FROM auth_client c JOIN auth_application app ON app.id=c.application_id JOIN auth_client_policy p ON p.client_id=c.client_id JOIN auth_environment e ON e.id=p.environment_id WHERE c.client_id=? AND c.status='ACTIVE' AND app.status='ACTIVE' AND p.policy_profile='unified-account-v2' AND e.status='ACTIVE'",vec![id.into()]).await?;
    ensure(
        !c.is_null()
            && c["environment_id"] == config["environmentId"]
            && c["auth_origin"] == config["authOrigin"]
            && c["kind"] == config["kind"]
            && c["delivery_mode"] == config["deliveryMode"]
            && c["provider_mode"] == config["providerMode"],
        403,
        "POLICY_MISMATCH",
    )?;
    Ok(c)
}
pub(crate) async fn client(a: &Auth, id: &str) -> Result<Value> {
    let c = registered_client(a, id).await?;
    let origin = a.header("Origin");
    ensure(
        origin.is_empty() || contains(&parsed(&c, "allowed_origins")?, &json!(origin)),
        403,
        "FORBIDDEN",
    )?;
    Ok(c)
}
pub(crate) fn client_guard(a: &Auth, c: &Value) -> Result<D1PreparedStatement> {
    a.s.guard("EXISTS(SELECT 1 FROM auth_client c JOIN auth_application app ON app.id=c.application_id JOIN auth_client_policy p ON p.client_id=c.client_id JOIN auth_environment e ON e.id=p.environment_id WHERE c.client_id=? AND c.version=? AND p.version=? AND e.version=? AND c.status='ACTIVE' AND app.status='ACTIVE' AND e.status='ACTIVE' AND p.policy_profile='unified-account-v2')",vec![c["client_id"].clone(),c["version"].clone(),c["policy_version"].clone(),c["environment_version"].clone()])
}
pub(crate) async fn session(a: &Auth, id: &str) -> Result<Value> {
    a.s.one("SELECT s.*,c.application_id,us.session_epoch current_epoch,u.status user_status FROM auth_login_session s JOIN auth_user_security us ON us.user_id=s.user_id JOIN auth_user u ON u.id=s.user_id JOIN auth_client c ON c.client_id=s.client_id WHERE s.id=?",vec![id.into()]).await
}
fn live(s: &Value, n: i64) -> bool {
    !s.is_null()
        && s["revoked_at"].is_null()
        && s["user_status"] == "ACTIVE"
        && s["user_epoch"] == s["current_epoch"]
        && number(s, "last_active_at") + IDLE > n
        && number(s, "absolute_expires_at") > n
}
pub(crate) fn session_guard(a: &Auth, s: &Value, n: i64) -> Result<D1PreparedStatement> {
    a.s.guard(&format!("EXISTS(SELECT 1 FROM auth_login_session s JOIN auth_user_security us ON us.user_id=s.user_id JOIN auth_user u ON u.id=s.user_id WHERE s.id=? AND s.session_revision=? AND {LIVE})"),vec![s["id"].clone(),s["session_revision"].clone(),n.into(),n.into()])
}
async fn credential(a: &Auth, b: &Value) -> Result<(Value, Value, String)> {
    let refresh = b.get("refreshProof");
    let authorization = a.header("Authorization");
    let (table, raw) = if let Some(p) = refresh {
        ensure(authorization.is_empty(), 400, "INVALID_REQUEST")?;
        ("auth_login_refresh_token", text(p, "refreshToken"))
    } else {
        (
            "auth_login_access_token",
            authorization
                .strip_prefix("Bearer ")
                .unwrap_or("")
                .to_owned(),
        )
    };
    ensure(token(&raw), 401, "INVALID_CREDENTIALS")?;
    let digest = hash(&raw);
    let t =
        a.s.one(
            &format!("SELECT * FROM {table} WHERE token_hash=?"),
            vec![digest.clone().into()],
        )
        .await?;
    ensure(!t.is_null(), 401, "INVALID_CREDENTIALS")?;
    let s = session(a, &text(&t, "login_session_id")).await?;
    ensure(
        !s.is_null() && refresh.is_none_or(|p| p["clientId"] == s["client_id"]),
        401,
        "INVALID_CREDENTIALS",
    )?;
    client(a, &text(&s, "client_id")).await?;
    Ok((s, t, digest))
}
/// A v2 access credential, including its expiry for the final commit guard.
pub(crate) async fn active(a: &Auth) -> Result<(Value, Value)> {
    let (mut s, t, digest) = credential(a, &json!({})).await?;
    ensure(
        live(&s, now())
            && number(&t, "expires_at") > now()
            && t["session_revision"] == s["session_revision"]
            && t["user_epoch"] == s["user_epoch"],
        401,
        "SESSION_EXPIRED",
    )?;
    let c = client(a, &text(&s, "client_id")).await?;
    s["access_hash"] = digest.into();
    Ok((s, c))
}
pub(crate) fn active_guard(a: &Auth, s: &Value) -> Result<D1PreparedStatement> {
    a.s.guard(&format!("EXISTS(SELECT 1 FROM auth_login_session s JOIN auth_user_security us ON us.user_id=s.user_id JOIN auth_user u ON u.id=s.user_id JOIN auth_login_access_token t ON t.login_session_id=s.id WHERE s.id=? AND s.session_revision=? AND {LIVE} AND t.token_hash=? AND t.expires_at>? AND t.user_epoch=s.user_epoch AND t.session_revision=s.session_revision)"),vec![s["id"].clone(),s["session_revision"].clone(),now().into(),now().into(),s["access_hash"].clone(),now().into()])
}
fn tokens(
    a: &Auth,
    s: &Value,
    n: i64,
    generation: i64,
) -> Result<(Value, Vec<D1PreparedStatement>)> {
    let access = secret();
    let refresh = secret();
    let expires = (number(s, "last_active_at") + IDLE).min(number(s, "absolute_expires_at"));
    let access_exp = (n + ACCESS).min(expires);
    let writes=vec![a.s.statement("INSERT INTO auth_login_access_token VALUES (?,?,?,?,?)",vec![hash(&access).into(),s["id"].clone(),s["session_revision"].clone(),s["user_epoch"].clone(),access_exp.into()])?,a.s.statement("INSERT INTO auth_login_refresh_token(token_hash,login_session_id,generation,session_revision,user_epoch,created_at,expires_at) VALUES (?,?,?,?,?,?,?)",vec![hash(&refresh).into(),s["id"].clone(),generation.into(),s["session_revision"].clone(),s["user_epoch"].clone(),n.into(),s["absolute_expires_at"].clone()])?];
    Ok((
        json!({"accessToken":access,"refreshToken":refresh,"tokenType":"Bearer","accessExpiresAt":iso(&json!(access_exp)),"session":view(s)}),
        writes,
    ))
}
async fn exchange(a: &Auth, b: &Value) -> Result<Value> {
    shape("TokenRequest", b)?;
    let c = client(a, &text(b, "clientId")).await?;
    let n = now();
    a.rate_ip("v2-token", 120).await?;
    if b["grantType"] == "refresh_token" {
        let digest = hash(&text(b, "refreshToken"));
        let t =
            a.s.one(
                "SELECT * FROM auth_login_refresh_token WHERE token_hash=?",
                vec![digest.clone().into()],
            )
            .await?;
        ensure(!t.is_null(), 401, "INVALID_GRANT")?;
        let s = session(a, &text(&t, "login_session_id")).await?;
        ensure(s["client_id"] == c["client_id"], 401, "INVALID_GRANT")?;
        if !t["used_at"].is_null() {
            a.s.run("UPDATE auth_login_session SET revoked_at=COALESCE(revoked_at,?),session_revision=session_revision+1 WHERE id=? AND revoked_at IS NULL",vec![n.into(),s["id"].clone()]).await?;
            return Err(Failure {
                status: 401,
                code: "INVALID_GRANT",
            });
        }
        ensure(
            live(&s, n)
                && number(&t, "expires_at") > n
                && t["user_epoch"] == s["user_epoch"]
                && t["session_revision"] == s["session_revision"],
            401,
            "SESSION_EXPIRED",
        )?;
        let (result, new_tokens) = tokens(a, &s, n, number(&t, "generation") + 1)?;
        let mut writes=vec![client_guard(a,&c)?,session_guard(a,&s,n)?,a.s.guard("EXISTS(SELECT 1 FROM auth_login_refresh_token WHERE token_hash=? AND used_at IS NULL AND expires_at>?)",vec![digest.clone().into(),n.into()])?,a.s.statement("UPDATE auth_login_refresh_token SET used_at=? WHERE token_hash=?",vec![n.into(),digest.into()])?];
        writes.extend(new_tokens);
        writes.push(a.s.audit(
            "account.v2.token",
            s["user_id"].clone(),
            &a.request_id,
            Value::Null,
            Value::Null,
            json!({"loginSessionId":s["id"]}),
            false,
        )?);
        if let Err(e) = a.s.batch(writes, "VERSION_CONFLICT").await {
            if e.status == 409 {
                a.s.run("UPDATE auth_login_session SET revoked_at=COALESCE(revoked_at,?),session_revision=session_revision+1 WHERE id=? AND revoked_at IS NULL",vec![n.into(),s["id"].clone()]).await?;
            }
            return Err(e);
        }
        return Ok(result);
    }
    let digest = hash(&text(b, "code"));
    let p=a.s.one("SELECT p.*,t.client_id,t.redirect_uri,t.pkce_challenge,t.created_seq,t.status transaction_status,t.purpose,t.user_id transaction_user FROM auth_identity_proof p JOIN auth_product_transaction t ON t.id=p.transaction_id WHERE p.token_hash=? AND p.kind='LOGIN_CODE'",vec![digest.clone().into()]).await?;
    ensure(
        !p.is_null()
            && p["consumed_at"].is_null()
            && number(&p, "expires_at") > n
            && p["client_id"] == c["client_id"]
            && p["redirect_uri"] == b["redirectUri"]
            && contains(&parsed(&c, "redirects")?, &b["redirectUri"])
            && p["pkce_challenge"] == challenge(&text(b, "codeVerifier"))
            && p["transaction_status"] == "CONSUMED"
            && (p["purpose"] == "LOGIN" || p["purpose"] == "EMAIL_SIGNUP")
            && p["user_id"] == p["transaction_user"],
        401,
        "INVALID_GRANT",
    )?;
    let s = json!({"id":uuid(),"user_id":p["user_id"],"client_id":c["client_id"],"application_id":c["application_id"],"authenticated_at":n,"last_active_at":n,"absolute_expires_at":n+ABSOLUTE,"user_epoch":p["user_epoch"],"session_revision":0});
    let (result, new_tokens) = tokens(a, &s, n, 0)?;
    let mut writes=vec![client_guard(a,&c)?,a.s.guard("EXISTS(SELECT 1 FROM auth_identity_proof p JOIN auth_product_transaction t ON t.id=p.transaction_id JOIN auth_user_security us ON us.user_id=p.user_id JOIN auth_user u ON u.id=p.user_id WHERE p.token_hash=? AND p.consumed_at IS NULL AND p.expires_at>? AND p.user_epoch=us.session_epoch AND u.status='ACTIVE' AND t.created_seq>COALESCE(us.revoked_before_seq,0))",vec![digest.clone().into(),n.into()])?,a.s.statement("UPDATE auth_identity_proof SET consumed_at=? WHERE token_hash=?",vec![n.into(),digest.into()])?,a.s.statement("INSERT INTO auth_login_session(id,user_id,client_id,authenticated_at,last_active_at,absolute_expires_at,user_epoch,created_seq,identity_verified_at) VALUES (?,?,?,?,?,?,?,?,?)",vec![s["id"].clone(),s["user_id"].clone(),s["client_id"].clone(),n.into(),n.into(),(n+ABSOLUTE).into(),s["user_epoch"].clone(),p["created_seq"].clone(),n.into()])?];
    writes.extend(new_tokens);
    writes.push(a.s.audit(
        "account.v2.token",
        s["user_id"].clone(),
        &a.request_id,
        Value::Null,
        Value::Null,
        json!({"loginSessionId":s["id"]}),
        false,
    )?);
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(result)
}
async fn logout(a: &Auth, b: &Value, all: bool) -> Result<Value> {
    shape("LogoutRequest", b)?;
    let (s, t, digest) = credential(a, b).await?;
    let n = now();
    let key = a.header("Idempotency-Key");
    ensure((16..=160).contains(&key.len()), 400, "INVALID_REQUEST")?;
    let scope = if all {
        "ALL_MOLIS_PRODUCTS"
    } else {
        "CURRENT_LOGIN"
    };
    let keyhash = hash(&format!("{}:{scope}:{key}", text(&s, "id")));
    let result = if all {
        json!({"revokedScope":scope,"status":"REVOKED"})
    } else {
        json!({"revokedScope":scope,"status":"REVOKED","loginSessionId":s["id"]})
    };
    let receipt =
        a.s.one(
            "SELECT proof_hash FROM auth_logout_receipt WHERE request_key_hash=? AND expires_at>?",
            vec![keyhash.clone().into(), n.into()],
        )
        .await?;
    if !receipt.is_null() {
        ensure(receipt["proof_hash"] == digest, 409, "IDEMPOTENCY_CONFLICT")?;
        return Ok(result);
    }
    let valid = live(&s, n)
        && number(&t, "expires_at") > n
        && t["session_revision"] == s["session_revision"]
        && t["user_epoch"] == s["user_epoch"]
        && t.get("used_at").is_none_or(Value::is_null);
    if !valid {
        ensure(!all, 401, "SESSION_REVOKED")?;
        ensure(!live(&s, n), 401, "INVALID_CREDENTIALS")?;
        return Ok(json!({"revokedScope":scope,"status":"ALREADY_ENDED","loginSessionId":s["id"]}));
    }
    let c = client(a, &text(&s, "client_id")).await?;
    let mut writes = vec![
        client_guard(a, &c)?,
        session_guard(a, &s, n)?,
        a.s.statement(
            "INSERT INTO auth_security_sequence(kind,created_at) VALUES ('REVOCATION',?)",
            vec![n.into()],
        )?,
    ];
    let table = if b.get("refreshProof").is_some() {
        "auth_login_refresh_token"
    } else {
        "auth_login_access_token"
    };
    let unused = if b.get("refreshProof").is_some() {
        " AND used_at IS NULL"
    } else {
        ""
    };
    writes.push(a.s.guard(
        &format!("EXISTS(SELECT 1 FROM {table} WHERE token_hash=? AND expires_at>?{unused})"),
        vec![digest.clone().into(), n.into()],
    )?);
    if all {
        writes.push(a.s.statement("UPDATE auth_user_security SET session_epoch=session_epoch+1,revoked_before_seq=(SELECT MAX(seq) FROM auth_security_sequence),updated_at=? WHERE user_id=?",vec![n.into(),s["user_id"].clone()])?);
        writes.push(a.s.statement("UPDATE auth_login_session SET revoked_at=?,session_revision=session_revision+1 WHERE user_id=? AND revoked_at IS NULL",vec![n.into(),s["user_id"].clone()])?);
    } else {
        writes.push(a.s.statement("UPDATE auth_login_session SET revoked_at=?,session_revision=session_revision+1 WHERE id=?",vec![n.into(),s["id"].clone()])?);
    }
    writes.push(a.s.statement("INSERT INTO auth_logout_receipt VALUES (?,?,?,?,(SELECT MAX(seq) FROM auth_security_sequence),?,?)",vec![keyhash.into(),digest.into(),s["id"].clone(),scope.into(),n.into(),(n+RECEIPT).into()])?);
    writes.push(a.s.audit(
        if all {
            "account.v2.logout.all"
        } else {
            "account.v2.logout"
        },
        s["user_id"].clone(),
        &a.request_id,
        Value::Null,
        Value::Null,
        json!({"loginSessionId":s["id"]}),
        false,
    )?);
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(result)
}
pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    let implemented = matches!(
        (path, method.clone()),
        ("/api/v2/auth/token", Method::Post)
            | ("/api/v2/sessions/current", Method::Get)
            | ("/api/v2/sessions/current/activity", Method::Post)
            | ("/api/v2/sessions/current/logout", Method::Post)
            | ("/api/v2/sessions/logout-all", Method::Post)
    );
    ensure(implemented, 501, "UNIFIED_ACCOUNT_NOT_IMPLEMENTED")?;
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
    let result = if path.ends_with("/auth/token") {
        exchange(a, &b).await?
    } else if path.ends_with("logout-all") || path.ends_with("/logout") {
        logout(a, &b, path.ends_with("logout-all")).await?
    } else {
        if method == Method::Post {
            shape("ActivityRequest", &b)?;
        }
        let (s, t, _) = credential(a, &json!({})).await?;
        let n = now();
        ensure(
            live(&s, n)
                && number(&t, "expires_at") > n
                && t["session_revision"] == s["session_revision"]
                && t["user_epoch"] == s["user_epoch"],
            401,
            "SESSION_EXPIRED",
        )?;
        let c = client(a, &text(&s, "client_id")).await?;
        let mut writes = vec![client_guard(a, &c)?, session_guard(a, &s, n)?];
        if method == Method::Post {
            writes.push(a.s.statement("UPDATE auth_login_session SET last_active_at=MAX(last_active_at,?) WHERE id=? AND NOT EXISTS(SELECT 1 FROM auth_login_activity WHERE login_session_id=? AND event_id=?)",vec![n.into(),s["id"].clone(),s["id"].clone(),b["eventId"].clone()])?);
            writes.push(a.s.statement(
                "INSERT OR IGNORE INTO auth_login_activity VALUES (?,?,?,?)",
                vec![
                    s["id"].clone(),
                    b["eventId"].clone(),
                    b["kind"].clone(),
                    n.into(),
                ],
            )?);
        }
        a.s.batch(writes, "VERSION_CONFLICT").await?;
        view(&session(a, &text(&s, "id")).await?)
    };
    Ok(json_response(
        json!({"data":result,"requestId":a.request_id}),
        200,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_lifetimes_match_the_shared_contract() {
        let policy: Value = serde_json::from_str(include_str!(
            "../../../contracts/unified-account/policy.json"
        ))
        .unwrap();
        for (name, milliseconds) in [
            ("loginIdleSeconds", IDLE),
            ("loginAbsoluteSeconds", ABSOLUTE),
            ("accessTokenTtlSeconds", ACCESS),
            ("idempotencyTtlSeconds", RECEIPT),
        ] {
            assert_eq!(
                policy["defaults"][name].as_i64().unwrap() * 1000,
                milliseconds
            );
        }
    }
}
