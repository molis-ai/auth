//! Mock OAuth authorization page for isolated account fixtures.
use super::{cookie_value, flow, provider, q, redirect, sealed};
use crate::{
    auth::login_sessions::client_guard,
    auth::registration::tx_guard,
    core::http::*,
    core::identity::Auth,
    core::security::{challenge, hash, secret},
};
use serde_json::{Value, json};
use worker::{Method, Response, Url};

pub(super) fn available(c: &Value) -> Result<()> {
    ensure(
        c["provider_mode"] == "MOCK" && (c["kind"] == "LOCAL" || c["kind"] == "TEST"),
        503,
        "UPSTREAM_UNAVAILABLE",
    )
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
// These mock adapters intentionally use separate issuers per environment. They can
// never authenticate a real Google/GitHub identity already stored in the database.
pub(super) fn normalize(p: &str, v: &Value, t: &Value, ctx: &Value) -> Result<Value> {
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
pub(super) async fn authorize(a: &mut Auth, p: &str, method: Method) -> Result<Response> {
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
    ensure(token(&state), 400, "INVALID_REQUEST")?;
    let browser = cookie_value(a, &state);
    let (t, c, ctx) = flow(a, p, &state, &browser).await?;
    available(&c)?;
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
