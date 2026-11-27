use crate::{
    auth::management_access::{Action, Service},
    core::security::uuid,
    core::{http::*, identity::Auth},
};
use serde_json::{Value, json};
use worker::D1PreparedStatement;

pub(crate) fn diff(before: &Value, after: &Value, fields: &[&str]) -> Vec<Value> {
    fn brief(value: &Value) -> Value {
        match value {
            Value::Null => Value::Null,
            Value::String(s) => json!(s.chars().take(1000).collect::<String>()),
            _ => json!(value.to_string().chars().take(1000).collect::<String>()),
        }
    }
    fields
        .iter()
        .filter(|&&key| before[key] != after[key])
        .map(|&key| json!({"field":key,"before":brief(&before[key]),"after":brief(&after[key])}))
        .collect()
}

pub(crate) fn success(
    service: &Service<'_>,
    action: &Action,
    tenant: Value,
    kind: &str,
    target: &Value,
    reason: &Value,
    summary: Value,
) -> Result<D1PreparedStatement> {
    ensure(
        target.is_string() && (kind != "TENANT" || tenant == *target),
        503,
        "AUTH_UNAVAILABLE",
    )?;
    service.a.s.statement(
        "INSERT INTO auth_management_audit(id,actor_user_id,client_id,tenant_id,operation,target_type,target_id,outcome,reason,change_summary,request_id,occurred_at)
         VALUES (?,?,?,?,?,?,?,'SUCCESS',?,?,?,?)",
        vec![
            uuid().into(), service.user(), service.s["client_id"].clone(), tenant,
            action.op.into(), kind.into(), target.clone(), reason.clone(),
            summary.to_string().into(), service.a.request_id.clone().into(), now().into(),
        ],
    )
}

// Account security events share the audit transaction with management events.
// Their contents are reserved for service diagnostics.
pub(crate) fn account(
    a: &Auth,
    operation: &str,
    user: Value,
    client: &Value,
    summary: Value,
) -> Result<D1PreparedStatement> {
    let summary = if summary.is_null() {
        Value::Null
    } else {
        summary.to_string().into()
    };
    a.s.statement(
        "INSERT INTO auth_management_audit(id,actor_user_id,client_id,operation,target_type,target_id,outcome,change_summary,request_id,occurred_at)
         VALUES (?,?,?,?,'ACCOUNT_SECURITY',?,'SUCCESS',?,?,?)",
        vec![uuid().into(), user.clone(), client.clone(), operation.into(), user, summary, a.request_id.clone().into(), now().into()],
    )
}
