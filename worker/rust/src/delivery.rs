//! Delivery adapters own channel routing; transactions own challenge persistence and commit guards.
use crate::{http::*, identity::Auth};
use serde_json::Value;
use worker::D1PreparedStatement;
pub(crate) struct Message<'a> {
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
fn mock(a: &Auth, c: &Value, m: &Message, channel: &str) -> Result<D1PreparedStatement> {
    ensure(
        c["delivery_mode"] == "MOCK" && (c["kind"] == "LOCAL" || c["kind"] == "TEST"),
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

/// Notification metadata is not a login code or an invitation bearer capability.
pub(crate) fn invitation_notification(
    a: &Auth,
    c: &Value,
    channel: &str,
    destination: &str,
    payload: &Value,
    expires: i64,
) -> Result<D1PreparedStatement> {
    ensure(
        c["delivery_mode"] == "MOCK" && (c["kind"] == "LOCAL" || c["kind"] == "TEST"),
        503,
        "UPSTREAM_UNAVAILABLE",
    )?;
    a.s.statement(
        "INSERT INTO auth_mock_notification VALUES (?,?,?,?,'TENANT_INVITATION',?,?,?)",
        vec![
            crate::security::uuid().into(),
            c["environment_id"].clone(),
            channel.into(),
            destination.into(),
            payload.to_string().into(),
            now().into(),
            expires.into(),
        ],
    )
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
        crate::mail_delivery::send(a, m).await
    } else {
        crate::sms_auth::send(a, t, challenge, m.target, m.expires).await
    }
}
