//! AUTH-10 online entitlement decisions from current identity and commercial facts.
use crate::{
    auth::login_sessions,
    auth::management_access as protocol,
    auth::management_access::{ACTIVE_MEMBER, ALL_ROLES, Context, require_member},
    core::http::*,
    core::identity::Auth,
    core::security::hash,
    tenants::TENANTS,
};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Method, Response};

// Enabled future subscriptions are included to bound negative answers by their next
// activation. Current results include only starts_at <= evaluatedAt < ends_at.
const PERSONAL: &str = "SELECT f.feature_id,s.id subscription_id,s.version subscription_version,s.starts_at,s.ends_at,'PERSONAL_SUBSCRIPTION' kind,NULL assignment_id,NULL assignment_version,NULL seat_type_id
    FROM actor JOIN billing_subscription s ON s.owner_user_id=actor.user_id
    JOIN billing_plan_personal_feature f ON f.plan_id=s.plan_id AND f.plan_version=s.plan_version
    WHERE s.enabled=1 AND s.ends_at>? AND f.feature_id IN (SELECT feature_id FROM requested)";
const TENANT: &str = "SELECT f.feature_id,s.id subscription_id,s.version subscription_version,s.starts_at,s.ends_at,'TENANT_SEAT' kind,a.id assignment_id,a.version assignment_version,a.seat_type_id
    FROM actor JOIN billing_seat_assignment a ON a.tenant_id=actor.tenant_id AND a.membership_id=actor.membership_id AND a.user_id=actor.user_id
    JOIN billing_seat_pool p ON p.subscription_id=a.subscription_id AND p.seat_type_id=a.seat_type_id AND p.tenant_id=a.tenant_id
    JOIN billing_subscription s ON s.id=a.subscription_id AND s.owner_tenant_id=a.tenant_id
    JOIN billing_plan_seat_feature f ON f.plan_id=s.plan_id AND f.plan_version=s.plan_version AND f.seat_type_id=a.seat_type_id
    WHERE a.status='ASSIGNED' AND p.status='CURRENT' AND s.enabled=1 AND s.ends_at>? AND f.feature_id IN (SELECT feature_id FROM requested)";

fn sources_statement(
    a: &Auth,
    digest: &str,
    requested: &Value,
    tenant_id: Option<&Value>,
    evaluated_at: i64,
) -> Result<D1PreparedStatement> {
    let (principal, mut args) = login_sessions::active_actor(a, digest);
    args.push(requested.clone());
    let (columns, membership, union) = if let Some(id) = tenant_id {
        args.extend([id.clone(), json!(ALL_ROLES)]);
        (
            ",m.tenant_id,m.id membership_id",
            "JOIN auth_tenant_membership m ON m.user_id=p.user_id AND m.tenant_id=?
             AND m.status='ACTIVE' AND m.role IN (SELECT value FROM json_each(?))
             JOIN auth_managed_tenant t ON t.space_id=m.tenant_id AND t.status='ACTIVE'
             JOIN auth_space s ON s.id=t.space_id",
            format!(" UNION ALL {TENANT}"),
        )
    } else {
        ("", "", String::new())
    };
    args.push(evaluated_at.into());
    if tenant_id.is_some() {
        args.push(evaluated_at.into());
    }
    // Overflow is unavailable, never a result computed after dropping a source.
    a.s.statement(
        &format!(
            "WITH principal AS ({principal}), requested AS (SELECT value feature_id FROM json_each(?)),
             actor AS (
               SELECT p.user_id{columns} FROM principal p
               JOIN auth_client_product cp ON cp.client_id=p.client_id {membership}
               WHERE NOT EXISTS (
                 SELECT 1 FROM requested r WHERE NOT EXISTS (
                   SELECT 1 FROM billing_feature f WHERE f.id=r.feature_id AND f.product IN ('SHARED',cp.product)
                 )
               )
             )
             SELECT * FROM ({PERSONAL}{union}) ORDER BY feature_id,kind,subscription_id,assignment_id
             LIMIT CASE WHEN EXISTS (SELECT 1 FROM actor) THEN 100001 ELSE 0 END"
        ),
        args,
    )
}

fn first(rows: &mut impl Iterator<Item = Vec<Value>>) -> Result<Value> {
    Ok(rows
        .next()
        .ok_or_else(Failure::unavailable)?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

fn source(r: &Value) -> Value {
    if r["kind"] == "PERSONAL_SUBSCRIPTION" {
        json!({"kind":r["kind"],"subscriptionId":r["subscription_id"]})
    } else {
        json!({"kind":r["kind"],"subscriptionId":r["subscription_id"],"seatTypeId":r["seat_type_id"],"assignmentId":r["assignment_id"]})
    }
}
async fn check_request(a: &mut Auth, method: Method) -> Result<Value> {
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
    let b: Value = serde_json::from_str(&bounded(&mut a.request, 32768).await?)?;
    shape("EntitlementCheckRequest", &b)?;
    Ok(b)
}

pub async fn route(a: &mut Auth, method: Method) -> Result<Response> {
    let authorization = a.header("Authorization");
    let origin = a.header("Origin");
    let (digest, credential) =
        login_sessions::active_lookup(a, login_sessions::bearer(&authorization))?;
    let b = match check_request(a, method).await {
        Ok(b) => b,
        Err(error) => {
            // A malformed request still reports the credential or policy failure first.
            let row = a.s.first(credential).await?;
            login_sessions::active_result(a, row, digest, &origin)?;
            return Err(error);
        }
    };
    let feature_ids = b["featureIds"]
        .as_array()
        .ok_or_else(Failure::invalid_request)?;
    let requested = &b["featureIds"];
    let tenant_id = (b["scope"]["kind"] == "TENANT").then(|| &b["scope"]["tenantId"]);
    let n = now();
    let who = login_sessions::ACCESS_USER_ID;
    let mut statements = vec![
        credential,
        a.s.statement(
            "SELECT * FROM auth_client_product WHERE client_id=(
             SELECT s.client_id FROM auth_login_access_token t
             JOIN auth_login_session s ON s.id=t.login_session_id WHERE t.token_hash=?
             )",
            vec![digest.clone().into()],
        )?,
    ];
    if let Some(id) = tenant_id {
        statements.extend([
            a.s.statement(&format!("{TENANTS} WHERE t.space_id=?"), vec![id.clone()])?,
            a.s.statement(
                &format!(
                    "SELECT * FROM auth_tenant_membership WHERE user_id={who} AND {ACTIVE_MEMBER}"
                ),
                vec![digest.clone().into(), id.clone()],
            )?,
        ]);
    }
    statements.extend([
        a.s.statement(
            "SELECT id,product FROM billing_feature WHERE id IN (SELECT value FROM json_each(?))",
            vec![requested.clone()],
        )?,
        a.s.statement(
            &format!("SELECT COALESCE((SELECT version FROM billing_user_revision WHERE user_id={who}),0) version"),
            vec![digest.clone().into()],
        )?,
        sources_statement(a, &digest, requested, tenant_id, n)?,
        a.s.statement(
            "SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) db_now",
            vec![],
        )?,
    ]);
    let mut snapshot = a.s.batch_read(statements).await?.into_iter();
    let (session, _) = login_sessions::active_result(a, first(&mut snapshot)?, digest, &origin)?;
    let product = first(&mut snapshot)?;
    ensure(!product.is_null(), 403, "POLICY_MISMATCH")?;
    let mut ctx = Context::new();
    if tenant_id.is_some() {
        ctx.tenant = first(&mut snapshot)?;
        ctx.member = first(&mut snapshot)?;
        require_member(&ctx, ALL_ROLES)?;
    }
    let features = snapshot.next().ok_or_else(Failure::unavailable)?;
    ensure(
        features.len() == feature_ids.len()
            && features
                .iter()
                .all(|f| f["product"] == "SHARED" || f["product"] == product["product"]),
        400,
        "FEATURE_UNKNOWN",
    )?;
    let user_revision = first(&mut snapshot)?;
    let rows = snapshot.next().ok_or_else(Failure::unavailable)?;
    ensure(rows.len() <= 100000, 503, "AUTH_UNAVAILABLE")?;
    let db_now = first(&mut snapshot)?["db_now"]
        .as_i64()
        .ok_or_else(Failure::unavailable)?;
    let mut until = number(&session, "absolute_expires_at")
        .min(number(&session, "last_active_at") + protocol::ttl("loginIdleSeconds"))
        .min(number(&session, "access_expires_at"));
    for r in &rows {
        until = until.min(if number(r, "starts_at") > n {
            number(r, "starts_at")
        } else {
            number(r, "ends_at")
        });
    }
    ensure(until > n, 401, "SESSION_EXPIRED")?;
    let mut decisions = vec![];
    for feature in feature_ids {
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
    let revision=hash(&json!({"user":session["user_id"],"client":session["client_id"],"product":product,"scope":b["scope"],"features":b["featureIds"],"userRevision":user_revision["version"],"tenantRevision":ctx.tenant["entitlement_revision"],"tenantVersion":ctx.tenant["version"],"membership":ctx.member,"sessionRevision":session["session_revision"],"rows":rows,"decisions":decisions}).to_string());
    // A boundary reached while reading or constructing the result requires re-evaluation.
    ensure(until > db_now.max(now()), 409, "VERSION_CONFLICT")?;
    Ok(json_response(
        json!({"data":{"scope":b["scope"],"evaluatedAt":iso(&json!(n)),"revision":revision,"decisions":decisions},"requestId":a.request_id}),
        200,
    )?)
}
