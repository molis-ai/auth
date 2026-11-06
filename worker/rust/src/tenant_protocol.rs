//! Tenant request protocol: current authorization, scoped pagination and atomic retry receipts.
use crate::{
    http::*,
    identity::Auth,
    login_sessions,
    security::{hash, secret},
    tenants::{Action, Context, Service},
};
use serde_json::{Value, json};
use worker::D1PreparedStatement;

pub fn ttl(name: &str) -> i64 {
    static POLICY: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/unified-account/policy.json"
        ))
        .expect("bundled policy")
    })["defaults"][name]
        .as_i64()
        .expect("policy TTL")
        * 1000
}
pub fn base(s: &Service<'_>) -> Result<Vec<D1PreparedStatement>> {
    Ok(vec![
        login_sessions::client_guard(s.a, &s.c)?,
        login_sessions::active_guard(s.a, &s.s)?,
    ])
}
pub fn key(a: &Auth) -> Result<String> {
    let key = a.header("Idempotency-Key");
    ensure(
        (16..=128).contains(&key.chars().count()),
        400,
        "INVALID_REQUEST",
    )?;
    Ok(hash(&key))
}
pub async fn replay(
    s: &Service<'_>,
    action: &Action,
    b: &Value,
    key: &str,
) -> Result<Option<Value>> {
    let row=s.a.s.one("SELECT * FROM auth_management_result WHERE actor_user_id=? AND client_id=? AND operation=? AND target=? AND idempotency_key_hash=? AND expires_at>?",vec![s.s["user_id"].clone(),s.s["client_id"].clone(),action.op.into(),action.path.clone().into(),key.into(),now().into()]).await?;
    if row.is_null() {
        return Ok(None);
    }
    ensure(
        row["request_hash"] == hash(&b.to_string()),
        409,
        "IDEMPOTENCY_CONFLICT",
    )?;
    Ok(Some(parsed(&row, "response_json")?["data"].clone()))
}
pub fn receipt(
    s: &Service<'_>,
    action: &Action,
    b: &Value,
    key: &str,
    result: &Value,
) -> Result<Vec<D1PreparedStatement>> {
    let n = now();
    let args = vec![
        s.s["user_id"].clone(),
        s.s["client_id"].clone(),
        action.op.into(),
        action.path.clone().into(),
        key.into(),
        n.into(),
    ];
    Ok(vec![s.a.s.statement("DELETE FROM auth_management_result WHERE actor_user_id=? AND client_id=? AND operation=? AND target=? AND idempotency_key_hash=? AND expires_at<=?",args)?,
        s.a.s.statement("INSERT INTO auth_management_result VALUES (?,?,?,?,?,?,200,?,?,?)",vec![s.s["user_id"].clone(),s.s["client_id"].clone(),action.op.into(),action.path.clone().into(),key.into(),hash(&b.to_string()).into(),json!({"data":result}).to_string().into(),n.into(),(n+ttl("idempotencyTtlSeconds")).into()])?])
}
// SQL is supplied only by domain code. The server-side random cursor is bound to
// actor, client, route, page size and current permission/membership snapshots.
pub async fn page(
    s: &Service<'_>,
    action: &Action,
    ctx: &mut Context,
    sql: &str,
    args: Vec<Value>,
    view: fn(&Value) -> Value,
) -> Result<Value> {
    filtered_page(s, action, ctx, sql, args, view, &json!({})).await
}
// Filters must already be validated by the domain. Include their canonical values
// in cursor scope, and admit only those exact query keys alongside limit/cursor.
pub async fn filtered_page(
    s: &Service<'_>,
    action: &Action,
    ctx: &mut Context,
    sql: &str,
    args: Vec<Value>,
    view: fn(&Value) -> Value,
    filters: &Value,
) -> Result<Value> {
    let q = form(s.a.request.url()?.query().unwrap_or_default())?;
    let mut allowed = vec!["limit", "cursor"];
    allowed.extend(
        filters
            .as_object()
            .expect("domain filters")
            .keys()
            .map(String::as_str),
    );
    fields(&q, &[], &allowed)?;
    let limit = text(&q, "limit");
    let limit = if limit.is_empty() {
        20
    } else {
        ensure(
            limit.bytes().all(|x| x.is_ascii_digit()),
            400,
            "INVALID_REQUEST",
        )?;
        limit.parse::<i64>().unwrap_or(0)
    };
    ensure((1..=100).contains(&limit), 400, "INVALID_REQUEST")?;
    let scope=hash(&json!({"user":s.s["user_id"],"client":s.s["client_id"],"environment":s.c["environment_id"],"path":action.path,"limit":limit,"membership":ctx.member,"permission":ctx.permission,"tenantVersion":ctx.tenant["version"],"filters":filters}).to_string());
    let raw = text(&q, "cursor");
    let after = if raw.is_empty() {
        String::new()
    } else {
        ensure(token(&raw), 400, "INVALID_REQUEST")?;
        let row=s.a.s.one("SELECT payload FROM auth_one_use WHERE token_hash=? AND purpose='V2_TENANT_CURSOR' AND binding_hash=? AND expires_at>?",vec![hash(&raw).into(),scope.clone().into(),now().into()]).await?;
        ensure(!row.is_null(), 400, "INVALID_REQUEST")?;
        text(&parsed(&row, "payload")?, "after")
    };
    let mut query_args = args.clone();
    query_args.extend([after.into(), (limit + 1).into()]);
    let mut rows =
        s.a.s
            .all(
                &format!("SELECT * FROM ({sql}) WHERE id>? ORDER BY id LIMIT ?"),
                query_args,
            )
            .await?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    if !rows.is_empty() {
        let stamps: Vec<_> = rows
            .iter()
            .map(|r| json!({"id":r["id"],"stamp":r["stamp"]}))
            .collect();
        let mut bind = vec![json!(stamps).to_string().into()];
        bind.extend(args);
        ctx.guards.push(s.a.s.guard(&format!("NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM ({sql}) live WHERE live.id=json_extract(expected.value,'$.id') AND live.stamp=json_extract(expected.value,'$.stamp')))"),bind)?);
    }
    let cursor = if more {
        let raw = secret();
        ctx.guards.push(s.a.s.statement(
            "INSERT INTO auth_one_use VALUES (?,'V2_TENANT_CURSOR',?,?,?)",
            vec![
                    hash(&raw).into(),
                    scope.into(),
                    json!({"after":rows.last().unwrap()["id"]})
                        .to_string()
                        .into(),
                    (now() + 900000).into(),
                ],
        )?);
        Value::String(raw)
    } else {
        Value::Null
    };
    Ok(json!({"items":rows.iter().map(view).collect::<Vec<_>>(),"nextCursor":cursor}))
}
