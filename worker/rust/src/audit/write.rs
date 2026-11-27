use crate::{
    auth::management_access::{Action, Service},
    core::http::*,
    core::security::uuid,
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

/// Build the audit rows from the same still-assigned set that the seat
/// transition will update inside the transaction.
pub(crate) fn member_seat_releases(
    service: &Service<'_>,
    m: &Value,
    reason: &str,
    n: i64,
) -> Result<D1PreparedStatement> {
    service.a.s.statement("INSERT INTO auth_management_audit(id,actor_user_id,client_id,tenant_id,operation,target_type,target_id,outcome,reason,change_summary,request_id,occurred_at) SELECT lower(hex(randomblob(16))),?,?,tenant_id,'seat.member-release','ASSIGNMENT',id,'SUCCESS',?,json_object('membershipId',membership_id,'subscriptionId',subscription_id,'seatTypeId',seat_type_id,'userId',user_id,'changes',json_array(json_object('field','status','before','ASSIGNED','after','ENDED'),json_object('field','endReason','before',NULL,'after',?))),?,? FROM billing_seat_assignment WHERE tenant_id=? AND membership_id=? AND status='ASSIGNED'",vec![service.user(),service.s["client_id"].clone(),reason.into(),reason.into(),service.a.request_id.clone().into(),n.into(),m["tenant_id"].clone(),m["id"].clone()])
}
