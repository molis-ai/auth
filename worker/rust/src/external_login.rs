//! AUTH-05: provider adapters with an isolated, browser-bound mock authorization server.
use crate::{
    http::*,
    identity::Auth,
    login_sessions::{client_guard, registered_client},
    registration::{boundary, new_user, tx_guard},
    security::*,
};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use worker::{Method, Response, Url};
#[wasm_bindgen(module = "/src/runtime/federation.js")]
extern "C" {
    #[wasm_bindgen(catch,js_name=authSeal)]
    async fn seal(key: &str, value: &str) -> std::result::Result<String, JsValue>;
    #[wasm_bindgen(catch,js_name=authOpen)]
    async fn open(key: &str, value: &str) -> std::result::Result<String, JsValue>;
}
fn unavailable(_: JsValue) -> Failure {
    Failure {
        status: 503,
        code: "UPSTREAM_UNAVAILABLE",
    }
}
fn key(a: &Auth) -> Result<String> {
    let k = a
        .env
        .secret("PROVIDER_STATE_KEY")
        .map(|v| v.to_string())
        .or_else(|_| a.env.var("PROVIDER_STATE_KEY").map(|v| v.to_string()))
        .unwrap_or_default();
    ensure(token(&k), 503, "UPSTREAM_UNAVAILABLE")?;
    Ok(k)
}
async fn sealed(a: &Auth, v: &Value) -> Result<String> {
    seal(&key(a)?, &v.to_string()).await.map_err(unavailable)
}
async fn opened(a: &Auth, s: &str) -> Result<Value> {
    Ok(serde_json::from_str(
        &open(&key(a)?, s).await.map_err(unavailable)?,
    )?)
}
fn provider(p: &str) -> Result<&'static str> {
    match p {
        "google" => Ok("GOOGLE"),
        "github" => Ok("GITHUB"),
        _ => Err(Failure {
            status: 404,
            code: "NOT_FOUND",
        }),
    }
}
fn mock(c: &Value) -> Result<()> {
    ensure(
        c["provider_mode"] == "MOCK" && (c["kind"] == "LOCAL" || c["kind"] == "TEST"),
        503,
        "UPSTREAM_UNAVAILABLE",
    )
}
fn name(a: &Auth, state: &str) -> String {
    format!(
        "{}molis_provider_{}",
        if a.origin.starts_with("https:") {
            "__Host-"
        } else {
            ""
        },
        &hash(state)[..24]
    )
}
fn cookie_value(a: &Auth, state: &str) -> String {
    cookie(&a.header("Cookie"), &name(a, state))
}
fn redirect(url: &str) -> Result<Response> {
    let mut r = Response::empty()?.with_status(303);
    r.headers_mut().set("Location", url)?;
    r.headers_mut().set("Cache-Control", "no-store")?;
    Ok(r)
}
fn q(a: &Auth) -> Result<Value> {
    form(a.request.url()?.query().unwrap_or_default())
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn target(t: &Value, result: &str) -> Result<String> {
    let mut u = Url::parse(&text(t, "redirect_uri")).map_err(|_| Failure {
        status: 400,
        code: "INVALID_REQUEST",
    })?;
    ensure(
        !u.query_pairs()
            .any(|(k, _)| ["state", "transactionId", "result"].contains(&k.as_ref())),
        400,
        "INVALID_REQUEST",
    )?;
    u.query_pairs_mut()
        .append_pair("transactionId", &text(t, "id"))
        .append_pair("state", &text(t, "product_state"))
        .append_pair("result", result);
    Ok(u.to_string())
}
pub async fn start(a: &Auth, t: &Value, c: &Value, p: &str) -> Result<Value> {
    let method = provider(p)?;
    ensure(
        (t["purpose"] == "LOGIN" || crate::sensitive_transactions::protected(t))
            && t["method"] == method,
        400,
        "INVALID_REQUEST",
    )?;
    mock(c)?;
    target(t, "VERIFIED")?;
    a.rate_ip("v2-provider-start", 30).await?;
    let n = now();
    let state = secret();
    let nonce = secret();
    let verifier = secret();
    let ticket = secret();
    let context = json!({"state":state,"nonce":nonce,"verifier":verifier,"clientVersion":c["version"],"policyVersion":c["policy_version"],"environmentVersion":c["environment_version"]});
    let encrypted = sealed(a, &context).await?;
    a.s.batch(vec![client_guard(a,c)?,tx_guard(a,t,now(),"PENDING")?,a.s.guard("EXISTS(SELECT 1 FROM auth_product_transaction WHERE id=? AND provider_state_hash IS NULL)",vec![t["id"].clone()])?,a.s.statement("UPDATE auth_product_transaction SET provider_state_hash=?,provider_nonce_hash=?,provider_pkce_verifier_sealed=? WHERE id=?",vec![hash(&state).into(),hash(&nonce).into(),encrypted.into(),t["id"].clone()])?,a.s.statement("INSERT INTO auth_one_use VALUES (?,'V2_PROVIDER_START',?,?,?)",vec![hash(&ticket).into(),hash(&text(t,"id")).into(),json!({"transactionId":t["id"]}).to_string().into(),(n+60000).min(number(t,"expires_at")).into()])?],"VERSION_CONFLICT").await?;
    Ok(
        json!({"browserStartUrl":format!("{}/api/v2/auth/external/{p}/browser-start?ticket={ticket}",a.origin)}),
    )
}
async fn checked(a: &Auth, t: &Value) -> Result<(Value, Value)> {
    ensure(
        !t.is_null()
            && (t["purpose"] == "LOGIN" || crate::sensitive_transactions::protected(t))
            && (t["method"] == "GOOGLE" || t["method"] == "GITHUB")
            && t["status"] == "PENDING"
            && number(t, "expires_at") > now(),
        401,
        "INVALID_CREDENTIALS",
    )?;
    let c = registered_client(a, &text(t, "client_id")).await?;
    mock(&c)?;
    ensure(
        c["environment_id"] == t["environment_id"]
            && contains(&parsed(&c, "redirects")?, &t["redirect_uri"]),
        403,
        "POLICY_MISMATCH",
    )?;
    let ctx = opened(a, &text(t, "provider_pkce_verifier_sealed")).await?;
    ensure(
        ctx["clientVersion"] == c["version"]
            && ctx["policyVersion"] == c["policy_version"]
            && ctx["environmentVersion"] == c["environment_version"],
        403,
        "POLICY_MISMATCH",
    )?;
    Ok((c, ctx))
}
async fn flow(a: &Auth, p: &str, state: &str) -> Result<(Value, Value, Value, String)> {
    ensure(token(state), 400, "INVALID_REQUEST")?;
    let t =
        a.s.one(
            "SELECT * FROM auth_product_transaction WHERE provider_state_hash=? AND method=?",
            vec![hash(state).into(), provider(p)?.into()],
        )
        .await?;
    let (c, ctx) = checked(a, &t).await?;
    let browser = cookie_value(a, state);
    ensure(
        token(&browser) && t["browser_hash"] == hash(&browser) && ctx["state"] == state,
        401,
        "INVALID_CREDENTIALS",
    )?;
    Ok((t, c, ctx, browser))
}
async fn browser_start(a: &mut Auth, p: &str) -> Result<Response> {
    let b = q(a)?;
    fields(&b, &["ticket"], &[])?;
    let ticket = text(&b, "ticket");
    ensure(token(&ticket), 400, "INVALID_REQUEST")?;
    let receipt=a.s.one("SELECT * FROM auth_one_use WHERE token_hash=? AND purpose='V2_PROVIDER_START' AND expires_at>?",vec![hash(&ticket).into(),now().into()]).await?;
    ensure(!receipt.is_null(), 401, "INVALID_CREDENTIALS")?;
    let t =
        a.s.one(
            "SELECT * FROM auth_product_transaction WHERE id=?",
            vec![parsed(&receipt, "payload")?["transactionId"].clone()],
        )
        .await?;
    let (c, ctx) = checked(a, &t).await?;
    ensure(t["method"] == provider(p)?, 400, "INVALID_REQUEST")?;
    let state = text(&ctx, "state");
    let browser = secret();
    a.s.batch(vec![client_guard(a,&c)?,tx_guard(a,&t,now(),"PENDING")?,a.s.guard("EXISTS(SELECT 1 FROM auth_one_use WHERE token_hash=? AND purpose='V2_PROVIDER_START' AND expires_at>?)",vec![hash(&ticket).into(),now().into()])?,a.s.statement("DELETE FROM auth_one_use WHERE token_hash=?",vec![hash(&ticket).into()])?,a.s.statement("UPDATE auth_product_transaction SET browser_hash=? WHERE id=? AND browser_hash IS NULL",vec![hash(&browser).into(),t["id"].clone()])?],"VERSION_CONFLICT").await?;
    a.cookies
        .push(cookie_header(&a.origin, &name(a, &state), &browser, 600));
    redirect(&format!(
        "{}/api/v2/auth/mock/{p}/authorize?state={state}",
        a.origin
    ))
}
// These mock adapters intentionally use separate issuers per environment. They can
// never authenticate a real Google/GitHub identity already stored in the database.
fn normalize(p: &str, v: &Value, t: &Value, ctx: &Value) -> Result<Value> {
    ensure(
        v["aud"] == t["client_id"]
            && v["environmentId"] == t["environment_id"]
            && v["pkceChallenge"] == challenge(&text(ctx, "verifier"))
            && number(v, "expiresAt") > now(),
        401,
        "INVALID_CREDENTIALS",
    )?;
    let (issuer, subject) = if p == "google" {
        ensure(
            v["iss"] == "https://mock.google.invalid"
                && v["nonce"] == ctx["nonce"]
                && hash(&text(v, "nonce")) == t["provider_nonce_hash"],
            401,
            "INVALID_CREDENTIALS",
        )?;
        (
            "https://mock.google.invalid",
            string(&v["sub"], 255)?.to_owned(),
        )
    } else {
        ensure(v["provider"] == "GITHUB", 401, "INVALID_CREDENTIALS")?;
        (
            "https://mock.github.invalid",
            string(&v["user"]["id"], 255)?.to_owned(),
        )
    };
    ensure(!subject.is_empty(), 401, "INVALID_CREDENTIALS")?;
    Ok(json!({"issuer":format!("{issuer}/{}",text(t,"environment_id")),"subject":subject}))
}
async fn authorize(a: &mut Auth, p: &str, method: Method) -> Result<Response> {
    let b = if method == Method::Get {
        q(a)?
    } else {
        ensure(
            method == Method::Post && a.header("Origin") == a.origin,
            403,
            "FORBIDDEN",
        )?;
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/x-www-form-urlencoded"),
            415,
            "INVALID_REQUEST",
        )?;
        form(&crate::app::bounded(a, 4096).await?)?
    };
    fields(
        &b,
        if method == Method::Get {
            &["state"]
        } else {
            &["state", "csrf", "accountId", "outcome"]
        },
        &[],
    )?;
    let state = text(&b, "state");
    let (t, c, ctx, browser) = flow(a, p, &state).await?;
    if method == Method::Get {
        let accounts=a.s.all("SELECT id,label FROM auth_mock_provider_account WHERE environment_id=? AND provider=? ORDER BY id LIMIT 50",vec![c["environment_id"].clone(),provider(p)?.into()]).await?;
        let options = accounts
            .iter()
            .map(|x| {
                format!(
                    "<option value=\"{}\">{}</option>",
                    escape(&text(x, "id")),
                    escape(&text(x, "label"))
                )
            })
            .collect::<String>();
        let html = format!(
            "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>Molis 提供方模拟授权</title><h1>{} 模拟授权</h1><p>仅用于隔离测试。此页面不连接真实提供方。</p><form method=\"post\" action=\"/api/v2/auth/mock/{p}/authorize\"><input type=\"hidden\" name=\"state\" value=\"{}\"><input type=\"hidden\" name=\"csrf\" value=\"{}\"><label>测试账号<select name=\"accountId\">{options}</select></label><button name=\"outcome\" value=\"SUCCESS\">同意授权</button><button name=\"outcome\" value=\"CANCEL\">取消</button><button name=\"outcome\" value=\"FAIL\">模拟失败</button></form></html>",
            escape(provider(p)?),
            escape(&state),
            challenge(&format!("{browser}:{state}"))
        );
        let callback_origin = Url::parse(&text(&t, "redirect_uri"))
            .map_err(|_| Failure {
                status: 400,
                code: "INVALID_REQUEST",
            })?
            .origin()
            .ascii_serialization();
        let mut r = Response::from_html(html)?;
        // Chromium checks form-action on redirect destinations too. Permit only
        // this transaction's registered product origin for the return navigation.
        r.headers_mut().set("Content-Security-Policy", &format!("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' {callback_origin}"))?;
        // A no-referrer HTML form sends Origin: null in Chromium. Keep the
        // same-origin POST check and suppress referrers to other origins.
        r.headers_mut().set("Referrer-Policy", "same-origin")?;
        r.headers_mut().set("Cache-Control", "no-store")?;
        return Ok(r);
    }
    ensure(
        b["csrf"] == challenge(&format!("{browser}:{state}")),
        403,
        "FORBIDDEN",
    )?;
    ensure(
        ["SUCCESS", "CANCEL", "FAIL"].contains(&text(&b, "outcome").as_str()),
        400,
        "INVALID_REQUEST",
    )?;
    let mut url =
        Url::parse(&format!("{}/api/v2/auth/external/{p}/callback", a.origin)).map_err(|_| {
            Failure {
                status: 503,
                code: "UPSTREAM_UNAVAILABLE",
            }
        })?;
    url.query_pairs_mut().append_pair("state", &state);
    if b["outcome"] != "SUCCESS" {
        url.query_pairs_mut().append_pair(
            "error",
            if b["outcome"] == "CANCEL" {
                "access_denied"
            } else {
                "server_error"
            },
        );
        return redirect(url.as_str());
    }
    let account=a.s.one("SELECT * FROM auth_mock_provider_account WHERE id=? AND environment_id=? AND provider=?",vec![b["accountId"].clone(),c["environment_id"].clone(),provider(p)?.into()]).await?;
    ensure(!account.is_null(), 400, "INVALID_REQUEST")?;
    let expires = (now() + 60000).min(number(&t, "expires_at"));
    let mut claims = json!({"aud":t["client_id"],"environmentId":t["environment_id"],"pkceChallenge":challenge(&text(&ctx,"verifier")),"expiresAt":expires});
    if p == "google" {
        claims["iss"] = json!("https://mock.google.invalid");
        claims["sub"] = account["subject"].clone();
        claims["nonce"] = ctx["nonce"].clone();
    } else {
        claims["provider"] = json!("GITHUB");
        claims["user"] = json!({"id":account["subject"],"email":account["email"]});
    }
    let code = secret();
    let payload = sealed(a, &claims).await?;
    a.s.batch(
        vec![
            client_guard(a, &c)?,
            tx_guard(a, &t, now(), "PENDING")?,
            a.s.statement(
                "INSERT INTO auth_one_use VALUES (?,'V2_PROVIDER_CODE',?,?,?)",
                vec![
                    hash(&code).into(),
                    hash(&format!("{p}:{state}:{browser}")).into(),
                    json!(payload).to_string().into(),
                    expires.into(),
                ],
            )?,
        ],
        "VERSION_CONFLICT",
    )
    .await?;
    url.query_pairs_mut().append_pair("code", &code);
    redirect(url.as_str())
}
async fn callback_once(a: &mut Auth, p: &str) -> Result<Response> {
    let b = q(a)?;
    ensure(
        crate::unified_contracts::validate_named("ProviderCallback", &b).is_ok(),
        400,
        "INVALID_REQUEST",
    )?;
    let state = text(&b, "state");
    let (t, c, ctx, browser) = flow(a, p, &state).await?;
    let mut writes = vec![client_guard(a, &c)?, tx_guard(a, &t, now(), "PENDING")?];
    let result = if b.get("error").is_some() {
        writes.push(a.s.statement("UPDATE auth_product_transaction SET status='CANCELLED',completed_at=?,provider_pkce_verifier_sealed=NULL WHERE id=?",vec![now().into(),t["id"].clone()])?);
        if b["error"] == "access_denied" {
            "CANCELLED"
        } else {
            "FAILED"
        }
    } else {
        let digest = hash(&text(&b, "code"));
        let binding = hash(&format!("{p}:{state}:{browser}"));
        let code=a.s.one("SELECT * FROM auth_one_use WHERE token_hash=? AND purpose='V2_PROVIDER_CODE' AND binding_hash=? AND expires_at>?",vec![digest.clone().into(),binding.clone().into(),now().into()]).await?;
        ensure(!code.is_null(), 401, "INVALID_CREDENTIALS")?;
        let claims = opened(
            a,
            parsed(&code, "payload")?.as_str().ok_or(Failure {
                status: 400,
                code: "INVALID_REQUEST",
            })?,
        )
        .await?;
        let identity = normalize(p, &claims, &t, &ctx)?;
        if crate::sensitive_transactions::protected(&t) {
            let mut verified_identity = identity.clone();
            verified_identity["type"] = provider(p)?.into();
            writes.extend(
                crate::sensitive_transactions::verified(a, &t, &verified_identity, now()).await?,
            );
        } else {
            let existing=a.s.one("SELECT x.user_id,u.status,us.session_epoch FROM auth_external_identity x JOIN auth_user u ON u.id=x.user_id LEFT JOIN auth_user_security us ON us.user_id=x.user_id WHERE x.issuer=? AND x.subject=?",vec![identity["issuer"].clone(),identity["subject"].clone()]).await?;
            let n = now();
            let user;
            let epoch;
            if existing.is_null() {
                user = uuid();
                epoch = 0;
                writes.extend(new_user(a, &user, n)?);
                writes.push(a.s.statement(
                    "INSERT INTO auth_external_identity VALUES (?,?,?,?,?,?)",
                    vec![
                        uuid().into(),
                        user.clone().into(),
                        provider(p)?.into(),
                        identity["issuer"].clone(),
                        identity["subject"].clone(),
                        n.into(),
                    ],
                )?);
            } else {
                ensure(existing["status"] == "ACTIVE", 401, "INVALID_CREDENTIALS")?;
                user = text(&existing, "user_id");
                epoch = number(&existing, "session_epoch");
                writes.push(a.s.guard("EXISTS(SELECT 1 FROM auth_external_identity WHERE issuer=? AND subject=? AND user_id=?)",vec![identity["issuer"].clone(),identity["subject"].clone(),user.clone().into()])?);
            }
            writes.push(a.s.statement(
                "INSERT OR IGNORE INTO auth_user_security(user_id,updated_at) VALUES (?,?)",
                vec![user.clone().into(), n.into()],
            )?);
            writes.push(boundary(a, &t, &user, epoch)?);
            writes.push(a.s.statement("UPDATE auth_product_transaction SET status='VERIFIED',user_id=?,user_epoch=?,provider_pkce_verifier_sealed=NULL WHERE id=?",vec![user.clone().into(),epoch.into(),t["id"].clone()])?);
            writes.push(a.s.audit(
                "account.v2.external.verify",
                user.into(),
                &a.request_id,
                Value::Null,
                Value::Null,
                Value::Null,
                false,
            )?);
        }
        writes.push(a.s.guard("EXISTS(SELECT 1 FROM auth_one_use WHERE token_hash=? AND purpose='V2_PROVIDER_CODE' AND binding_hash=? AND expires_at>?)",vec![digest.clone().into(),binding.into(),now().into()])?);
        writes.push(a.s.statement(
            "DELETE FROM auth_one_use WHERE token_hash=?",
            vec![digest.into()],
        )?);
        "VERIFIED"
    };
    writes.insert(0, tx_guard(a, &t, now(), "PENDING")?);
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    a.cookies
        .push(cookie_header(&a.origin, &name(a, &state), "", 0));
    redirect(&target(&t, result)?)
}
async fn callback(a: &mut Auth, p: &str) -> Result<Response> {
    // A concurrent first login may have created the stable identity. The failed
    // batch rolled back its code consumption; retry once against the new owner.
    match callback_once(a, p).await {
        Err(e) if e.code == "ALREADY_EXISTS" => callback_once(a, p).await,
        other => other,
    }
}
pub async fn browser(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    let parts: Vec<_> = path.trim_matches('/').split('/').collect();
    ensure(parts.len() == 6, 404, "NOT_FOUND")?;
    provider(parts[4])?;
    match (parts[3], parts[5], method) {
        ("external", "browser-start", Method::Get) => browser_start(a, parts[4]).await,
        ("mock", "authorize", m) => authorize(a, parts[4], m).await,
        ("external", "callback", Method::Get) => callback(a, parts[4]).await,
        _ => Err(Failure {
            status: 405,
            code: "INVALID_REQUEST",
        }),
    }
}
