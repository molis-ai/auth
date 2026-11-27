//! Delivery adapters own channel routing; transactions own challenge persistence and commit guards.

pub(crate) mod mail_delivery;
pub(crate) mod mail_templates;
pub(crate) mod sms_auth;

use crate::{core::http::*, core::identity::Auth};
use serde_json::Value;
use worker::D1PreparedStatement;
pub(crate) struct Message<'a> {
    #[cfg(feature = "mock-delivery")]
    pub id: &'a str,
    pub target: &'a str,
    pub template: &'a str,
    pub credential: &'a str,
    pub expires: i64,
}
pub(crate) trait Sender {
    fn enqueue(a: &Auth, c: &Value, m: &Message) -> Result<D1PreparedStatement>;
}
pub(crate) struct SmsSender;
pub(crate) struct MailSender;
#[cfg(feature = "mock-delivery")]
fn mock(a: &Auth, c: &Value, m: &Message, channel: &str) -> Result<D1PreparedStatement> {
    ensure(
        supports_mock_delivery(&c["kind"], &c["delivery_mode"]),
        503,
        "UPSTREAM_UNAVAILABLE",
    )?;
    a.s.statement(
        "INSERT INTO auth_mock_delivery VALUES (?,?,?,?,?,?,?,?)",
        vec![
            m.id.into(),
            c["environment_id"].clone(),
            channel.into(),
            m.target.into(),
            m.template.into(),
            m.credential.into(),
            now().into(),
            m.expires.into(),
        ],
    )
}
#[cfg(not(feature = "mock-delivery"))]
fn mock(_: &Auth, _: &Value, _: &Message, _: &str) -> Result<D1PreparedStatement> {
    Err(Failure {
        status: 503,
        code: "UPSTREAM_UNAVAILABLE",
    })
}
impl Sender for SmsSender {
    fn enqueue(a: &Auth, c: &Value, m: &Message) -> Result<D1PreparedStatement> {
        mock(a, c, m, "SMS")
    }
}
impl Sender for MailSender {
    fn enqueue(a: &Auth, c: &Value, m: &Message) -> Result<D1PreparedStatement> {
        mock(a, c, m, "EMAIL")
    }
}

pub(crate) fn supports_mock_delivery(kind: &Value, mode: &Value) -> bool {
    cfg!(feature = "mock-delivery") && mode == "MOCK" && (kind == "LOCAL" || kind == "TEST")
}

pub(crate) fn supports_invitation_notifications(kind: &Value, mode: &Value) -> bool {
    supports_mock_delivery(kind, mode)
}

/// Notification metadata is not a login code or an invitation bearer capability.
#[cfg(feature = "mock-delivery")]
pub(crate) fn invitation_notification(
    a: &Auth,
    c: &Value,
    channel: &str,
    destination: &str,
    payload: &Value,
    expires: i64,
) -> Result<D1PreparedStatement> {
    ensure(
        supports_invitation_notifications(&c["kind"], &c["delivery_mode"]),
        503,
        "UPSTREAM_UNAVAILABLE",
    )?;
    a.s.statement(
        "INSERT INTO auth_mock_notification VALUES (?,?,?,?,'TENANT_INVITATION',?,?,?)",
        vec![
            crate::core::security::uuid().into(),
            c["environment_id"].clone(),
            channel.into(),
            destination.into(),
            payload.to_string().into(),
            now().into(),
            expires.into(),
        ],
    )
}

#[cfg(not(feature = "mock-delivery"))]
pub(crate) fn invitation_notification(
    _: &Auth,
    _: &Value,
    _: &str,
    _: &str,
    _: &Value,
    _: i64,
) -> Result<D1PreparedStatement> {
    Err(Failure {
        status: 503,
        code: "UPSTREAM_UNAVAILABLE",
    })
}

/// Remote delivery is performed only after the transaction has reserved a challenge.
pub(crate) async fn send_live(
    a: &Auth,
    t: &Value,
    c: &Value,
    channel: &str,
    challenge: &str,
    m: &Message<'_>,
) -> Result<()> {
    ensure(c["delivery_mode"] == "LIVE", 503, "UPSTREAM_UNAVAILABLE")?;
    let list_key = match channel {
        "EMAIL" => "ALIYUN_MAIL_TEST_ALLOWLIST",
        "SMS" => "ALIYUN_SMS_TEST_ALLOWLIST",
        _ => {
            return Err(Failure {
                status: 400,
                code: "INVALID_REQUEST",
            });
        }
    };
    // Only local dev treats an explicitly empty recipient list as unrestricted.
    if c["kind"] != "PRODUCTION" {
        let allowed = a
            .env
            .var(list_key)
            .map_err(|_| Failure {
                status: 503,
                code: "UPSTREAM_UNAVAILABLE",
            })?
            .to_string();
        let unrestricted_dev = allowed.is_empty()
            && c["kind"] == "LOCAL"
            && a.env
                .var("MOLIS_ENVIRONMENT")
                .is_ok_and(|v| v.to_string() == "dev");
        ensure(
            unrestricted_dev || allowed.split(',').any(|v| v.trim() == m.target),
            503,
            "UPSTREAM_UNAVAILABLE",
        )?;
    }
    if channel == "EMAIL" {
        crate::delivery::mail_delivery::send(a, m).await
    } else {
        crate::delivery::sms_auth::send(a, t, challenge, m.target, m.expires).await
    }
}
