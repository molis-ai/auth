//! AUTH-08/09 catalog, subscriptions, seat management and commercial audit.

pub(crate) mod bridge;
pub(crate) mod catalog;
pub(crate) mod entitlements;
pub(crate) mod seats;
pub(crate) mod subscriptions;

use crate::{
    auth::login_sessions,
    http::*,
    identity::Auth,
    security::uuid,
    tenants::protocol::{self, Access, Lookup, Read},
    tenants::{ALL_ROLES, Action, Context, MANAGER_ROLES, Service},
};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Method, Response};

pub fn matches(path: &str) -> bool {
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    if matches!(
        parts.as_slice(),
        ["api", "v2", "tenants", _, "seat-assignments", ..]
    ) {
        return true;
    }
    [
        "/api/v2/catalog",
        "/api/v2/platform/catalog",
        "/api/v2/platform/subscriptions",
        "/api/v2/platform/audit-events",
        "/api/v2/users/me/subscriptions",
    ]
    .iter()
    .any(|p| path == *p || path.starts_with(&format!("{p}/")))
        || (path.starts_with("/api/v2/tenants/")
            && ["/subscriptions", "/seat-pools", "/audit-events"]
                .iter()
                .any(|s| path.ends_with(s)))
}
fn action(path: &str, method: Method) -> Result<Action> {
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let mut tenant_id = String::new();
    let mut id = String::new();
    let (op, schema) = match (&parts[2..], method) {
        (["catalog", "features"], Method::Get) => ("catalog.features", None),
        (["catalog", "plans"], Method::Get) => ("catalog.plans", None),
        (["platform", "catalog", "features"], Method::Post) => {
            ("catalog.feature-create", Some("FeatureCreateRequest"))
        }
        (["platform", "catalog", "plans", p, "versions"], Method::Post) => {
            id = p.to_string();
            ("catalog.plan-create", Some("PlanVersionCreateRequest"))
        }
        (["users", "me", "subscriptions"], Method::Get) => ("subscription.mine", None),
        (["platform", "subscriptions"], Method::Get) => ("subscription.list", None),
        (["platform", "subscriptions"], Method::Post) => {
            ("subscription.create", Some("SubscriptionCreateRequest"))
        }
        (["platform", "subscriptions", s], Method::Get) => {
            id = s.to_string();
            ("subscription.get", None)
        }
        (["platform", "subscriptions", s, "seat-pools"], Method::Get) => {
            id = s.to_string();
            ("pool.platform", None)
        }
        (["platform", "subscriptions", s], Method::Patch) => {
            id = s.to_string();
            ("subscription.update", Some("SubscriptionUpdateRequest"))
        }
        (["platform", "subscriptions", s, "renew"], Method::Post) => {
            id = s.to_string();
            ("subscription.renew", Some("SubscriptionRenewRequest"))
        }
        (["tenants", t, "subscriptions"], Method::Get) => {
            tenant_id = t.to_string();
            ("subscription.tenant", None)
        }
        (["tenants", t, "seat-pools"], Method::Get) => {
            tenant_id = t.to_string();
            ("pool.list", None)
        }
        (["tenants", t, "seat-assignments"], Method::Get) => {
            tenant_id = t.to_string();
            ("seat.list", None)
        }
        (["tenants", t, "seat-assignments"], Method::Post) => {
            tenant_id = t.to_string();
            ("seat.assign", Some("SeatAssignRequest"))
        }
        (["tenants", t, "seat-assignments", a, "release"], Method::Post) => {
            tenant_id = t.to_string();
            id = a.to_string();
            ("seat.release", Some("SeatReleaseRequest"))
        }
        (["tenants", t, "seat-assignments", a, "reassign"], Method::Post) => {
            tenant_id = t.to_string();
            id = a.to_string();
            ("seat.reassign", Some("SeatReassignRequest"))
        }
        (["tenants", t, "audit-events"], Method::Get) => {
            tenant_id = t.to_string();
            ("billing.tenant-audit", None)
        }
        (["platform", "audit-events"], Method::Get) => ("billing.platform-audit", None),
        _ => {
            return Err(Failure {
                status: 501,
                code: "UNIFIED_ACCOUNT_NOT_IMPLEMENTED",
            });
        }
    };
    Ok(Action {
        op,
        path: path.into(),
        tenant_id,
        id,
        schema,
    })
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
        json!({"auditEventId":r["id"],"actorUserId":r["actor_user_id"],"operation":r["operation"],"target":{"kind":r["target_type"],"id":r["target_id"]},"tenantId":r["tenant_id"],"occurredAt":iso(&r["occurred_at"]),"result":if r["outcome"]=="SUCCESS"{"SUCCEEDED"}else{"DENIED"},"changes":changes}),
    )
}
impl Service<'_> {
    async fn billing_context(&self, action: &Action) -> Result<Context> {
        let mut ctx = Context::new();
        match action.op {
            "catalog.feature-create" | "catalog.plan-create" => {
                self.platform_permission(&mut ctx, "CATALOG_WRITE").await?
            }
            "subscription.create" | "subscription.update" | "subscription.renew" => {
                self.platform_permission(&mut ctx, "SUBSCRIPTION_WRITE")
                    .await?
            }
            "seat.assign" | "seat.release" | "seat.reassign" => {
                self.member_context(&mut ctx, &action.tenant_id, MANAGER_ROLES)
                    .await?
            }
            _ => {}
        }
        if ["subscription.update", "subscription.renew"].contains(&action.op) {
            ctx.record = self.subscription(&action.id).await?;
            ctx.guards.push(self.subscription_guard(&ctx.record)?);
        }
        if action.op == "seat.release" || action.op == "seat.reassign" {
            ctx.record = self.seat_assignment(&action.id, &action.tenant_id).await?;
        }
        Ok(ctx)
    }
    fn billing_audit(
        &self,
        action: &Action,
        b: &Value,
        before: &Value,
        after: &Value,
        before_quantities: &Value,
    ) -> Result<D1PreparedStatement> {
        let subscription = action.op.starts_with("subscription.");
        let (kind, id) = if subscription {
            ("SUBSCRIPTION", after["subscriptionId"].clone())
        } else if action.op == "catalog.feature-create" {
            ("FEATURE", after["featureId"].clone())
        } else {
            ("PLAN", after["planId"].clone())
        };
        let tenant = if after["owner"]["kind"] == "TENANT" {
            after["owner"]["id"].clone()
        } else {
            Value::Null
        };
        let mut changes = vec![];
        // Public audit exposes bounded summaries; the private record also retains the full
        // catalog/subscription and requested capacity transition, never authentication inputs.
        for key in [
            "name",
            "product",
            "owner",
            "planId",
            "planVersion",
            "enabled",
            "startsAt",
            "endsAt",
            "version",
        ] {
            if before[key] != after[key] {
                changes.push(json!({"field":key,"before":if before[key].is_null(){Value::Null}else{json!(before[key].to_string())},"after":if after[key].is_null(){Value::Null}else{json!(after[key].to_string())}}));
            }
        }
        if let Some(q) = b.get("seatQuantities") {
            let brief = |v: &Value| -> Result<Value> {
                if v.is_null() {
                    return Ok(Value::Null);
                }
                let text = v.to_string();
                if text.chars().count() <= 1000 {
                    return Ok(json!(text));
                }
                let quantities = v.as_object().ok_or_else(Failure::unavailable)?;
                let seats = quantities
                    .values()
                    .try_fold(0i64, |total, quantity| {
                        total.checked_add(quantity.as_i64()?)
                    })
                    .ok_or_else(Failure::unavailable)?;
                Ok(json!(format!("{} types, {seats} seats", quantities.len())))
            };
            changes.push(json!({"field":"seatQuantities","before":brief(before_quantities)?,"after":brief(q)?}));
        }
        self.a.s.statement("INSERT INTO auth_management_audit(id,actor_user_id,client_id,tenant_id,operation,target_type,target_id,outcome,reason,change_summary,request_id,occurred_at) VALUES (?,?,?,?,?,?,?,'SUCCESS',?,?,?,?)",vec![uuid().into(),self.user(),self.s["client_id"].clone(),tenant,action.op.into(),kind.into(),id,b["reason"].clone(),json!({"before":before,"after":after,"beforeSeatQuantities":before_quantities,"requestedSeatQuantities":b["seatQuantities"],"changes":changes}).to_string().into(),self.a.request_id.clone().into(),now().into()])
    }
}
async fn read(a: &Auth, action: &Action) -> Result<Value> {
    let access = match action.op {
        "subscription.list" | "subscription.get" | "pool.platform" => {
            Access::Permission("SUBSCRIPTION_READ")
        }
        "billing.platform-audit" => Access::Permission("AUDIT_READ"),
        "subscription.tenant" | "seat.list" => Access::Member(ALL_ROLES),
        "pool.list" | "billing.tenant-audit" => Access::Member(MANAGER_ROLES),
        "catalog.features" | "catalog.plans" | "subscription.mine" => Access::Session,
        _ => unreachable!("only billing reads reach this owner"),
    };
    let lookup = matches!(action.op, "subscription.get" | "pool.platform").then(|| Lookup {
        sql: format!("{} WHERE s.id=?", subscriptions::SUBSCRIPTIONS),
        id: action.id.clone(),
        guard: Some(|service, row| service.subscription_guard(row)),
    });
    let sql = "SELECT * FROM auth_management_audit";
    let plan = match action.op {
        "seat.list" => seats::list(a, action),
        "catalog.features" | "catalog.plans" => Ok(catalog::read(action)),
        "billing.tenant-audit" => Ok(Read::page(
            format!("{sql} WHERE tenant_id=?"),
            vec![action.tenant_id.clone().into()],
            audit_view,
        )),
        "billing.platform-audit" => Ok(Read::page(sql, vec![], audit_view)),
        _ => Ok(subscriptions::read(action)),
    };
    protocol::read(a, action, access, lookup, plan).await
}

pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    let action = match action(path, method) {
        Ok(action) => action,
        Err(error) => {
            login_sessions::active(a).await?;
            return Err(error);
        }
    };
    let Some(schema) = action.schema else {
        let result = read(a, &action).await?;
        return Ok(json_response(
            json!({"data":result,"requestId":a.request_id}),
            200,
        )?);
    };
    let (s, c) = login_sessions::active(a).await?;
    let b = {
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/json"),
            400,
            "INVALID_REQUEST",
        )?;
        let b = serde_json::from_str(&crate::app::bounded(a, 262144).await?)?;
        shape(schema, &b)?;
        if !action.op.starts_with("seat.") || b.get("reason").is_some() {
            ensure(
                !text(&b, "reason").trim().is_empty(),
                400,
                "INVALID_REQUEST",
            )?;
        }
        b
    };
    let mut service = Service { a, s, c };
    let result = {
        let key = protocol::key(a)?;
        let mut last = Failure {
            status: 409,
            code: "VERSION_CONFLICT",
        };
        let mut output = None;
        for attempt in 0..2 {
            if attempt > 0 {
                let (s, c) = login_sessions::active(a).await?;
                service = Service { a, s, c };
            }
            let ctx = service.billing_context(&action).await?;
            if let Some(result) = protocol::replay(&service, &action, &b, &key).await? {
                let mut w = protocol::base(&service)?;
                w.extend(ctx.guards);
                a.s.batch(w, "VERSION_CONFLICT").await?;
                output = Some(result);
                break;
            }
            if attempt > 0 {
                break;
            }
            let result:Result<Value>=async {
                let before=if ctx.record.is_null(){Value::Null}else if action.op.starts_with("seat."){crate::billing::seats::view(&ctx.record)}else{crate::billing::subscriptions::view(&ctx.record)};
                let before_quantities=if ctx.record.is_null()||ctx.record["owner_tenant_id"].is_null(){Value::Null}else{
                    let mut m=serde_json::Map::new();for p in a.s.all("SELECT seat_type_id,quantity FROM billing_seat_pool WHERE subscription_id=? AND status='CURRENT'",vec![ctx.record["id"].clone()]).await? {m.insert(text(&p,"seat_type_id"),p["quantity"].clone());}Value::Object(m)
                };
                let change=if action.op.starts_with("seat."){service.seat_change(&action,&ctx,&b).await?}else if action.op.starts_with("catalog."){service.catalog_change(&action,&b).await?}else{service.subscription_change(&action,&ctx,&b).await?};
                let mut w=protocol::base(&service)?;w.extend(ctx.guards);w.extend(change.writes);
                w.push(if action.op.starts_with("seat."){service.seat_audit(&action,&b,&before,&change.result)?}else{service.billing_audit(&action,&b,&before,&change.result,&before_quantities)?});
                w.extend(protocol::receipt(&service,&action,&b,&key,&change.result)?);
                a.s.batch(w,"VERSION_CONFLICT").await?;Ok(change.result)
            }.await;
            match result {
                Ok(v) => {
                    output = Some(v);
                    break;
                }
                Err(e) => {
                    last = if e.code == "ALREADY_EXISTS" {
                        Failure {
                            status: 409,
                            code: "VERSION_CONFLICT",
                        }
                    } else {
                        e
                    }
                }
            }
        }
        output.ok_or(last)?
    };
    Ok(json_response(
        json!({"data":result,"requestId":a.request_id}),
        200,
    )?)
}
