//! Independent v2 sessions. External identity verification is supplied by AUTH-04/05.
use crate::{
    core::http::*,
    core::identity::Auth,
    core::security::{challenge, hash, secret, uuid},
};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Method};
const IDLE: i64 = 2592000000;
const ABSOLUTE: i64 = 7776000000;
const ACCESS: i64 = 900000;
const RECEIPT: i64 = 86400000;
const LIVE: &str = "s.revoked_at IS NULL AND u.status='ACTIVE' AND s.user_epoch=u.session_epoch AND s.last_active_at+2592000000>? AND s.absolute_expires_at>?";
pub(crate) const ACCESS_USER_ID: &str = "(SELECT s.user_id FROM auth_login_access_token t
    JOIN auth_login_session s ON s.id=t.login_session_id WHERE t.token_hash=?1)";
pub(crate) fn view(s: &Value) -> Value {
    json!({"loginSessionId":s["id"],"applicationId":s["application_id"],"clientId":s["client_id"],"authenticatedAt":iso(&s["authenticated_at"]),"lastActiveAt":iso(&s["last_active_at"]),"idleExpiresAt":iso(&json!(number(s,"last_active_at")+IDLE)),"absoluteExpiresAt":iso(&s["absolute_expires_at"]),"sessionRevision":s["session_revision"]})
}
const CLIENT_COLUMNS: &str =
    "c.client_id,c.application_id,c.client_type,c.status,c.version,c.policy_version,c.redirects,
     c.allowed_origins,e.version environment_version,
     e.id environment_id,e.kind,e.auth_origin,e.delivery_mode,e.provider_mode";
const CLIENT_POLICY_JOINS: &str =
    "JOIN auth_application app ON app.id=c.application_id AND app.status='ACTIVE'
    JOIN auth_environment e ON e.id=c.environment_id AND e.status='ACTIVE'";

fn client_config(a: &Auth) -> Result<&Value> {
    a.unified_config
        .as_deref()
        .ok_or_else(crate::core::contracts::unified_policy::invalid_configuration)
}
const CLIENT_CONFIG_FIELDS: [(&str, &str, &str); 5] = [
    ("id", "environment_id", "environmentId"),
    ("auth_origin", "auth_origin", "authOrigin"),
    ("kind", "kind", "kind"),
    ("delivery_mode", "delivery_mode", "deliveryMode"),
    ("provider_mode", "provider_mode", "providerMode"),
];

fn check_registered_client(c: &Value, config: &Value) -> Result<()> {
    ensure(
        !c["environment_id"].is_null()
            && CLIENT_CONFIG_FIELDS
                .iter()
                .all(|(_, field, key)| c[field] == config[key]),
        403,
        "POLICY_MISMATCH",
    )
}
fn check_origin(c: &Value, origin: &str) -> Result<()> {
    ensure(
        origin.is_empty() || contains(&parsed(c, "allowed_origins")?, &json!(origin)),
        403,
        "FORBIDDEN",
    )
}
pub(crate) async fn registered_client(a: &Auth, id: &str) -> Result<Value> {
    let config = client_config(a)?;
    let c =
        a.s.one(
            &format!(
                "SELECT {CLIENT_COLUMNS} FROM auth_client c {CLIENT_POLICY_JOINS}
             WHERE c.client_id=? AND c.status='ACTIVE'"
            ),
            vec![id.into()],
        )
        .await?;
    check_registered_client(&c, config)?;
    Ok(c)
}
pub(crate) async fn client(a: &Auth, id: &str) -> Result<Value> {
    let c = registered_client(a, id).await?;
    check_origin(&c, &a.header("Origin"))?;
    Ok(c)
}
pub(crate) fn client_guard(a: &Auth, c: &Value) -> Result<D1PreparedStatement> {
    a.s.guard("EXISTS(SELECT 1 FROM auth_client c JOIN auth_application app ON app.id=c.application_id JOIN auth_environment e ON e.id=c.environment_id WHERE c.client_id=? AND c.version=? AND c.policy_version=? AND e.version=? AND c.status='ACTIVE' AND app.status='ACTIVE' AND e.status='ACTIVE')",vec![c["client_id"].clone(),c["version"].clone(),c["policy_version"].clone(),c["environment_version"].clone()])
}
const SESSION_COLUMNS: &str =
    "s.*,c.application_id,u.session_epoch current_epoch,u.status user_status";
const SESSION_JOINS: &str =
    "JOIN auth_user u ON u.id=s.user_id JOIN auth_client c ON c.client_id=s.client_id";

pub(crate) async fn session(a: &Auth, id: &str) -> Result<Value> {
    a.s.one(
        &format!("SELECT {SESSION_COLUMNS} FROM auth_login_session s {SESSION_JOINS} WHERE s.id=?"),
        vec![id.into()],
    )
    .await
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
    a.s.guard(&format!("EXISTS(SELECT 1 FROM auth_login_session s JOIN auth_user u ON u.id=s.user_id WHERE s.id=? AND s.session_revision=? AND {LIVE})"),vec![s["id"].clone(),s["session_revision"].clone(),n.into(),n.into()])
}
struct Credential {
    session: Value,
    token: Value,
    digest: String,
    client: Value,
}

fn credential_statement(a: &Auth, digest: &str, refresh: bool) -> Result<D1PreparedStatement> {
    let (table, used_at) = if refresh {
        ("auth_login_refresh_token", "t.used_at")
    } else {
        ("auth_login_access_token", "NULL")
    };
    // Session existence and client policy have distinct error codes. The left
    // joins keep their absence distinguishable even when the token exists.
    a.s.statement(
        &format!("SELECT {CLIENT_COLUMNS},
             CASE WHEN u.id IS NOT NULL AND c.client_id IS NOT NULL
             THEN json_object(
               'id',s.id,'user_id',s.user_id,'client_id',s.client_id,'authenticated_at',s.authenticated_at,
               'last_active_at',s.last_active_at,'absolute_expires_at',s.absolute_expires_at,
               'user_epoch',s.user_epoch,'session_revision',s.session_revision,'created_seq',s.created_seq,
               'revoked_at',s.revoked_at,'identity_verified_at',s.identity_verified_at,
               'application_id',c.application_id,'current_epoch',u.session_epoch,'user_status',u.status
             ) END credential_session,
             json_object('expires_at',t.expires_at,'session_revision',t.session_revision,
                         'user_epoch',t.user_epoch,'used_at',{used_at}) credential_token
             FROM {table} t
             LEFT JOIN auth_login_session s ON s.id=t.login_session_id
             LEFT JOIN auth_user u ON u.id=s.user_id
             LEFT JOIN auth_client c ON c.client_id=s.client_id
             LEFT JOIN auth_application app
               ON app.id=c.application_id AND app.status='ACTIVE' AND c.status='ACTIVE'
             LEFT JOIN auth_environment e ON e.id=c.environment_id AND e.status='ACTIVE' AND app.id IS NOT NULL
             WHERE t.token_hash=?"),
        vec![digest.into()],
    )
}
fn credential_result(
    a: &Auth,
    mut row: Value,
    digest: String,
    refresh: Option<&Value>,
    origin: &str,
) -> Result<Credential> {
    ensure(
        !row["credential_session"].is_null(),
        401,
        "INVALID_CREDENTIALS",
    )?;
    let session = parsed(&row, "credential_session")?;
    ensure(
        refresh.is_none_or(|p| p["clientId"] == session["client_id"]),
        401,
        "INVALID_CREDENTIALS",
    )?;
    check_registered_client(&row, client_config(a)?)?;
    check_origin(&row, origin)?;
    let token = parsed(&row, "credential_token")?;
    if let Some(client) = row.as_object_mut() {
        client.remove("credential_session");
        client.remove("credential_token");
    }
    Ok(Credential {
        session,
        token,
        digest,
        client: row,
    })
}
fn token_digest(raw: &str) -> Result<String> {
    ensure(token(raw), 401, "INVALID_CREDENTIALS")?;
    Ok(hash(raw))
}
pub(crate) fn bearer(authorization: &str) -> &str {
    authorization.strip_prefix("Bearer ").unwrap_or("")
}
async fn credential(a: &Auth, b: &Value) -> Result<Credential> {
    let refresh = b.get("refreshProof");
    let authorization = a.header("Authorization");
    let digest = if let Some(p) = refresh {
        ensure(authorization.is_empty(), 400, "INVALID_REQUEST")?;
        token_digest(&text(p, "refreshToken"))?
    } else {
        token_digest(bearer(&authorization))?
    };
    let row =
        a.s.first(credential_statement(a, &digest, refresh.is_some())?)
            .await?;
    credential_result(a, row, digest, refresh, &a.header("Origin"))
}
pub(crate) fn active_lookup(a: &Auth, raw: &str) -> Result<(String, D1PreparedStatement)> {
    let digest = token_digest(raw)?;
    let statement = credential_statement(a, &digest, false)?;
    Ok((digest, statement))
}
/// Principal rows eligible to execute the data part of a read snapshot. The
/// credential result remains the source of HTTP errors and is read in the same
/// transaction, including when this query returns no principal.
pub(crate) fn active_actor(a: &Auth, digest: &str) -> (String, Vec<Value>) {
    let config = a.unified_config.as_deref().unwrap_or(&Value::Null);
    let origin = a.header("Origin");
    let n = now();
    let mut args = vec![digest.into(), n.into(), n.into(), n.into()];
    for (_, _, key) in CLIENT_CONFIG_FIELDS {
        args.push(config[key].as_str().map_or(Value::Null, Value::from));
    }
    args.extend([origin.clone().into(), origin.into()]);
    let config_matches = CLIENT_CONFIG_FIELDS
        .map(|(column, _, _)| format!("e.{column}=?"))
        .join(" AND ");
    (
        format!(
            "SELECT s.user_id,s.client_id FROM auth_login_access_token t
             JOIN auth_login_session s ON s.id=t.login_session_id
             JOIN auth_user u ON u.id=s.user_id
             JOIN auth_client c ON c.client_id=s.client_id AND c.status='ACTIVE'
             {CLIENT_POLICY_JOINS}
             WHERE t.token_hash=? AND {LIVE} AND t.expires_at>?
             AND t.user_epoch=s.user_epoch AND t.session_revision=s.session_revision
             AND {config_matches}
             AND (?='' OR EXISTS(SELECT 1 FROM json_each(c.allowed_origins)
                                 WHERE type='text' AND value=?))"
        ),
        args,
    )
}
pub(crate) fn active_result(
    a: &Auth,
    row: Value,
    digest: String,
    origin: &str,
) -> Result<(Value, Value)> {
    check_active(credential_result(a, row, digest, None, origin)?, now())
}
fn check_active(credential: Credential, n: i64) -> Result<(Value, Value)> {
    let Credential {
        session: mut s,
        token: t,
        digest,
        client: c,
    } = credential;
    ensure(
        live(&s, n)
            && number(&t, "expires_at") > n
            && t["session_revision"] == s["session_revision"]
            && t["user_epoch"] == s["user_epoch"],
        401,
        "SESSION_EXPIRED",
    )?;
    s["access_hash"] = digest.into();
    s["access_expires_at"] = t["expires_at"].clone();
    Ok((s, c))
}
/// A v2 access credential, including its expiry for the final commit guard.
pub(crate) async fn active(a: &Auth) -> Result<(Value, Value)> {
    check_active(credential(a, &json!({})).await?, now())
}
pub(crate) async fn web_login_sessions(a: &Auth, access_token: &str) -> Result<Value> {
    const LIMIT: usize = 100;
    let (digest, credential) = active_lookup(a, access_token)?;
    let n = now();
    // Scope the list to the browser's verified login and its environment.
    // The credential and its list are read from the same database snapshot.
    let list = a.s.statement(
        &format!(
            "SELECT app.name product_name,c.client_type,s.last_active_at,s.id=current_login.id AS is_current
             FROM auth_login_access_token current_token
             JOIN auth_login_session current_login ON current_login.id=current_token.login_session_id
             JOIN auth_client current_policy ON current_policy.client_id=current_login.client_id
             JOIN auth_login_session s ON s.user_id=current_login.user_id
             {SESSION_JOINS} {CLIENT_POLICY_JOINS}
             WHERE current_token.token_hash=? AND {LIVE} AND c.status='ACTIVE'
               AND e.id=current_policy.environment_id
             ORDER BY is_current DESC,s.last_active_at DESC,s.id
             LIMIT ?"
        ),
        vec![digest.clone().into(), n.into(), n.into(), ((LIMIT + 1) as i64).into()],
    )?;
    let [credentials, rows] =
        a.s.batch_read(vec![credential, list])
            .await?
            .try_into()
            .map_err(|_| Failure::unavailable())?;
    active_result(
        a,
        credentials.into_iter().next().unwrap_or(Value::Null),
        digest,
        "",
    )?;
    let has_more = rows.len() > LIMIT;
    let items: Vec<_> = rows
        .into_iter()
        .take(LIMIT)
        .map(|row| {
            json!({
                "productName": row["product_name"],
                "clientType": row["client_type"],
                "lastActiveAt": iso(&row["last_active_at"]),
                "current": number(&row, "is_current") == 1,
            })
        })
        .collect();
    Ok(json!({"items": items, "hasMore": has_more}))
}
pub(crate) fn active_guard(a: &Auth, s: &Value) -> Result<D1PreparedStatement> {
    a.s.guard(&format!("EXISTS(SELECT 1 FROM auth_login_session s JOIN auth_user u ON u.id=s.user_id JOIN auth_login_access_token t ON t.login_session_id=s.id WHERE s.id=? AND s.session_revision=? AND {LIVE} AND t.token_hash=? AND t.expires_at>? AND t.user_epoch=s.user_epoch AND t.session_revision=s.session_revision)"),vec![s["id"].clone(),s["session_revision"].clone(),now().into(),now().into(),s["access_hash"].clone(),now().into()])
}
pub(crate) fn tokens(
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
async fn revoke_replayed_refresh(a: &Auth, session: &Value, digest: &str, n: i64) -> Result<()> {
    a.s.batch(
        vec![a.s.statement(
            "UPDATE auth_login_session SET revoked_at=COALESCE(revoked_at,?),session_revision=session_revision+1
             WHERE id=? AND revoked_at IS NULL AND EXISTS(
               SELECT 1 FROM auth_login_refresh_token r WHERE r.token_hash=? AND r.login_session_id=auth_login_session.id AND r.used_at IS NOT NULL
             )",
            vec![n.into(), session["id"].clone(), digest.into()],
        )?],
        "VERSION_CONFLICT",
    )
    .await
}
async fn exchange(a: &Auth, b: &Value) -> Result<Value> {
    shape("TokenRequest", b)?;
    let c = client(a, &text(b, "clientId")).await?;
    let n = now();
    a.rate_ip("auth:token", 120).await?;
    if b["grantType"] == "refresh_token" {
        let digest = hash(&text(b, "refreshToken"));
        let s =
            a.s.one(
                &format!("SELECT {SESSION_COLUMNS},t.generation token_generation,
                        t.session_revision token_session_revision,t.user_epoch token_user_epoch,
                        t.expires_at token_expires_at,t.used_at token_used_at
                 FROM auth_login_refresh_token t JOIN auth_login_session s ON s.id=t.login_session_id
                 {SESSION_JOINS} WHERE t.token_hash=?"),
                vec![digest.clone().into()],
            )
            .await?;
        ensure(
            !s.is_null() && s["client_id"] == c["client_id"],
            401,
            "INVALID_GRANT",
        )?;
        if !s["token_used_at"].is_null() {
            revoke_replayed_refresh(a, &s, &digest, n).await?;
            return Err(Failure {
                status: 401,
                code: "INVALID_GRANT",
            });
        }
        ensure(
            live(&s, n)
                && number(&s, "token_expires_at") > n
                && s["token_user_epoch"] == s["user_epoch"]
                && s["token_session_revision"] == s["session_revision"],
            401,
            "SESSION_EXPIRED",
        )?;
        let (result, new_tokens) = tokens(a, &s, n, number(&s, "token_generation") + 1)?;
        let mut writes=vec![client_guard(a,&c)?,session_guard(a,&s,n)?,a.s.guard("EXISTS(SELECT 1 FROM auth_login_refresh_token WHERE token_hash=? AND used_at IS NULL AND expires_at>?)",vec![digest.clone().into(),n.into()])?,a.s.statement("UPDATE auth_login_refresh_token SET used_at=? WHERE token_hash=?",vec![n.into(),digest.as_str().into()])?];
        writes.extend(new_tokens);
        writes.push(crate::audit::account(
            a,
            "account.token",
            s["user_id"].clone(),
            &s["client_id"],
            json!({"loginSessionId":s["id"]}),
        )?);
        if let Err(e) = a.s.batch(writes, "VERSION_CONFLICT").await {
            if e.status == 409 {
                revoke_replayed_refresh(a, &s, &digest, n).await?;
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
    let mut writes = vec![
        client_guard(a, &c)?,
        a.s.guard("EXISTS(SELECT 1 FROM auth_identity_proof p JOIN auth_product_transaction t ON t.id=p.transaction_id JOIN auth_user u ON u.id=p.user_id WHERE p.token_hash=? AND p.consumed_at IS NULL AND p.expires_at>? AND p.user_epoch=u.session_epoch AND u.status='ACTIVE' AND t.created_seq>COALESCE(u.revoked_before_seq,0))",vec![digest.clone().into(),n.into()])?,
        a.s.statement("UPDATE auth_identity_proof SET consumed_at=? WHERE token_hash=?",vec![n.into(),digest.into()])?,
    ];
    let result = create_login(a, &c, &p, n, &mut writes)?;
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(result)
}

pub(crate) async fn issue_browser_login(
    a: &Auth,
    transaction: &Value,
    client: &Value,
) -> Result<Value> {
    ensure(
        transaction["purpose"] == "LOGIN" && transaction["status"] == "VERIFIED",
        409,
        "VERSION_CONFLICT",
    )?;
    let n = now();
    let mut writes = vec![
        client_guard(a, client)?,
        a.s.guard(
            "EXISTS(SELECT 1 FROM auth_product_transaction WHERE id=? AND status='VERIFIED' AND expires_at>?
             AND user_id=? AND user_epoch=? AND created_seq=?)",
            vec![transaction["id"].clone(), n.into(), transaction["user_id"].clone(),
                 transaction["user_epoch"].clone(), transaction["created_seq"].clone()],
        )?,
        crate::auth::registration::boundary(a, transaction, &text(transaction, "user_id"), number(transaction, "user_epoch"))?,
        a.s.statement("UPDATE auth_product_transaction SET status='CONSUMED',completed_at=? WHERE id=?",
            vec![n.into(), transaction["id"].clone()])?,
    ];
    let result = create_login(a, client, transaction, n, &mut writes)?;
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(result)
}

fn create_login(
    a: &Auth,
    client: &Value,
    verified: &Value,
    n: i64,
    writes: &mut Vec<D1PreparedStatement>,
) -> Result<Value> {
    let session = json!({"id":uuid(),"user_id":verified["user_id"],"client_id":client["client_id"],"application_id":client["application_id"],"authenticated_at":n,"last_active_at":n,"absolute_expires_at":n+ABSOLUTE,"user_epoch":verified["user_epoch"],"session_revision":0});
    let (result, tokens) = tokens(a, &session, n, 0)?;
    writes.push(a.s.statement(
        "INSERT INTO auth_login_session(id,user_id,client_id,authenticated_at,last_active_at,absolute_expires_at,user_epoch,created_seq,identity_verified_at)
         VALUES (?,?,?,?,?,?,?,?,?)",
        vec![session["id"].clone(),session["user_id"].clone(),session["client_id"].clone(),n.into(),n.into(),(n+ABSOLUTE).into(),session["user_epoch"].clone(),verified["created_seq"].clone(),n.into()],
    )?);
    writes.extend(tokens);
    writes.push(crate::audit::account(
        a,
        "account.token",
        session["user_id"].clone(),
        &session["client_id"],
        json!({"loginSessionId":session["id"]}),
    )?);
    Ok(result)
}

async fn logout(a: &Auth, b: &Value, all: bool) -> Result<Value> {
    shape("LogoutRequest", b)?;
    let Credential {
        session: s,
        token: t,
        digest,
        client: c,
    } = credential(a, b).await?;
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
        writes.push(a.s.statement("UPDATE auth_user SET session_epoch=session_epoch+1,revoked_before_seq=(SELECT MAX(seq) FROM auth_security_sequence),updated_at=? WHERE id=?",vec![n.into(),s["user_id"].clone()])?);
        writes.push(a.s.statement("UPDATE auth_login_session SET revoked_at=?,session_revision=session_revision+1 WHERE user_id=? AND revoked_at IS NULL",vec![n.into(),s["user_id"].clone()])?);
    } else {
        writes.push(a.s.statement("UPDATE auth_login_session SET revoked_at=?,session_revision=session_revision+1 WHERE id=?",vec![n.into(),s["id"].clone()])?);
    }
    writes.push(a.s.statement("INSERT INTO auth_logout_receipt(request_key_hash,proof_hash,login_session_id,scope,created_at,expires_at) VALUES (?,?,?,?,?,?)",vec![keyhash.into(),digest.into(),s["id"].clone(),scope.into(),n.into(),(n+RECEIPT).into()])?);
    writes.push(crate::audit::account(
        a,
        if all {
            "account.logout.all"
        } else {
            "account.logout"
        },
        s["user_id"].clone(),
        &s["client_id"],
        json!({"loginSessionId":s["id"]}),
    )?);
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(result)
}
async fn activity(a: &Auth, b: &Value) -> Result<Value> {
    shape("ActivityRequest", b)?;
    let credential = credential(a, &json!({})).await?;
    let n = now();
    let (mut s, c) = check_active(credential, n)?;
    a.rate("account:activity", &text(&s, "user_id"), 120, 60_000)
        .await?;
    let session_id = s["id"].clone();
    let event_id = b["eventId"].clone();
    let writes = vec![
        client_guard(a, &c)?,
        session_guard(a, &s, n)?,
        a.s.statement(
            "UPDATE auth_login_session SET last_active_at=MAX(last_active_at,?) WHERE id=?
             AND NOT EXISTS(SELECT 1 FROM auth_login_activity WHERE login_session_id=? AND event_id=?)",
            vec![n.into(), session_id.clone(), session_id.clone(), event_id.clone()],
        )?,
        a.s.statement(
            "INSERT OR IGNORE INTO auth_login_activity(login_session_id,event_id,kind) VALUES (?,?,?)",
            vec![session_id.clone(), event_id, b["kind"].clone()],
        )?,
    ];
    // Read the value inside the guarded transaction, including on a replay that
    // skipped the update and after another request advanced the session clock.
    let returning = a.s.statement(
        "SELECT last_active_at FROM auth_login_session WHERE id=?",
        vec![session_id],
    )?;
    let row =
        a.s.batch_returning(writes, returning, "VERSION_CONFLICT")
            .await?;
    s["last_active_at"] = row["last_active_at"].clone();
    Ok(view(&s))
}
pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Value> {
    let implemented = matches!(
        (path, method.clone()),
        ("/api/v1/auth/token", Method::Post)
            | ("/api/v1/sessions/current", Method::Get)
            | ("/api/v1/sessions/current/activity", Method::Post)
            | ("/api/v1/sessions/current/logout", Method::Post)
            | ("/api/v1/sessions/logout-all", Method::Post)
    );
    ensure(implemented, 501, "UNIFIED_ACCOUNT_NOT_IMPLEMENTED")?;
    let b = if method == Method::Post {
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/json"),
            415,
            "INVALID_REQUEST",
        )?;
        serde_json::from_str(&bounded(&mut a.request, 16384).await?)?
    } else {
        json!({})
    };
    let result = if path.ends_with("/auth/token") {
        exchange(a, &b).await?
    } else if path.ends_with("logout-all") || path.ends_with("/logout") {
        logout(a, &b, path.ends_with("logout-all")).await?
    } else if method == Method::Post {
        activity(a, &b).await?
    } else {
        let (s, _) = active(a).await?;
        view(&s)
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_lifetimes_match_the_shared_contract() {
        let policy: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/unified-account/policy.json"
        )))
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
