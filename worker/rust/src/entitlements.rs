//! AUTH-10 online entitlement decisions from current identity and commercial facts.
use crate::{
    http::*,
    identity::Auth,
    login_sessions,
    security::hash,
    sensitive_transactions::shape,
    tenant_protocol as protocol,
    tenants::{Context, Service},
};
use serde_json::{Value, json};
use worker::{Method, Response};

// Enabled future subscriptions are included to bound negative answers by their next
// activation. Current results include only starts_at <= evaluatedAt < ends_at.
const PERSONAL: &str = "SELECT f.feature_id,s.id subscription_id,s.version subscription_version,s.starts_at,s.ends_at,'PERSONAL_SUBSCRIPTION' kind,NULL assignment_id,NULL assignment_version,NULL seat_type_id FROM billing_subscription s JOIN billing_plan_personal_feature f ON f.plan_id=s.plan_id AND f.plan_version=s.plan_version WHERE s.owner_user_id=? AND s.enabled=1 AND s.ends_at>? AND f.feature_id IN (SELECT value FROM json_each(?))";
const TENANT: &str = "SELECT f.feature_id,s.id subscription_id,s.version subscription_version,s.starts_at,s.ends_at,'TENANT_SEAT' kind,a.id assignment_id,a.version assignment_version,a.seat_type_id FROM billing_seat_assignment a JOIN billing_seat_pool p ON p.subscription_id=a.subscription_id AND p.seat_type_id=a.seat_type_id AND p.tenant_id=a.tenant_id JOIN billing_subscription s ON s.id=a.subscription_id AND s.owner_tenant_id=a.tenant_id JOIN billing_plan_seat_feature f ON f.plan_id=s.plan_id AND f.plan_version=s.plan_version AND f.seat_type_id=a.seat_type_id WHERE a.tenant_id=? AND a.membership_id=? AND a.user_id=? AND a.status='ASSIGNED' AND p.status='CURRENT' AND s.enabled=1 AND s.ends_at>? AND f.feature_id IN (SELECT value FROM json_each(?))";
fn source(r: &Value) -> Value {
    if r["kind"] == "PERSONAL_SUBSCRIPTION" {
        json!({"kind":r["kind"],"subscriptionId":r["subscription_id"]})
    } else {
        json!({"kind":r["kind"],"subscriptionId":r["subscription_id"],"seatTypeId":r["seat_type_id"],"assignmentId":r["assignment_id"]})
    }
}
pub async fn route(a: &mut Auth, method: Method) -> Result<Response> {
    let (s, c) = login_sessions::active(a).await?;
    ensure(
        method == Method::Post,
        501,
        "UNIFIED_ACCOUNT_NOT_IMPLEMENTED",
    )?;
    ensure(
        a.header("Content-Type").split(';').next() == Some("application/json"),
        400,
        "INVALID_REQUEST",
    )?;
    let b: Value = serde_json::from_str(&crate::app::bounded(a, 32768).await?)?;
    shape("EntitlementCheckRequest", &b)?;
    let service = Service { a, s, c };
    let product =
        a.s.one(
            "SELECT * FROM auth_client_product WHERE client_id=?",
            vec![service.s["client_id"].clone()],
        )
        .await?;
    ensure(!product.is_null(), 403, "POLICY_MISMATCH")?;
    let mut ctx = Context::new();
    if b["scope"]["kind"] == "TENANT" {
        service
            .member_context(
                &mut ctx,
                &text(&b["scope"], "tenantId"),
                &["OWNER", "ADMIN", "MEMBER"],
            )
            .await?;
    }
    let requested = b["featureIds"].to_string();
    let features =
        a.s.all(
            "SELECT id,product FROM billing_feature WHERE id IN (SELECT value FROM json_each(?))",
            vec![requested.clone().into()],
        )
        .await?;
    ensure(
        features.len() == b["featureIds"].as_array().unwrap().len()
            && features
                .iter()
                .all(|f| f["product"] == "SHARED" || f["product"] == product["product"]),
        400,
        "FEATURE_UNKNOWN",
    )?;
    let user_revision=a.s.one("SELECT COALESCE((SELECT version FROM billing_user_revision WHERE user_id=?),0) version",vec![service.user()]).await?;
    let n = now();
    let mut sql = PERSONAL.to_string();
    let mut args = vec![service.user(), n.into(), requested.clone().into()];
    if !ctx.member.is_null() {
        sql.push_str(" UNION ALL ");
        sql.push_str(TENANT);
        args.extend([
            ctx.tenant["id"].clone(),
            ctx.member["id"].clone(),
            service.user(),
            n.into(),
            requested.into(),
        ]);
    }
    // Bound work to the response contract. Overflow is an unavailable result, never
    // a partial allow/deny computed after silently dropping a source.
    let rows=a.s.all(&format!("SELECT * FROM ({sql}) ORDER BY feature_id,kind,subscription_id,assignment_id LIMIT 100001"),args).await?;
    ensure(rows.len() <= 100000, 503, "AUTH_UNAVAILABLE")?;
    let access =
        a.s.one(
            "SELECT expires_at FROM auth_login_access_token WHERE token_hash=?",
            vec![service.s["access_hash"].clone()],
        )
        .await?;
    let mut until = number(&service.s, "absolute_expires_at")
        .min(number(&service.s, "last_active_at") + protocol::ttl("loginIdleSeconds"))
        .min(number(&access, "expires_at"));
    for r in &rows {
        until = until.min(if number(r, "starts_at") > n {
            number(r, "starts_at")
        } else {
            number(r, "ends_at")
        });
    }
    ensure(until > n, 401, "SESSION_EXPIRED")?;
    let mut decisions = vec![];
    for feature in b["featureIds"].as_array().unwrap() {
        let sources: Vec<_> = rows
            .iter()
            .filter(|r| r["feature_id"] == *feature && number(r, "starts_at") <= n)
            .map(source)
            .collect();
        ensure(sources.len() <= 1000, 503, "AUTH_UNAVAILABLE")?;
        decisions.push(json!({"featureId":feature,"allowed":!sources.is_empty(),"reason":if sources.is_empty(){"FEATURE_NOT_GRANTED"}else{"GRANTED"},"validUntil":iso(&json!(until)),"sources":sources}));
    }
    // Sources/decisions are included so crossing a start/end changes the revision even
    // without a database write. evaluatedAt is excluded to keep unchanged reads stable.
    let revision=hash(&json!({"user":service.user(),"client":service.s["client_id"],"product":product,"scope":b["scope"],"features":b["featureIds"],"userRevision":user_revision["version"],"tenantRevision":ctx.tenant["entitlement_revision"],"tenantVersion":ctx.tenant["version"],"membership":ctx.member,"sessionRevision":service.s["session_revision"],"rows":rows,"decisions":decisions}).to_string());
    let mut guards = protocol::base(&service)?;
    guards.extend(ctx.guards);
    guards.push(a.s.guard(
        "EXISTS(SELECT 1 FROM auth_client_product WHERE client_id=? AND product=? AND version=?)",
        vec![
            service.s["client_id"].clone(),
            product["product"].clone(),
            product["version"].clone(),
        ],
    )?);
    guards.push(a.s.guard(
        "COALESCE((SELECT version FROM billing_user_revision WHERE user_id=?),0)=?",
        vec![service.user(), user_revision["version"].clone()],
    )?);
    if !ctx.tenant.is_null() {
        guards.push(a.s.guard(
            "EXISTS(SELECT 1 FROM auth_managed_tenant WHERE space_id=? AND entitlement_revision=?)",
            vec![
                ctx.tenant["id"].clone(),
                ctx.tenant["entitlement_revision"].clone(),
            ],
        )?);
    }
    // Re-evaluate rather than return a result computed before a time boundary passed.
    guards.push(a.s.guard(
        "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)<?",
        vec![until.into()],
    )?);
    a.s.batch(guards, "VERSION_CONFLICT").await?;
    Ok(json_response(
        json!({"data":{"scope":b["scope"],"evaluatedAt":iso(&json!(n)),"revision":revision,"decisions":decisions},"requestId":a.request_id}),
        200,
    )?)
}
