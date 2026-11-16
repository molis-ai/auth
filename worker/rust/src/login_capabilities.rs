//! Configuration readiness for one registered client; never a provider health probe or authorization grant.
use crate::{http::*, identity::Auth, login_sessions::client, sensitive_transactions::shape};
use serde_json::{json, Value};
use worker::{Method, Response};

pub(crate) fn available(a: &Auth, c: &Value) -> Vec<&'static str> {
    let mock = matches!(c["kind"].as_str(), Some("LOCAL" | "TEST"));
    let delivery = mock && c["delivery_mode"] == "MOCK";
    let provider = mock && c["provider_mode"] == "MOCK";
    let mut methods = vec!["ACCOUNT_PASSWORD"];
    if delivery || (c["delivery_mode"] == "LIVE" && crate::mail_delivery::configured(a)) { methods.push("EMAIL_CODE"); }
    if delivery || (c["delivery_mode"] == "LIVE" && crate::sms_auth::configured(a)) { methods.push("PHONE_OTP"); }
    if provider || (c["provider_mode"] == "LIVE" && crate::google_login::Google::configured(a).is_ok()) { methods.push("GOOGLE"); }
    if provider || (c["provider_mode"] == "LIVE" && crate::github_login::Github::configured(a).is_ok()) { methods.push("GITHUB"); }
    methods
}
pub async fn route(a: &Auth, method: Method) -> Result<Response> {
    ensure(method == Method::Get, 405, "METHOD_NOT_ALLOWED")?;
    let query = form(a.request.url()?.query().unwrap_or_default())?;
    shape("LoginCapabilitiesQuery", &query)?;
    let c = client(a, &text(&query, "clientId")).await?;
    Ok(json_response(json!({"data":{"methods":available(a, &c)},"requestId":a.request_id}), 200)?)
}
