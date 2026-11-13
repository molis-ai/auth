//! Verification mail delivery; code verification remains in Auth's shared challenge service.
use crate::{delivery::Message, http::*, identity::Auth};
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
pub(crate) async fn send(a: &Auth, m: &Message<'_>) -> Result<()> {
    ensure(m.expires > now(), 503, "UPSTREAM_UNAVAILABLE")?;
    let id = a
        .env
        .secret("ALIYUN_ACCESS_KEY_ID")
        .map_err(|_| unavailable())?
        .to_string();
    let secret = a
        .env
        .secret("ALIYUN_ACCESS_KEY_SECRET")
        .map_err(|_| unavailable())?
        .to_string();
    let account = a
        .env
        .var("ALIYUN_MAIL_ACCOUNT_NAME")
        .map_err(|_| unavailable())?
        .to_string();
    let region = a
        .env
        .var("ALIYUN_MAIL_REGION")
        .map_err(|_| unavailable())?
        .to_string();
    ensure(
        !id.is_empty() && !secret.is_empty() && region == "cn-hangzhou" && !account.is_empty(),
        503,
        "UPSTREAM_UNAVAILABLE",
    )?;
    let content = crate::mail_templates::render(m.template, m.credential, m.expires, now())
        .ok_or_else(unavailable)?;
    let body = json!({"AccountName":account,"AddressType":1,"ReplyToAddress":"false","ToAddress":m.target,"FromAlias":content.sender_name,"Subject":content.subject,"TextBody":content.text});
    let raw = rpc(&id, &secret, "SingleSendMail", &body.to_string())
        .await
        .map_err(|_| unavailable())?;
    let result: Value = serde_json::from_str(&raw).map_err(|_| unavailable())?;
    ensure(
        result["Code"].is_null()
            && result["RequestId"].as_str().is_some_and(|v| !v.is_empty())
            && result["EnvId"].as_str().is_some_and(|v| !v.is_empty()),
        503,
        "UPSTREAM_UNAVAILABLE",
    )?;
    Ok(())
}
