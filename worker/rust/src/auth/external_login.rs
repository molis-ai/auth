//! Browser-bound product authorization for isolated mock providers and live Google/GitHub.
use crate::{
    auth::github_login::Github,
    auth::google_login::Google,
    auth::login_sessions::{client_guard, registered_client},
    auth::registration::{boundary, new_user, tx_guard},
    core::http::*,
    core::identity::Auth,
    core::security::*,
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
pub(crate) fn configured(a: &Auth) -> bool {
    key(a).is_ok()
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
#[cfg(feature = "mock-provider")]
#[path = "external_login_mock.rs"]
mod mock_provider;
#[cfg(feature = "mock-provider")]
use mock_provider::available as mock;
#[cfg(not(feature = "mock-provider"))]
fn mock(_: &Value) -> Result<()> {
    Err(Failure {
        status: 503,
        code: "UPSTREAM_UNAVAILABLE",
    })
}
fn check_provider(a: &Auth, c: &Value, p: &str) -> Result<()> {
    if c["provider_mode"] == "LIVE" && p == "github" {
        Github::configured(a)?;
        return Ok(());
    }
    if c["provider_mode"] == "LIVE" && p == "google" {
        Google::configured(a)?;
        return Ok(());
    }
    mock(c)
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
    r.headers_mut().set("Referrer-Policy", "no-referrer")?;
    Ok(r)
}
fn q(a: &Auth) -> Result<Value> {
    form(a.request.url()?.query().unwrap_or_default())
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
        (t["purpose"] == "LOGIN" || crate::auth::sensitive_transactions::protected(t))
            && t["method"] == method,
        400,
        "INVALID_REQUEST",
    )?;
    check_provider(a, c, p)?;
    target(t, "VERIFIED")?;
    a.rate_ip("federation:start", 30).await?;
    let n = now();
    let state = secret();
    let nonce = secret();
    let verifier = secret();
    let ticket = secret();
    let context = json!({"state":state,"nonce":nonce,"verifier":verifier,"clientVersion":c["version"],"policyVersion":c["policy_version"],"environmentVersion":c["environment_version"]});
    let encrypted = sealed(a, &context).await?;
    a.s.batch(vec![client_guard(a,c)?,tx_guard(a,t,now(),"PENDING")?,a.s.guard("EXISTS(SELECT 1 FROM auth_product_transaction WHERE id=? AND provider_state_hash IS NULL)",vec![t["id"].clone()])?,a.s.statement("UPDATE auth_product_transaction SET provider_state_hash=?,provider_nonce_hash=?,provider_pkce_verifier_sealed=? WHERE id=?",vec![hash(&state).into(),hash(&nonce).into(),encrypted.into(),t["id"].clone()])?,a.s.statement("INSERT INTO auth_one_use VALUES (?,'PROVIDER_START',?,?,?)",vec![hash(&ticket).into(),hash(&text(t,"id")).into(),json!({"transactionId":t["id"]}).to_string().into(),(n+60000).min(number(t,"expires_at")).into()])?],"VERSION_CONFLICT").await?;
    Ok(
        json!({"browserStartUrl":format!("{}/api/v1/auth/external/{p}/browser-start?ticket={ticket}",a.origin)}),
    )
}
async fn checked(a: &Auth, t: &Value, p: &str) -> Result<(Value, Value)> {
    ensure(
        !t.is_null()
            && (t["purpose"] == "LOGIN" || crate::auth::sensitive_transactions::protected(t))
            && (t["method"] == "GOOGLE" || t["method"] == "GITHUB")
            && t["status"] == "PENDING"
            && number(t, "expires_at") > now(),
        401,
        "INVALID_CREDENTIALS",
    )?;
    let c = registered_client(a, &text(t, "client_id")).await?;
    check_provider(a, &c, p)?;
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
async fn flow(a: &Auth, p: &str, state: &str, browser: &str) -> Result<(Value, Value, Value)> {
    let t =
        a.s.one(
            "SELECT * FROM auth_product_transaction WHERE provider_state_hash=? AND method=?",
            vec![hash(state).into(), provider(p)?.into()],
        )
        .await?;
    let (c, ctx) = checked(a, &t, p).await?;
    ensure(
        token(browser) && t["browser_hash"] == hash(browser) && ctx["state"] == state,
        401,
        "INVALID_CREDENTIALS",
    )?;
    Ok((t, c, ctx))
}
async fn browser_start(a: &mut Auth, p: &str) -> Result<Response> {
    let b = q(a)?;
    fields(&b, &["ticket"], &[])?;
    let ticket = text(&b, "ticket");
    ensure(token(&ticket), 400, "INVALID_REQUEST")?;
    let receipt=a.s.one("SELECT * FROM auth_one_use WHERE token_hash=? AND purpose='PROVIDER_START' AND expires_at>?",vec![hash(&ticket).into(),now().into()]).await?;
    ensure(!receipt.is_null(), 401, "INVALID_CREDENTIALS")?;
    let t =
        a.s.one(
            "SELECT * FROM auth_product_transaction WHERE id=?",
            vec![parsed(&receipt, "payload")?["transactionId"].clone()],
        )
        .await?;
    let (c, ctx) = checked(a, &t, p).await?;
    ensure(t["method"] == provider(p)?, 400, "INVALID_REQUEST")?;
    let state = text(&ctx, "state");
    let browser = secret();
    a.s.batch(vec![client_guard(a,&c)?,tx_guard(a,&t,now(),"PENDING")?,a.s.guard("EXISTS(SELECT 1 FROM auth_one_use WHERE token_hash=? AND purpose='PROVIDER_START' AND expires_at>?)",vec![hash(&ticket).into(),now().into()])?,a.s.statement("DELETE FROM auth_one_use WHERE token_hash=?",vec![hash(&ticket).into()])?,a.s.statement("UPDATE auth_product_transaction SET browser_hash=? WHERE id=? AND browser_hash IS NULL",vec![hash(&browser).into(),t["id"].clone()])?],"VERSION_CONFLICT").await?;
    a.cookies
        .push(cookie_header(&a.origin, &name(a, &state), &browser, 600));
    #[cfg(feature = "mock-provider")]
    if c["provider_mode"] == "MOCK" {
        return redirect(&format!(
            "{}/api/v1/auth/mock/{p}/authorize?state={state}",
            a.origin
        ));
    }
    let url = if p == "google" {
        Google::configured(a)?.authorize_url(
            &state,
            &text(&ctx, "verifier"),
            &text(&ctx, "nonce"),
        )?
    } else {
        Github::configured(a)?.authorize_url(&state, &text(&ctx, "verifier"))?
    };
    redirect(url.as_str())
}
async fn commit_identity(
    a: &Auth,
    t: &Value,
    c: &Value,
    identity: &Value,
    #[cfg(feature = "mock-provider")] mock_code: Option<&(String, String)>,
) -> Result<()> {
    let mut writes = vec![client_guard(a, c)?, tx_guard(a, t, now(), "PENDING")?];
    if crate::auth::sensitive_transactions::protected(t) {
        let mut verified_identity = identity.clone();
        verified_identity["type"] = t["method"].clone();
        writes.extend(
            crate::auth::sensitive_transactions::verified(a, t, &verified_identity, now()).await?,
        );
    } else {
        let existing=a.s.one("SELECT x.user_id,u.status,u.session_epoch FROM auth_external_identity x JOIN auth_user u ON u.id=x.user_id WHERE x.issuer=? AND x.subject=?",vec![identity["issuer"].clone(),identity["subject"].clone()]).await?;
        crate::auth::test_admission::Admission::load(a)?
            .external(a, identity, &existing["user_id"])
            .await?;
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
                    t["method"].clone(),
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

        writes.extend(crate::auth::external_profile::save(a, identity, &user)?);
        if identity.get("profile").is_some() {
            writes.push(a.s.statement(
                "UPDATE auth_user SET account_version=account_version+1 WHERE id=?",
                vec![user.clone().into()],
            )?);
        }
        writes.push(boundary(a, t, &user, epoch)?);
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
    #[cfg(feature = "mock-provider")]
    if let Some((digest, binding)) = mock_code {
        writes.push(a.s.guard("EXISTS(SELECT 1 FROM auth_one_use WHERE token_hash=? AND purpose='MOCK_PROVIDER_CODE' AND binding_hash=? AND expires_at>?)",vec![digest.as_str().into(),binding.as_str().into(),now().into()])?);
        writes.push(a.s.statement(
            "DELETE FROM auth_one_use WHERE token_hash=?",
            vec![digest.as_str().into()],
        )?);
    }
    a.s.batch(writes, "VERSION_CONFLICT").await?;
    Ok(())
}

async fn callback(a: &mut Auth, p: &str) -> Result<Response> {
    a.rate_ip("federation:callback", 120).await?;
    let mut b = q(a)?;
    let state = text(&b, "state");
    ensure(token(&state), 400, "INVALID_REQUEST")?;
    let browser = cookie_value(a, &state);
    let (t, c, ctx) = flow(a, p, &state, &browser).await?;
    let live = c["provider_mode"] == "LIVE";
    if live {
        if p == "github" && b.get("iss").is_some() {
            ensure(
                b["iss"] == Github::AUTHORIZATION_ISSUER,
                400,
                "INVALID_REQUEST",
            )?;
        } else if p == "google" && b.get("iss").is_some() {
            ensure(
                b["iss"] == crate::auth::google_login::ISSUER,
                400,
                "INVALID_REQUEST",
            )?;
        }
        // Validate an issuer when supplied. The provider-specific callback path,
        // transaction method, state, browser cookie and PKCE also bind the provider.
        if let Some(fields) = b.as_object_mut() {
            fields.remove("iss");
            if p == "google" {
                // Google returns these informational fields; identity comes only from the signed ID token.
                for name in ["scope", "authuser", "prompt", "hd"] {
                    fields.remove(name);
                }
            }
            if fields.contains_key("error") {
                fields.remove("error_description");
                fields.remove("error_uri");
            }
        }
    }
    ensure(
        crate::core::contracts::unified_contracts::validate_named("ProviderCallback", &b).is_ok(),
        400,
        "INVALID_REQUEST",
    )?;
    let result = if b.get("error").is_some() {
        a.s.batch(
            vec![
                client_guard(a, &c)?,
                tx_guard(a, &t, now(), "PENDING")?,
                a.s.statement("UPDATE auth_product_transaction SET status='CANCELLED',completed_at=?,provider_pkce_verifier_sealed=NULL WHERE id=?",vec![now().into(),t["id"].clone()])?,
            ],
            "VERSION_CONFLICT",
        ).await?;
        if b["error"] == "access_denied" {
            "CANCELLED"
        } else {
            "FAILED"
        }
    } else {
        let raw = text(&b, "code");
        #[cfg(feature = "mock-provider")]
        let mut mock_code = None;
        let identity = match p {
            #[cfg(feature = "mock-provider")]
            _ if !live => {
                let digest = hash(&raw);
                let binding = hash(&format!("{p}:{state}:{browser}"));
                let code = a.s.one("SELECT * FROM auth_one_use WHERE token_hash=? AND purpose='MOCK_PROVIDER_CODE' AND binding_hash=? AND expires_at>?",vec![digest.as_str().into(),binding.as_str().into(),now().into()]).await?;
                ensure(!code.is_null(), 401, "INVALID_CREDENTIALS")?;
                let claims = opened(
                    a,
                    parsed(&code, "payload")?.as_str().ok_or(Failure {
                        status: 400,
                        code: "INVALID_REQUEST",
                    })?,
                )
                .await?;
                mock_code = Some((digest, binding));
                mock_provider::normalize(p, &claims, &t, &ctx)?
            }
            "google" => {
                Google::configured(a)?
                    .exchange(&raw, &text(&ctx, "verifier"), &text(&ctx, "nonce"))
                    .await?
            }
            _ => {
                Github::configured(a)?
                    .exchange(&raw, &text(&ctx, "verifier"))
                    .await?
            }
        };
        // A concurrent first login can win the identity insert. Retry only the
        // guarded local commit, keeping the provider's one-time exchange out of the retry.
        let commit = || {
            commit_identity(
                a,
                &t,
                &c,
                &identity,
                #[cfg(feature = "mock-provider")]
                mock_code.as_ref(),
            )
        };
        match commit().await {
            Err(e) if e.code == "ALREADY_EXISTS" => {
                commit().await?;
            }
            result => result?,
        }
        "VERIFIED"
    };
    a.cookies
        .push(cookie_header(&a.origin, &name(a, &state), "", 0));
    redirect(&target(&t, result)?)
}

pub async fn browser(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    let parts: Vec<_> = path.trim_matches('/').split('/').collect();
    ensure(parts.len() == 6, 404, "NOT_FOUND")?;
    provider(parts[4])?;
    match (parts[3], parts[5], method) {
        ("external", "browser-start", Method::Get) => browser_start(a, parts[4]).await,
        #[cfg(feature = "mock-provider")]
        ("mock", "authorize", m) => mock_provider::authorize(a, parts[4], m).await,
        ("external", "callback", Method::Get) => callback(a, parts[4]).await,
        _ => Err(Failure {
            status: 405,
            code: "INVALID_REQUEST",
        }),
    }
}

#[cfg(all(test, not(feature = "mock-provider")))]
mod tests {
    use super::*;

    #[test]
    fn mock_provider_is_unavailable_in_local_and_test_environments() {
        for kind in ["LOCAL", "TEST"] {
            let error = mock(&json!({"kind": kind, "provider_mode": "MOCK"})).unwrap_err();
            assert_eq!(error.status, 503);
            assert_eq!(error.code, "UPSTREAM_UNAVAILABLE");
        }
    }
}
