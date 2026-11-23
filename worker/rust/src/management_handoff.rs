//! One-use, browser-bound handoff. Product bearer credentials never cross the browser.
use crate::{
    http::*,
    identity::Auth,
    login_sessions as sessions,
    security::{challenge, hash, secret, uuid},
    web_session,
};
use serde_json::{Value, json};
use worker::{Method, Response};
const TTL: i64 = 60_000;
fn redirect(location: &str) -> Result<Response> {
    let mut r = Response::empty()?.with_status(303);
    r.headers_mut().set("Location", location)?;
    r.headers_mut().set("Cache-Control", "no-store")?;
    r.headers_mut().set("Referrer-Policy", "no-referrer")?;
    Ok(r)
}
fn cookie(a: &Auth, name: &str) -> Result<String> {
    let prefix = format!("{name}=");
    let values: Vec<_> = a
        .header("Cookie")
        .split(';')
        .filter_map(|s| s.trim().strip_prefix(&prefix).map(str::to_owned))
        .collect();
    ensure(values.len() <= 1, 403, "FORBIDDEN")?;
    Ok(values.first().cloned().unwrap_or_default())
}
fn set_cookie(a: &Auth, r: &mut Response, name: &str, value: &str, age: i64) -> Result<()> {
    r.headers_mut().append(
        "Set-Cookie",
        &format!(
            "{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={age}{}",
            if a.origin.starts_with("https:") {
                "; Secure"
            } else {
                ""
            }
        ),
    )?;
    Ok(())
}
async fn pending(a: &Auth, id: &str) -> Result<Value> {
    let t =
        a.s.one(
            "SELECT * FROM auth_management_handoff WHERE id=?",
            vec![id.into()],
        )
        .await?;
    ensure(
        !t.is_null() && t["consumed_at"].is_null() && number(&t, "expires_at") > now(),
        401,
        "INVALID_GRANT",
    )?;
    Ok(t)
}
fn view(a: &Auth, t: &Value, suffix: &str) -> Value {
    json!({"handoffId":t["id"],"redirectUrl":format!("{}/account/handoff/{suffix}",a.origin),"expiresAt":iso(&t["expires_at"])})
}
pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    if path.starts_with("/api/v2/") {
        ensure(
            method == Method::Post && a.request.url()?.query().is_none(),
            400,
            "INVALID_REQUEST",
        )?;
        let b: Value = serde_json::from_str(&crate::app::bounded(a, 8192).await?)?;
        let (s, c) = sessions::active(a).await?;
        a.rate("management-handoff", &text(&s, "id"), 20, 60_000)
            .await?;
        let result = if path == "/api/v2/auth/management-handoffs" {
            shape("ManagementHandoffRequest", &b)?;
            ensure(
                contains(&parsed(&c, "redirects")?, &b["redirectUri"]),
                403,
                "FORBIDDEN",
            )?;
            let t = json!({"id":uuid(),"expires_at":now()+TTL});
            a.s.batch(vec![sessions::active_guard(a,&s)?, sessions::client_guard(a,&c)?, a.s.statement("INSERT INTO auth_management_handoff(id,source_session,source_revision,source_client,redirect_uri,initiator_challenge,expires_at) VALUES (?,?,?,?,?,?,?)",vec![t["id"].clone(),s["id"].clone(),s["session_revision"].clone(),s["client_id"].clone(),b["redirectUri"].clone(),b["initiatorChallenge"].clone(),t["expires_at"].clone()])?],"VERSION_CONFLICT").await?;
            view(a, &t, &format!("start?id={}", text(&t, "id")))
        } else {
            ensure(
                path == "/api/v2/auth/management-handoffs/approve",
                404,
                "NOT_FOUND",
            )?;
            shape("ManagementHandoffApproval", &b)?;
            let t = pending(a, &text(&b, "handoffId")).await?;
            ensure(
                t["source_session"] == s["id"]
                    && t["source_revision"] == s["session_revision"]
                    && t["initiator_challenge"] == challenge(&text(&b, "initiatorProof"))
                    && !t["browser_hash"].is_null()
                    && t["code_hash"].is_null(),
                403,
                "FORBIDDEN",
            )?;
            let code = secret();
            a.s.batch(vec![sessions::active_guard(a,&s)?, sessions::client_guard(a,&c)?, a.s.guard("EXISTS(SELECT 1 FROM auth_management_handoff WHERE id=? AND code_hash IS NULL AND browser_hash=? AND consumed_at IS NULL AND expires_at>?)", vec![t["id"].clone(),t["browser_hash"].clone(),now().into()])?, a.s.statement("UPDATE auth_management_handoff SET code_hash=? WHERE id=?",vec![hash(&code).into(),t["id"].clone()])?],"VERSION_CONFLICT").await?;
            view(a, &t, &format!("finish?id={}&code={code}", text(&t, "id")))
        };
        return Ok(json_response(
            json!({"data":result,"requestId":a.request_id}),
            200,
        )?);
    }
    // Navigation errors stay in the account UI, never a raw API JSON document.
    let started = now();
    match browser(a, path, method).await {
        Ok(response) => Ok(response),
        Err(error) => {
            a.s.log_failure("handoff.browser", &error, started);
            let (status, message) = if error.status >= 500 {
                (503, "服务暂时不可用，请稍后重试。")
            } else {
                (400, "本次跳转已失效，请返回原页面重新点击管理 Molis 账号。")
            };
            let mut response = Response::from_html(format!(
                "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Molis 账号</title><main><h1>暂时无法打开账号管理</h1><p>{message}</p><a href=\"/\">前往账号登录</a></main></html>"
            ))?
            .with_status(status);
            response.headers_mut().set("Cache-Control", "no-store")?;
            Ok(response)
        }
    }
}
async fn browser(a: &Auth, path: &str, method: Method) -> Result<Response> {
    ensure(
        method == Method::Get && a.header("Authorization").is_empty(),
        403,
        "FORBIDDEN",
    )?;
    ensure(
        a.request.url()?.origin().ascii_serialization() == a.origin,
        403,
        "FORBIDDEN",
    )?;
    let q = form(a.request.url()?.query().unwrap_or_default())?;
    let t = pending(a, &text(&q, "id")).await?;
    let source = sessions::session(a, &text(&t, "source_session")).await?;
    ensure(
        source["session_revision"] == t["source_revision"],
        401,
        "SESSION_EXPIRED",
    )?;
    let client = sessions::registered_client(a, &text(&t, "source_client")).await?;
    ensure(
        contains(&parsed(&client, "redirects")?, &t["redirect_uri"]),
        403,
        "FORBIDDEN",
    )?;
    if path == "/account/handoff/start" {
        ensure(
            q.as_object().is_some_and(|v| v.len() == 1) && t["browser_hash"].is_null(),
            403,
            "FORBIDDEN",
        )?;
        let proof = secret();
        a.s.batch(vec![sessions::session_guard(a,&source,now())?,sessions::client_guard(a,&client)?,a.s.guard("EXISTS(SELECT 1 FROM auth_management_handoff WHERE id=? AND browser_hash IS NULL AND consumed_at IS NULL AND expires_at>?)",vec![t["id"].clone(),now().into()])?,a.s.statement("UPDATE auth_management_handoff SET browser_hash=? WHERE id=?",vec![web_session::browser_cookie_hash(a, &proof).into(),t["id"].clone()])?],"VERSION_CONFLICT").await?;
        let mut url = worker::Request::new(&text(&t, "redirect_uri"), Method::Get)?.url()?;
        url.query_pairs_mut()
            .append_pair("handoff", &text(&t, "id"));
        let mut r = redirect(url.as_str())?;
        set_cookie(a, &mut r, "molis-auth-handoff", &proof, 60)?;
        return Ok(r);
    }
    ensure(
        path == "/account/handoff/finish" && q.as_object().is_some_and(|v| v.len() == 2),
        400,
        "INVALID_REQUEST",
    )?;
    let proof = cookie(a, "molis-auth-handoff")?;
    ensure(
        token(&proof)
            && t["browser_hash"] == web_session::browser_cookie_hash(a, &proof)
            && token(&text(&q, "code"))
            && t["code_hash"] == hash(&text(&q, "code")),
        403,
        "FORBIDDEN",
    )?;
    let target =
        sessions::registered_client(a, &web_session::setting(a, "AUTH_WEB_CLIENT_ID")?).await?;
    ensure(
        contains(&parsed(&target, "allowed_origins")?, &json!(a.origin)),
        403,
        "POLICY_MISMATCH",
    )?;
    let n = now();
    // Preserve original authentication age and absolute expiry; a handoff is not reauthentication.
    let s = json!({"id":uuid(),"user_id":source["user_id"],"client_id":target["client_id"],"application_id":target["application_id"],"authenticated_at":source["authenticated_at"],"last_active_at":n,"absolute_expires_at":source["absolute_expires_at"],"user_epoch":source["user_epoch"],"session_revision":0});
    let (tokens, token_writes) = sessions::tokens(a, &s, n, 0)?;
    let raw = secret();
    let id = web_session::browser_cookie_hash(a, &raw);
    let key = web_session::setting(a, "AUTH_WEB_SESSION_KEY")?;
    let payload = web_session::seal(
        &key,
        &json!({"id":id,"data":{"transactions":{},"tokens":tokens}}).to_string(),
    )
    .await
    .map_err(|_| Failure {
        status: 503,
        code: "AUTH_UNAVAILABLE",
    })?;
    let mut writes=vec![sessions::session_guard(a,&source,n)?,sessions::client_guard(a,&client)?,sessions::client_guard(a,&target)?,a.s.guard("EXISTS(SELECT 1 FROM auth_management_handoff WHERE id=? AND consumed_at IS NULL AND expires_at>? AND browser_hash=? AND code_hash=?)",vec![t["id"].clone(),n.into(),web_session::browser_cookie_hash(a, &proof).into(),hash(&text(&q,"code")).into()])?,a.s.statement("UPDATE auth_management_handoff SET consumed_at=? WHERE id=?",vec![n.into(),t["id"].clone()])?,a.s.statement("INSERT INTO auth_login_session(id,user_id,client_id,authenticated_at,last_active_at,absolute_expires_at,user_epoch,created_seq,identity_verified_at) VALUES (?,?,?,?,?,?,?,?,?)",vec![s["id"].clone(),s["user_id"].clone(),s["client_id"].clone(),s["authenticated_at"].clone(),n.into(),s["absolute_expires_at"].clone(),s["user_epoch"].clone(),source["created_seq"].clone(),source["identity_verified_at"].clone()])?,a.s.statement("INSERT INTO auth_web_session(id_hash,payload,status,expires_at) VALUES (?,?,'READY',?)",vec![id.into(),payload.into(),s["absolute_expires_at"].clone()])?];
    writes.extend(token_writes);
    let old = cookie(a, "molis-auth-web")?;
    if token(&old) {
        writes.push(a.s.statement(
            "DELETE FROM auth_web_session WHERE id_hash=?",
            vec![web_session::browser_cookie_hash(a, &old).into()],
        )?);
    }
    writes.push(a.s.audit(
        "account.v2.management-handoff",
        s["user_id"].clone(),
        &a.request_id,
        Value::Null,
        Value::Null,
        json!({"sourceSessionId":source["id"],"loginSessionId":s["id"]}),
        false,
    )?);
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    let mut r = redirect(&format!("{}/", a.origin))?;
    set_cookie(
        a,
        &mut r,
        "molis-auth-web",
        &raw,
        (number(&s, "absolute_expires_at") - n) / 1000,
    )?;
    set_cookie(a, &mut r, "molis-auth-handoff", "", 0)?;
    Ok(r)
}
