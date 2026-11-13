//! AUTH-06 account views and atomic, proof-bound mutations.
use crate::{
    http::*,
    identity::Auth,
    login_sessions as sessions, registration,
    security::*,
    sensitive_transactions::{self as sensitive, shape},
};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Method, Response};
type Writes = Vec<D1PreparedStatement>;
async fn security(a: &Auth, user: &str) -> Result<Value> {
    a.s.one(
        "SELECT * FROM auth_user_security WHERE user_id=?",
        vec![user.into()],
    )
    .await
}
async fn user_view(a: &Auth, user: &str) -> Result<Value> {
    let u=a.s.one("SELECT u.*,s.account_version,COALESCE((SELECT canonical_email FROM auth_user_email WHERE user_id=u.id AND verified_at IS NOT NULL ORDER BY id LIMIT 1),(SELECT p.email FROM auth_external_identity x JOIN auth_external_profile p ON p.issuer=x.issuer AND p.subject=x.subject WHERE x.user_id=u.id AND p.email IS NOT NULL ORDER BY x.created_at,x.id LIMIT 1)) AS email FROM auth_user u JOIN auth_user_security s ON s.user_id=u.id WHERE u.id=?",vec![user.into()]).await?;
    Ok(
        json!({"issuer":a.origin,"userId":user,"displayName":u["display_name"],"email":u["email"],"avatarUrl":u["avatar_data"],"version":u["account_version"]}),
    )
}
async fn password_enabled(a: &Auth, user: &str) -> Result<bool> {
    Ok(!a
        .s
        .one(
            "SELECT user_id FROM auth_local_credential WHERE user_id=?",
            vec![user.into()],
        )
        .await?
        .is_null())
}
fn method_view(a: &Auth, row: &Value, c: &Value, password: bool) -> Value {
    let kind = text(row, "type");
    let target = text(row, "target");
    let verified = !row["verified_at"].is_null();
    let masked = match kind.as_str() {
        "EMAIL" => format!(
            "{}***@{}",
            target.chars().next().unwrap_or('*'),
            target.split('@').nth(1).unwrap_or("***")
        ),
        "PHONE" => {
            let number = target.strip_prefix("+86").unwrap_or(&target);
            format!(
                "+86 {}****{}",
                number.chars().take(3).collect::<String>(),
                number.chars().skip(7).collect::<String>()
            )
        }
        "GOOGLE" => row["provider_email"]
            .as_str()
            .unwrap_or("Google 账号")
            .to_owned(),
        "GITHUB" => row["provider_username"]
            .as_str()
            .map(|name| format!("@{name}"))
            .unwrap_or_else(|| "GitHub 账号".to_owned()),
        _ => format!(
            "{kind} · …{}",
            target
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>()
        ),
    };
    let usable = match kind.as_str() {
        "EMAIL" => verified && password,
        "PHONE" => {
            verified
                && (c["delivery_mode"] == "MOCK"
                    || (c["delivery_mode"] == "LIVE" && crate::sms_auth::configured(a)))
        }
        "GOOGLE" if c["provider_mode"] == "LIVE" => {
            verified
                && row["issuer"] == crate::google_login::ISSUER
                && crate::google_login::Google::configured(a).is_ok()
        }
        "GITHUB" if c["provider_mode"] == "LIVE" => {
            verified
                && row["issuer"] == crate::github_login::ISSUER
                && crate::github_login::Github::configured(a).is_ok()
        }
        _ => {
            c["provider_mode"] == "MOCK"
                && row["issuer"]
                    == format!(
                        "https://mock.{}.invalid/{}",
                        kind.to_lowercase(),
                        text(c, "environment_id")
                    )
        }
    };
    json!({"bindingId":row["id"],"type":kind,"maskedLabel":masked.chars().take(254).collect::<String>(),"verified":verified,"usableForLogin":usable})
}
async fn methods(a: &Auth, user: &str, c: &Value) -> Result<Vec<Value>> {
    let rows=a.s.all("SELECT id,'EMAIL' type,canonical_email target,verified_at,NULL issuer,NULL provider_email,NULL provider_username FROM auth_user_email WHERE user_id=? UNION ALL SELECT id,'PHONE',canonical_phone,verified_at,NULL,NULL,NULL FROM auth_user_phone WHERE user_id=? UNION ALL SELECT x.id,x.provider,x.subject,x.created_at,x.issuer,p.email,p.username FROM auth_external_identity x LEFT JOIN auth_external_profile p ON p.issuer=x.issuer AND p.subject=x.subject WHERE x.user_id=? AND x.provider IN ('GOOGLE','GITHUB') ORDER BY type,id",vec![user.into(),user.into(),user.into()]).await?;
    let password = password_enabled(a, user).await?;
    Ok(rows
        .iter()
        .map(|r| method_view(a, r, c, password))
        .collect())
}
fn version_guard(a: &Auth, user: &str, us: &Value) -> Result<D1PreparedStatement> {
    a.s.guard("EXISTS(SELECT 1 FROM auth_user_security WHERE user_id=? AND account_version=? AND identity_version=? AND session_epoch=?)",vec![user.into(),us["account_version"].clone(),us["identity_version"].clone(),us["session_epoch"].clone()])
}
async fn proof(a: &Auth, s: &Value, us: &Value, raw: &str, kind: &str) -> Result<Value> {
    ensure(token(raw), 401, "INVALID_CREDENTIALS")?;
    let p=a.s.one("SELECT p.*,t.purpose,t.method,t.operation,t.target,t.binding_id,t.created_seq,t.client_id,t.status transaction_status FROM auth_identity_proof p JOIN auth_product_transaction t ON t.id=p.transaction_id WHERE p.token_hash=? AND p.kind=? AND p.consumed_at IS NULL AND p.expires_at>?",vec![hash(raw).into(),kind.into(),now().into()]).await?;
    ensure(
        !p.is_null()
            && p["user_id"] == s["user_id"]
            && p["login_session_id"] == s["id"]
            && p["client_id"] == s["client_id"]
            && p["user_epoch"] == s["user_epoch"]
            && p["session_revision"] == s["session_revision"]
            && p["identity_version"] == us["identity_version"]
            && p["transaction_status"] == "CONSUMED"
            && number(&p, "created_seq") > number(us, "revoked_before_seq"),
        401,
        "INVALID_CREDENTIALS",
    )?;
    Ok(p)
}
fn consume(a: &Auth, p: &Value) -> Result<Writes> {
    Ok(vec![
    a.s.guard("EXISTS(SELECT 1 FROM auth_identity_proof WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?)",vec![p["token_hash"].clone(),now().into()])?,
    a.s.statement("UPDATE auth_identity_proof SET consumed_at=? WHERE token_hash=?",vec![now().into(),p["token_hash"].clone()])?])
}
fn operation(a: &Auth, p: &Value, op: &str, target: &Value) -> Result<D1PreparedStatement> {
    ensure(
        p["purpose"] == "REAUTH" && p["operation"] == op && parsed(p, "target")? == *target,
        403,
        "FORBIDDEN",
    )?;
    sensitive::owner_guard(a, &text(p, "user_id"), &parsed(p, "verified_identity")?)
}
// Existing sessions remain usable; unfinished authentication predating an identity
// change must not log back in through a binding that has just been removed.
pub(crate) fn identity_changed(a: &Auth, user: &str) -> Result<Writes> {
    Ok(vec![
        a.s.statement("INSERT INTO auth_security_sequence(kind,created_at) SELECT 'REVOCATION',? WHERE EXISTS(SELECT 1 FROM auth_user_security WHERE user_id=?)",vec![now().into(),user.into()])?,
        a.s.statement("UPDATE auth_user_security SET account_version=account_version+1,identity_version=identity_version+1,revoked_before_seq=(SELECT MAX(seq) FROM auth_security_sequence),updated_at=? WHERE user_id=?",vec![now().into(),user.into()])?
    ])
}
pub(crate) fn revoke_password(a: &Auth, user: &str, keep: Option<&Value>) -> Result<Writes> {
    let n = now();
    let kept = keep.map(|s| s["id"].clone()).unwrap_or(Value::Null);
    let mut w=vec![
        a.s.statement("INSERT INTO auth_security_sequence(kind,created_at) VALUES ('REVOCATION',?)",vec![n.into()])?,
        a.s.statement("UPDATE auth_user_security SET account_version=account_version+1,identity_version=identity_version+1,session_epoch=session_epoch+1,revoked_before_seq=(SELECT MAX(seq) FROM auth_security_sequence),updated_at=? WHERE user_id=?",vec![n.into(),user.into()])?,
        a.s.statement("UPDATE auth_login_session SET revoked_at=?,session_revision=session_revision+1 WHERE user_id=? AND revoked_at IS NULL AND (? IS NULL OR id<>?)",vec![n.into(),user.into(),kept.clone(),kept.clone()])?,
    ];
    if keep.is_some() {
        w.push(a.s.statement("UPDATE auth_login_session SET user_epoch=(SELECT session_epoch FROM auth_user_security WHERE user_id=?),session_revision=session_revision+1 WHERE id=?",vec![user.into(),kept.clone()])?);
        for table in ["auth_login_access_token", "auth_login_refresh_token"] {
            w.push(a.s.statement(&format!("UPDATE {table} SET user_epoch=(SELECT user_epoch FROM auth_login_session WHERE id=?),session_revision=(SELECT session_revision FROM auth_login_session WHERE id=?) WHERE login_session_id=?"),vec![kept.clone(),kept.clone(),kept.clone()])?);
        }
    }
    Ok(w)
}
async fn encoded_password(a: &Auth, b: &Value) -> Result<String> {
    encode(&text(b, "newPassword"), &a.env).await.map_err(|e| {
        if e.status == 400 {
            Failure {
                status: 400,
                code: "INVALID_REQUEST",
            }
        } else {
            e
        }
    })
}
async fn mutation(
    a: &Auth,
    s: &Value,
    c: &Value,
    b: &Value,
    us: &Value,
    op: &str,
    id: &str,
) -> Result<(Value, Writes)> {
    let user = text(s, "user_id");
    let version = number(us, "account_version") + 1;
    ensure(
        b["expectedVersion"] == us["account_version"],
        409,
        "VERSION_CONFLICT",
    )?;
    if op == "profile" {
        let mut view = user_view(a, &user).await?;
        if b.get("displayName").is_some() {
            view["displayName"] = name(&b["displayName"])
                .map_err(|_| Failure {
                    status: 400,
                    code: "INVALID_REQUEST",
                })?
                .into();
        }
        if let Some(image) = b.get("avatarDataUrl") {
            view["avatarUrl"] = avatar(image).map_err(|_| Failure {
                status: 400,
                code: "INVALID_REQUEST",
            })?;
        }
        view["version"] = version.into();
        let mut w=vec![a.s.statement("UPDATE auth_user SET display_name=?,avatar_data=?,updated_at=? WHERE id=?",vec![view["displayName"].clone(),view["avatarUrl"].clone(),now().into(),user.clone().into()])?,a.s.statement("UPDATE auth_user_security SET account_version=account_version+1,updated_at=? WHERE user_id=?",vec![now().into(),user.into()])?];
        w.push(a.s.statement("INSERT INTO auth_profile_customization(user_id,name_customized,avatar_customized) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET name_customized=MAX(name_customized,excluded.name_customized),avatar_customized=MAX(avatar_customized,excluded.avatar_customized)",vec![s["user_id"].clone(),json!(i64::from(b.get("displayName").is_some())),json!(i64::from(b.get("avatarDataUrl").is_some()))])?);
        return Ok((view, w));
    }
    let p = proof(a, s, us, &text(b, "operationProof"), "OPERATION").await?;
    let mut writes = Vec::new();
    if op == "password" {
        writes.push(operation(
            a,
            &p,
            "CHANGE_PASSWORD",
            &json!({"kind":"PASSWORD"}),
        )?);
        // Passwordless accounts authenticate through another bound method; no old-password dead end.
        let encoded = encoded_password(a, b).await?;
        writes.extend(consume(a, &p)?);
        writes.push(a.s.statement("INSERT INTO auth_local_credential VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash,changed_at=excluded.changed_at",vec![user.clone().into(),encoded.into(),now().into()])?);
        writes.extend(revoke_password(a, &user, Some(s))?);
        let mut kept = s.clone();
        kept["session_revision"] = (number(s, "session_revision") + 1).into();
        return Ok((
            json!({"passwordChanged":true,"keptLoginSessionId":s["id"],"session":sessions::view(&kept)}),
            writes,
        ));
    }
    let mut list = methods(a, &user, c).await?;
    if op != "bind" {
        let existing = sensitive::binding(a, &user, id).await?;
        ensure(existing["type"] != "EMAIL", 403, "FORBIDDEN")?;
        list.retain(|m| m["bindingId"] != id);
    }
    if op == "unlink" {
        writes.push(operation(a, &p, "UNLINK_METHOD", &json!({"bindingId":id}))?);
    } else {
        let new = proof(a, s, us, &text(b, "newIdentityProof"), "NEW_IDENTITY").await?;
        ensure(
            (op == "bind" && new["purpose"] == "BIND")
                || (op == "replace" && new["purpose"] == "REPLACE" && new["binding_id"] == id),
            403,
            "FORBIDDEN",
        )?;
        let identity = parsed(&new, "verified_identity")?;
        ensure(identity["type"] != "EMAIL", 403, "FORBIDDEN")?;
        writes.push(operation(
            a,
            &p,
            if op == "bind" {
                "BIND_METHOD"
            } else {
                "REPLACE_METHOD"
            },
            &if op == "bind" {
                json!({"method":identity["type"]})
            } else {
                json!({"bindingId":id})
            },
        )?);
        let binding_id = uuid();
        let n = now();
        match text(&identity, "type").as_str() {
            "EMAIL" => writes.push(a.s.statement(
                "INSERT INTO auth_user_email VALUES (?,?,?,?,?)",
                vec![
                    binding_id.clone().into(),
                    user.clone().into(),
                    identity["target"].clone(),
                    n.into(),
                    n.into(),
                ],
            )?),
            "PHONE" => writes.push(a.s.statement(
                "INSERT INTO auth_user_phone VALUES (?,?,?,?,?)",
                vec![
                    binding_id.clone().into(),
                    user.clone().into(),
                    identity["target"].clone(),
                    n.into(),
                    n.into(),
                ],
            )?),
            "GOOGLE" | "GITHUB" => writes.push(a.s.statement(
                "INSERT INTO auth_external_identity VALUES (?,?,?,?,?,?)",
                vec![
                    binding_id.clone().into(),
                    user.clone().into(),
                    identity["type"].clone(),
                    identity["issuer"].clone(),
                    identity["subject"].clone(),
                    n.into(),
                ],
            )?),
            _ => {
                return Err(Failure {
                    status: 400,
                    code: "INVALID_REQUEST",
                });
            }
        }
        if matches!(text(&identity, "type").as_str(), "GOOGLE" | "GITHUB") {
            writes.extend(crate::external_profile::save(a, &identity, &user)?);
        }
        let row = json!({"provider_username":identity["profile"]["username"],"provider_email":identity["profile"]["email"],"id":binding_id,"type":identity["type"],"target":if identity.get("target").is_some(){identity["target"].clone()}else{identity["subject"].clone()},"issuer":identity["issuer"],"verified_at":n});
        list.push(method_view(a, &row, c, password_enabled(a, &user).await?));
        writes.extend(consume(a, &new)?);
    }
    ensure(list.len() <= 20, 400, "INVALID_REQUEST")?;
    ensure(
        list.iter().any(|x| x["usableForLogin"] == true),
        409,
        "LAST_LOGIN_METHOD",
    )?;
    if op != "bind" {
        for table in [
            "auth_user_email",
            "auth_user_phone",
            "auth_external_identity",
        ] {
            writes.push(a.s.statement(
                &format!("DELETE FROM {table} WHERE id=? AND user_id=?"),
                vec![id.into(), user.clone().into()],
            )?);
        }
    }
    writes.extend(consume(a, &p)?);
    writes.extend(identity_changed(a, &user)?);
    Ok((json!({"loginMethods":list,"version":version}), writes))
}
async fn replay(
    a: &Auth,
    s: &Value,
    b: &Value,
    op: &str,
    target: &str,
    key: &str,
) -> Result<Option<Value>> {
    let row=a.s.one("SELECT * FROM auth_management_result WHERE actor_user_id=? AND client_id=? AND operation=? AND target=? AND idempotency_key_hash=? AND expires_at>?",vec![s["user_id"].clone(),s["client_id"].clone(),op.into(),target.into(),key.into(),now().into()]).await?;
    if row.is_null() {
        return Ok(None);
    }
    ensure(
        row["request_hash"] == hash(&b.to_string()),
        409,
        "IDEMPOTENCY_CONFLICT",
    )?;
    let response = parsed(&row, "response_json")?;
    ensure(response["loginSessionId"] == s["id"], 403, "FORBIDDEN")?;
    Ok(Some(response["data"].clone()))
}
async fn manage(
    a: &Auth,
    s: &Value,
    c: &Value,
    b: &Value,
    op: &str,
    target: &str,
) -> Result<Value> {
    let raw = a.header("Idempotency-Key");
    ensure(
        (16..=128).contains(&raw.chars().count()),
        400,
        "INVALID_REQUEST",
    )?;
    let key = hash(&raw);
    if let Some(result) = replay(a, s, b, op, target, &key).await? {
        return Ok(result);
    }
    let us = security(a, &text(s, "user_id")).await?;
    let built = mutation(a, s, c, b, &us, op, target).await;
    let attempt: Result<Value>=async {
        let (result,mut writes)=built?;
        writes.insert(0,version_guard(a,&text(s,"user_id"),&us)?);
        writes.insert(0,sessions::client_guard(a,c)?);
        writes.insert(0,sessions::active_guard(a,s)?);
        writes.push(a.s.audit(&format!("account.v2.{op}"),s["user_id"].clone(),&a.request_id,Value::Null,Value::Null,Value::Null,false)?);
        writes.push(a.s.statement("DELETE FROM auth_management_result WHERE actor_user_id=? AND client_id=? AND operation=? AND target=? AND idempotency_key_hash=? AND expires_at<=?",vec![s["user_id"].clone(),s["client_id"].clone(),op.into(),target.into(),key.clone().into(),now().into()])?);
        writes.push(a.s.statement("INSERT INTO auth_management_result VALUES (?,?,?,?,?,?,200,?,?,?)",vec![s["user_id"].clone(),s["client_id"].clone(),op.into(),target.into(),key.clone().into(),hash(&b.to_string()).into(),json!({"loginSessionId":s["id"],"data":result}).to_string().into(),now().into(),(now()+86400000).into()])?);
        a.s.batch(writes,"VERSION_CONFLICT").await?;Ok(result)
    }.await;
    match attempt {
        Ok(v) => Ok(v),
        Err(e) => {
            let (current, _) = sessions::active(a).await?;
            if let Some(result) = replay(a, &current, b, op, target, &key).await? {
                return Ok(result);
            }
            Err(if e.code == "ALREADY_EXISTS" {
                Failure {
                    status: 409,
                    code: "IDENTITY_IN_USE",
                }
            } else {
                e
            })
        }
    }
}
async fn reset(a: &Auth, b: &Value) -> Result<Value> {
    shape("PasswordResetRequest", b)?;
    let (t, c) = registration::transaction(a, &text(b, "transactionId")).await?;
    ensure(
        t["purpose"] == "PASSWORD_RESET" && t["status"] == "CONSUMED",
        401,
        "INVALID_CREDENTIALS",
    )?;
    let user = text(&t, "user_id");
    let us = security(a, &user).await?;
    let p=a.s.one("SELECT * FROM auth_identity_proof WHERE token_hash=? AND transaction_id=? AND kind='RESET' AND consumed_at IS NULL AND expires_at>?",vec![hash(&text(b,"resetProof")).into(),t["id"].clone(),now().into()]).await?;
    ensure(
        !p.is_null()
            && p["user_id"] == t["user_id"]
            && p["user_epoch"] == us["session_epoch"]
            && p["identity_version"] == us["identity_version"],
        401,
        "INVALID_CREDENTIALS",
    )?;
    let encoded = encoded_password(a, b).await?;
    let mut w=vec![sessions::client_guard(a,&c)?,version_guard(a,&user,&us)?,registration::boundary(a,&t,&user,number(&p,"user_epoch"))?,a.s.guard("EXISTS(SELECT 1 FROM auth_user_email WHERE id=? AND user_id=? AND verified_at IS NOT NULL)",vec![parsed(&p,"verified_identity")?["bindingId"].clone(),user.clone().into()])?];
    w.extend(consume(a, &p)?);
    w.push(a.s.statement("INSERT INTO auth_local_credential VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET password_hash=excluded.password_hash,changed_at=excluded.changed_at",vec![user.clone().into(),encoded.into(),now().into()])?);
    w.extend(revoke_password(a, &user, None)?);
    w.push(a.s.audit(
        "account.v2.password.reset",
        user.into(),
        &a.request_id,
        Value::Null,
        Value::Null,
        Value::Null,
        false,
    )?);
    a.s.batch(w, "VERSION_CONFLICT").await?;
    Ok(json!({"passwordChanged":true,"nextStep":"LOGIN_REQUIRED"}))
}
pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    let b = if method == Method::Post || method == Method::Patch {
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/json"),
            415,
            "INVALID_REQUEST",
        )?;
        serde_json::from_str(
            &crate::app::bounded(
                a,
                if path.ends_with("/profile") {
                    200000
                } else {
                    16384
                },
            )
            .await?,
        )?
    } else {
        json!({})
    };
    let result = if path == "/api/v2/auth/password-reset/complete" && method == Method::Post {
        reset(a, &b).await?
    } else {
        let (s, c) = sessions::active(a).await?;
        let user = text(&s, "user_id");
        match (path, method) {
            ("/api/v2/users/me", Method::Get) => {
                let permissions=a.s.all("SELECT permission FROM auth_platform_permission WHERE user_id=? AND status='ACTIVE' ORDER BY permission",vec![user.clone().into()]).await?;
                let capabilities: Vec<_> = permissions
                    .iter()
                    .filter(|p| {
                        crate::unified_contracts::validate_named(
                            "PlatformCapability",
                            &p["permission"],
                        )
                        .is_ok()
                    })
                    .map(|p| p["permission"].clone())
                    .collect();
                json!({"user":user_view(a,&user).await?,"loginMethods":methods(a,&user,&c).await?,"passwordEnabled":password_enabled(a,&user).await?,"session":sessions::view(&s),"platformCapabilities":capabilities})
            }
            ("/api/v2/users/me/login-methods", Method::Get) => {
                json!({"loginMethods":methods(a,&user,&c).await?,"version":security(a,&user).await?["account_version"]})
            }
            ("/api/v2/users/me/reauthentications", Method::Post) => {
                shape("ReauthenticationRequest", &b)?;
                let mut b = b.clone();
                b["purpose"] = "REAUTH".into();
                registration::begin(a, &b).await?
            }
            ("/api/v2/users/me/profile", Method::Patch) => {
                shape("ProfileUpdateRequest", &b)?;
                manage(a, &s, &c, &b, "profile", &user).await?
            }
            ("/api/v2/users/me/password/change", Method::Post) => {
                shape("PasswordChangeRequest", &b)?;
                manage(a, &s, &c, &b, "password", &user).await?
            }
            ("/api/v2/users/me/login-methods/bind", Method::Post) => {
                shape("BindMethodRequest", &b)?;
                manage(a, &s, &c, &b, "bind", &user).await?
            }
            (_, Method::Post) => {
                let parts: Vec<_> = path.trim_matches('/').split('/').collect();
                ensure(
                    parts.len() == 7
                        && parts[..5] == ["api", "v2", "users", "me", "login-methods"]
                        && ["replace", "unlink"].contains(&parts[6]),
                    404,
                    "NOT_FOUND",
                )?;
                shape(
                    if parts[6] == "replace" {
                        "BindMethodRequest"
                    } else {
                        "UnlinkMethodRequest"
                    },
                    &b,
                )?;
                manage(a, &s, &c, &b, parts[6], parts[5]).await?
            }
            _ => {
                return Err(Failure {
                    status: 404,
                    code: "NOT_FOUND",
                });
            }
        }
    };
    Ok(json_response(
        json!({"data":result,"requestId":a.request_id}),
        200,
    )?)
}
