//! Bounded operational events. No identifiers from domain inputs or records are emitted.
use serde_json::{Value, json};

use super::{
    http::{Result, log_env, log_event, now},
    identity::Auth,
};

pub(crate) fn outcome<T>(
    auth: &Auth,
    event: &'static str,
    started: i64,
    result: &Result<T>,
    fields: impl IntoIterator<Item = (&'static str, Value)>,
) {
    let failure = result.as_ref().err();
    log_event(
        event,
        log_env(&auth.env),
        &auth.request_id,
        fields.into_iter().chain([
            (
                "outcome",
                json!(if failure.is_none() {
                    "success"
                } else {
                    "failed"
                }),
            ),
            (
                "error_code",
                json!(failure.map_or("none", |error| error.code)),
            ),
            ("status", json!(failure.map_or(200, |error| error.status))),
            ("duration_ms", json!((now() - started).max(0))),
        ]),
        failure.is_some_and(|error| error.status >= 500),
    );
}

pub(crate) fn login_method(method: &Value) -> &'static str {
    match method.as_str() {
        Some("ACCOUNT_PASSWORD" | "EMAIL_PASSWORD") => "password",
        Some("EMAIL_CODE") => "email_code",
        Some("PHONE_OTP") => "phone_otp",
        Some("GOOGLE") => "google",
        Some("GITHUB") => "github",
        _ => "unknown",
    }
}

pub(crate) fn login<T>(
    auth: &Auth,
    entry: &'static str,
    method: &'static str,
    new_user: Option<bool>,
    started: i64,
    result: &Result<T>,
) {
    outcome(
        auth,
        "auth.login.result",
        started,
        result,
        [
            ("entry", json!(entry)),
            ("method", json!(method)),
            (
                "new_user",
                json!(result.is_ok().then_some(new_user).flatten()),
            ),
        ],
    );
}

pub(crate) fn verification<T>(
    auth: &Auth,
    event: &'static str,
    channel: &str,
    live: bool,
    started: i64,
    result: &Result<T>,
) {
    let channel = match channel {
        "EMAIL" => "email",
        "SMS" => "sms",
        _ => "unknown",
    };
    outcome(
        auth,
        event,
        started,
        result,
        [
            ("channel", json!(channel)),
            ("provider", json!(if live { "aliyun" } else { "mock" })),
        ],
    );
}
