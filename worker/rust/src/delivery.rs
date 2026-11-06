//! Delivery ports. Only the explicit LOCAL/TEST mock adapter is installed in AUTH-04.
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
