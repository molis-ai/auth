use crate::{
    auth::login_sessions,
    http::*,
    identity::Auth,
    management_protocol::{
        self, Access, Action, MANAGER_ROLES, PageFilters, PageOrder, Read, Service,
    },
    security::uuid,
};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Method, Response};

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

fn audit_view(r: &Value) -> Result<Value> {
    let changes = if r["change_summary"].is_null() {
        Value::Null
    } else {
        let summary: Value = stored_json(r, "change_summary")?;
        ensure(summary.is_object(), 503, "AUTH_UNAVAILABLE")?;
        summary["changes"].clone()
    };
    Ok(
        json!({"auditEventId":r["id"],"actorUserId":r["actor_user_id"],"operation":r["operation"],"target":{"kind":r["target_type"],"id":r["target_id"]},"tenantId":r["tenant_id"],"occurredAt":iso(&r["occurred_at"]),"result":if r["outcome"]=="SUCCESS"{"SUCCEEDED"}else{"DENIED"},"changes":changes,"reason":r["reason"],"requestId":r["request_id"],"actorDisplayName":r["actor_display_name"],"tenantName":r["tenant_name"]}),
    )
}
fn audit_timestamp(value: &str) -> Result<i64> {
    use std::sync::LazyLock;
    static RFC3339: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$")
            .expect("audit timestamp pattern")
    });
    let captures = RFC3339
        .captures(value)
        .ok_or_else(Failure::invalid_request)?;
    shape(
        "Timestamp",
        &json!(format!("{}Z", captures[1].to_ascii_uppercase())),
    )?;
    let timestamp = js_sys::Date::parse(value);
    ensure(timestamp.is_finite(), 400, "INVALID_REQUEST")?;
    Ok(timestamp as i64)
}

fn audit_page(a: &Auth, action: &Action) -> Result<Read> {
    let platform = action.op == "audit.platform-list";
    let keys: &[&str] = if platform {
        &[
            "tenantId",
            "category",
            "operation",
            "actorUserId",
            "targetId",
            "result",
            "from",
            "to",
            "q",
        ]
    } else {
        &[]
    };
    let mut filters = PageFilters::parse(a, keys)?;
    if !platform {
        filters.bind("a.tenant_id=?", [json!(action.tenant_id)]);
    }
    if let Some(tenant) = filters.values["tenantId"].as_str() {
        let tenant = json!(tenant);
        shape("Id", &tenant)?;
        filters.bind("a.tenant_id=?", [tenant]);
    }
    for (key, column) in [
        ("operation", "a.operation"),
        ("actorUserId", "a.actor_user_id"),
        ("targetId", "a.target_id"),
    ] {
        if let Some(value) = filters
            .values
            .get(key)
            .filter(|value| !value.is_null())
            .cloned()
        {
            shape("Id", &value)?;
            filters.bind(format!("{column}=?"), [value]);
        }
    }
    if let Some(category) = filters.values["category"].as_str() {
        let prefixes = match category {
            "account" => &["user.*", "permission.*"][..],
            "tenant" => &["tenant.*", "member.*", "invitation.*", "transfer.*"],
            "app" => &["application.*", "client.*"],
            "billing" => &[
                "catalog.*",
                "subscription.*",
                "pool.*",
                "seat.*",
                "billing.*",
            ],
            _ => return Err(Failure::invalid_request()),
        };
        let predicate = vec!["a.operation GLOB ?"; prefixes.len()].join(" OR ");
        filters.bind(
            format!("({predicate})"),
            prefixes.iter().map(|prefix| json!(prefix)),
        );
    }
    if let Some(result) = filters.values["result"].as_str() {
        let outcome = match result {
            "SUCCEEDED" => "SUCCESS",
            "DENIED" => "DENIED",
            _ => return Err(Failure::invalid_request()),
        };
        filters.bind("a.outcome=?", [json!(outcome)]);
    }
    let date = |key| {
        filters.values[key]
            .as_str()
            .map(audit_timestamp)
            .transpose()
    };
    let (from, to) = (date("from")?, date("to")?);
    if let Some(from) = from {
        ensure(to.is_none_or(|to| from <= to), 400, "INVALID_REQUEST")?;
        filters.bind("a.occurred_at>=?", [json!(from)]);
    }
    if let Some(to) = to {
        filters.bind("a.occurred_at<=?", [json!(to)]);
    }
    filters.search(&[
        "a.id",
        "a.operation",
        "a.actor_user_id",
        "a.target_id",
        "a.tenant_id",
        "a.reason",
    ])?;
    Ok(filters.source_page(
        "SELECT a.*, u.display_name actor_display_name, s.name tenant_name
         FROM auth_management_audit a
         LEFT JOIN auth_user u ON u.id=a.actor_user_id
         LEFT JOIN auth_space s ON s.id=a.tenant_id",
        audit_view,
        PageOrder::TimeDesc("occurred_at"),
    ))
}

pub fn matches(path: &str) -> bool {
    path == "/api/v2/platform/audit-events"
        || path.starts_with("/api/v2/platform/audit-events/")
        || (path.starts_with("/api/v2/tenants/") && path.ends_with("/audit-events"))
}

pub async fn route(a: &Auth, path: &str, method: Method) -> Result<Response> {
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let (op, tenant_id, access) = match (parts.as_slice(), method) {
        (["api", "v2", "platform", "audit-events"], Method::Get) => {
            ("audit.platform-list", "", Access::Permission("AUDIT_READ"))
        }
        (["api", "v2", "tenants", tenant, "audit-events"], Method::Get) => {
            ("audit.tenant-list", *tenant, Access::Member(MANAGER_ROLES))
        }
        _ => {
            login_sessions::active(a).await?;
            return Err(Failure {
                status: 501,
                code: "UNIFIED_ACCOUNT_NOT_IMPLEMENTED",
            });
        }
    };
    let action = Action {
        op,
        path: path.into(),
        tenant_id: tenant_id.into(),
        id: String::new(),
        schema: None,
    };
    let result =
        management_protocol::read(a, &action, access, None, audit_page(a, &action)).await?;
    Ok(json_response(
        json!({"data":result,"requestId":a.request_id}),
        200,
    )?)
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
