//! Configuration readiness for one registered client; never a provider health probe or authorization grant.
use crate::{auth::login_sessions::client, http::*, identity::Auth};
use serde_json::{Value, json};
use worker::{Method, Response};

pub(crate) fn available(a: &Auth, c: &Value) -> Vec<&'static str> {
    let mock = matches!(c["kind"].as_str(), Some("LOCAL" | "TEST"));
    let delivery = crate::delivery::supports_mock_delivery(&c["kind"], &c["delivery_mode"]);
    let provider = cfg!(feature = "mock-provider") && mock && c["provider_mode"] == "MOCK";
    let state_key = crate::auth::external_login::configured(a);
    let mut methods = vec!["ACCOUNT_PASSWORD"];
    if delivery || (c["delivery_mode"] == "LIVE" && crate::delivery::mail_delivery::configured(a)) {
        methods.push("EMAIL_CODE");
    }
    if delivery || (c["delivery_mode"] == "LIVE" && crate::delivery::sms_auth::configured(a)) {
        methods.push("PHONE_OTP");
    }
    if state_key
        && (provider
            || (c["provider_mode"] == "LIVE"
                && crate::auth::google_login::Google::configured(a).is_ok()))
    {
        methods.push("GOOGLE");
    }
    if state_key
        && (provider
            || (c["provider_mode"] == "LIVE"
                && crate::auth::github_login::Github::configured(a).is_ok()))
    {
        methods.push("GITHUB");
    }
    methods
}
pub async fn route(a: &Auth, method: Method) -> Result<Response> {
    ensure(method == Method::Get, 405, "METHOD_NOT_ALLOWED")?;
    let query = form(a.request.url()?.query().unwrap_or_default())?;
    shape("LoginCapabilitiesQuery", &query)?;
    let c = client(a, &text(&query, "clientId")).await?;
    response(a, &c)
}

pub(crate) fn response(a: &Auth, c: &Value) -> Result<Response> {
    ensure(
        a.env.durable_object("PASSWORD_KDF").is_ok(),
        503,
        "UPSTREAM_UNAVAILABLE",
    )?;
    Ok(json_response(
        json!({"data":{"methods":available(a, c)},"requestId":a.request_id}),
        200,
    )?)
}
