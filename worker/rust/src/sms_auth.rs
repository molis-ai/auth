//! One remote verifier shared by every Auth client. No credentials reach product clients.
use crate::{http::*, identity::Auth, security::hash};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
#[wasm_bindgen(module = "/src/runtime/aliyun.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = aliyunRpc)]
    async fn rpc(
        id: &str,
        secret: &str,
        action: &str,
        input: &str,
    ) -> std::result::Result<String, JsValue>;
}
fn unavailable() -> Failure {
    Failure {
        status: 503,
        code: "UPSTREAM_UNAVAILABLE",
    }
}
pub(crate) fn configured(a: &Auth) -> bool {
    credentials(a).is_ok()
        && a.env
            .var("ALIYUN_SMS_SIGN_NAME")
            .is_ok_and(|v| !v.to_string().is_empty())
}
fn credentials(a: &Auth) -> Result<(String, String)> {
    let id = a
        .env
        .secret("ALIYUN_ACCESS_KEY_ID")
        .map_err(|_| unavailable())?
        .to_string();
    let key = a
        .env
        .secret("ALIYUN_ACCESS_KEY_SECRET")
        .map_err(|_| unavailable())?
        .to_string();
    ensure(
        !id.is_empty() && !key.is_empty(),
        503,
        "UPSTREAM_UNAVAILABLE",
    )?;
    Ok((id, key))
}
pub(crate) fn scheme(id: &str) -> String {
    hash(id)[..20].to_string()
}
async fn call(a: &Auth, action: &str, body: Value) -> Result<Value> {
    let (id, key) = credentials(a)?;
    let raw = rpc(&id, &key, action, &body.to_string())
        .await
        .map_err(|_| unavailable())?;
    let result: Value = serde_json::from_str(&raw).map_err(|_| unavailable())?;
    if action == "CheckSmsVerifyCode" && result["Code"] == "isv.ValidateFail" {
        return Err(Failure {
            status: 401,
            code: "INVALID_CREDENTIALS",
        });
    }
    if matches!(
        result["Code"].as_str(),
        Some("BUSINESS_LIMIT_CONTROL" | "FREQUENCY_FAIL")
    ) {
        return Err(Failure {
            status: 429,
            code: "RATE_LIMITED",
        });
    }
    ensure(
        result["Code"] == "OK" && result["Success"] == true,
        503,
        "UPSTREAM_UNAVAILABLE",
    )?;
    Ok(result)
}
fn phone(target: &str) -> Result<&str> {
    ensure(
        target.starts_with("+86")
            && target.len() == 14
            && target[3..].bytes().all(|b| b.is_ascii_digit()),
        400,
        "INVALID_REQUEST",
    )?;
    Ok(&target[3..])
}
pub(crate) async fn send(a: &Auth, t: &Value, id: &str, target: &str, expires: i64) -> Result<()> {
    // Explicit allowlist is required outside production; never commit real test numbers.
    if t["kind"] != "PRODUCTION" {
        let allowed = a
            .env
            .var("ALIYUN_SMS_TEST_ALLOWLIST")
            .map_err(|_| unavailable())?
            .to_string();
        ensure(
            allowed.split(',').any(|v| v.trim() == target),
            503,
            "UPSTREAM_UNAVAILABLE",
        )?;
    }
    let sign = a
        .env
        .var("ALIYUN_SMS_SIGN_NAME")
        .map_err(|_| unavailable())?
        .to_string();
    ensure(!sign.is_empty(), 503, "UPSTREAM_UNAVAILABLE")?;
    let seconds = ((expires - now()) / 1000).min(300);
    ensure(seconds > 0, 401, "INVALID_CREDENTIALS")?;
    let template = match t["purpose"].as_str() {
        Some("BIND") => "100004",
        Some("REPLACE") => "100002",
        Some("REAUTH") => "100005",
        _ => "100001",
    };
    call(a,"SendSmsVerifyCode",json!({"PhoneNumber":phone(target)?,"CountryCode":"86","SignName":sign,"TemplateCode":template,
        "SchemeName":scheme(id),"OutId":id,"TemplateParam":json!({"code":"##code##","min":((seconds+59)/60).to_string()}).to_string(),
        "CodeLength":6,"CodeType":1,"ValidTime":seconds,"Interval":60,"DuplicatePolicy":1,"ReturnVerifyCode":false,"AutoRetry":0})).await?;
    Ok(())
}
pub(crate) async fn verify(a: &Auth, id: &str, target: &str, code: &str) -> Result<bool> {
    ensure(
        code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit()),
        401,
        "INVALID_CREDENTIALS",
    )?;
    let r=call(a,"CheckSmsVerifyCode",json!({"PhoneNumber":phone(target)?,"CountryCode":"86","SchemeName":scheme(id),"OutId":id,"VerifyCode":code})).await?;
    Ok(r["Model"]["VerifyResult"] == "PASS")
}
