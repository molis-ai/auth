//! Subscription lifecycle and capacity transitions. Seat assignment is owned by AUTH-09.
use crate::{
    http::*,
    security::uuid,
    tenant_protocol as protocol,
    tenants::{Action, Change, Context, Service, expected},
};
use serde_json::{Value, json};
use worker::D1PreparedStatement;

pub const SUBSCRIPTIONS: &str =
    "SELECT s.*,CAST(s.version AS TEXT) stamp FROM billing_subscription s";
pub const POOLS: &str = "SELECT p.*,json_array(p.subscription_id,p.seat_type_id) id,(SELECT count(*) FROM billing_seat_assignment a WHERE a.subscription_id=p.subscription_id AND a.seat_type_id=p.seat_type_id AND a.status='ASSIGNED') assigned_count,printf('%d:%d',p.version,(SELECT count(*) FROM billing_seat_assignment a WHERE a.subscription_id=p.subscription_id AND a.seat_type_id=p.seat_type_id AND a.status='ASSIGNED')) stamp FROM billing_seat_pool p";
pub fn view(s: &Value) -> Value {
    let enabled = number(s, "enabled") == 1;
    let n = now();
    json!({"subscriptionId":s["id"],"owner":if s["owner_user_id"].is_null(){json!({"kind":"TENANT","id":s["owner_tenant_id"]})}else{json!({"kind":"USER","id":s["owner_user_id"]})},"planId":s["plan_id"],"planVersion":s["plan_version"],"enabled":enabled,"startsAt":iso(&s["starts_at"]),"endsAt":iso(&s["ends_at"]),"version":s["version"],"status":if !enabled{"DISABLED"}else if n<number(s,"starts_at"){"SCHEDULED"}else if n>=number(s,"ends_at"){"EXPIRED"}else{"ACTIVE"}})
}
pub fn pool_view(p: &Value) -> Value {
    json!({"subscriptionId":p["subscription_id"],"tenantId":p["tenant_id"],"seatTypeId":p["seat_type_id"],"quantity":p["quantity"],"assignedCount":p["assigned_count"],"availableCount":number(p,"quantity")-number(p,"assigned_count"),"version":p["version"]})
}
fn timestamp(v: &Value) -> Result<Value> {
    let t = js_sys::Date::parse(v.as_str().unwrap_or_default());
    ensure(t.is_finite(), 400, "INVALID_REQUEST")?;
    Ok((t as i64).into())
}
impl Service<'_> {
    pub async fn subscription(&self, id: &str) -> Result<Value> {
        let r = self
            .a
            .s
            .one(&format!("{SUBSCRIPTIONS} WHERE s.id=?"), vec![id.into()])
            .await?;
        ensure(!r.is_null(), 404, "NOT_FOUND")?;
        Ok(r)
    }
    pub fn subscription_guard(&self, r: &Value) -> Result<D1PreparedStatement> {
        self.a.s.guard(
            "EXISTS(SELECT 1 FROM billing_subscription WHERE id=? AND version=?)",
            vec![r["id"].clone(), r["version"].clone()],
        )
    }
    pub async fn subscription_read(&self, action: &Action, ctx: &mut Context) -> Result<Value> {
        match action.op {
            "subscription.get" => Ok(view(&ctx.record)),
            "subscription.mine" => {
                protocol::page(
                    self,
                    action,
                    ctx,
                    &format!("{SUBSCRIPTIONS} WHERE s.owner_user_id=?"),
                    vec![self.user()],
                    view,
                )
                .await
            }
            "subscription.tenant" => {
                protocol::page(
                    self,
                    action,
                    ctx,
                    &format!("{SUBSCRIPTIONS} WHERE s.owner_tenant_id=?"),
                    vec![ctx.tenant["id"].clone()],
                    view,
                )
                .await
            }
            "pool.platform" => {
                protocol::page(
                    self,
                    action,
                    ctx,
                    &format!("{POOLS} WHERE p.subscription_id=? AND p.status='CURRENT'"),
                    vec![ctx.record["id"].clone()],
                    pool_view,
                )
                .await
            }
            "pool.list" => {
                protocol::page(
                    self,
                    action,
                    ctx,
                    &format!("{POOLS} WHERE p.tenant_id=? AND p.status='CURRENT'"),
                    vec![ctx.tenant["id"].clone()],
                    pool_view,
                )
                .await
            }
            _ => protocol::page(self, action, ctx, SUBSCRIPTIONS, vec![], view).await,
        }
    }
    // All live ASSIGNED rows count, including expired/disabled subscriptions. The same
    // predicate is checked inside the final D1 batch, so a concurrent assignment cannot
    // slip between a capacity read and a reduction. AUTH-09 must use these pool versions.
    pub async fn capacity_change(
        &self,
        s: &Value,
        plan: &Value,
        explicit: Option<&Value>,
        plan_changed: bool,
    ) -> Result<Vec<D1PreparedStatement>> {
        let current = self
            .a
            .s
            .all(
                "SELECT * FROM billing_seat_pool WHERE subscription_id=? AND status='CURRENT'",
                vec![s["id"].clone()],
            )
            .await?;
        let quantities = explicit.cloned().unwrap_or_else(|| {
            let mut map = serde_json::Map::new();
            for p in &current {
                map.insert(text(p, "seat_type_id"), p["quantity"].clone());
            }
            Value::Object(map)
        });
        for key in quantities.as_object().unwrap().keys() {
            ensure(
                plan["seatTypes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|t| t["seatTypeId"] == key.as_str()),
                400,
                "INVALID_REQUEST",
            )?;
        }
        let q = quantities.to_string();
        let capacity = "NOT EXISTS(SELECT 1 FROM billing_seat_assignment a WHERE a.subscription_id=? AND a.status='ASSIGNED' GROUP BY a.seat_type_id HAVING count(*)>COALESCE((SELECT value FROM json_each(?) WHERE key=a.seat_type_id),0))";
        let args = vec![s["id"].clone(), q.clone().into()];
        let check = self
            .a
            .s
            .one(&format!("SELECT ({capacity}) ok"), args.clone())
            .await?;
        ensure(number(&check, "ok") == 1, 409, "CAPACITY_CONFLICT")?;
        Ok(vec![
            self.a.s.guard(capacity,args)?,
            self.a.s.statement("UPDATE billing_seat_pool SET status='RETIRED',quantity=0,version=version+1 WHERE subscription_id=? AND status='CURRENT' AND seat_type_id NOT IN (SELECT key FROM json_each(?))",vec![s["id"].clone(),q.clone().into()])?,
            self.a.s.statement("INSERT INTO billing_seat_pool(subscription_id,tenant_id,seat_type_id,quantity) SELECT ?,?,key,value FROM json_each(?) WHERE true ON CONFLICT(subscription_id,seat_type_id) DO UPDATE SET quantity=excluded.quantity,status='CURRENT',version=billing_seat_pool.version+CASE WHEN billing_seat_pool.quantity<>excluded.quantity OR billing_seat_pool.status<>'CURRENT' OR ? THEN 1 ELSE 0 END",vec![s["id"].clone(),s["owner_tenant_id"].clone(),q.into(),plan_changed.into()])?,
        ])
    }
    pub async fn subscription_change(
        &self,
        action: &Action,
        ctx: &Context,
        b: &Value,
    ) -> Result<Change> {
        let create = action.op == "subscription.create";
        let n = now();
        let mut s = if create {
            json!({"id":uuid(),"owner_user_id":if b["owner"]["kind"]=="USER"{b["owner"]["id"].clone()}else{Value::Null},"owner_tenant_id":if b["owner"]["kind"]=="TENANT"{b["owner"]["id"].clone()}else{Value::Null},"plan_id":b["planId"],"plan_version":b["planVersion"],"enabled":1,"version":0})
        } else {
            expected(b, &ctx.record)?;
            ctx.record.clone()
        };
        if let Some(p) = b.get("plan") {
            s["plan_id"] = p["planId"].clone();
            s["plan_version"] = p["planVersion"].clone();
        }
        if let Some(v) = b.get("startsAt") {
            s["starts_at"] = timestamp(v)?;
        }
        if let Some(v) = b.get("endsAt") {
            s["ends_at"] = timestamp(v)?;
        }
        if let Some(v) = b.get("enabled") {
            s["enabled"] = json!(if v == true { 1 } else { 0 });
        }
        ensure(
            number(&s, "ends_at") > number(&s, "starts_at"),
            400,
            "INVALID_REQUEST",
        )?;
        if action.op == "subscription.renew" {
            ensure(
                number(&s, "ends_at") > number(&ctx.record, "ends_at"),
                400,
                "INVALID_REQUEST",
            )?;
        }
        let plan = self.billing_plan(&s["plan_id"], &s["plan_version"]).await?;
        let personal = !s["owner_user_id"].is_null();
        ensure(
            !personal || b.get("seatQuantities").is_none(),
            400,
            "INVALID_REQUEST",
        )?;
        let mut w = vec![];
        if create {
            if personal {
                let user = self
                    .a
                    .s
                    .one(
                        "SELECT id FROM auth_user WHERE id=? AND status='ACTIVE'",
                        vec![s["owner_user_id"].clone()],
                    )
                    .await?;
                ensure(!user.is_null(), 404, "NOT_FOUND")?;
                w.push(self.a.s.guard(
                    "EXISTS(SELECT 1 FROM auth_user WHERE id=? AND status='ACTIVE')",
                    vec![s["owner_user_id"].clone()],
                )?);
            } else {
                // Platform may provision or maintain subscriptions while a tenant is disabled;
                // this never re-enables tenant access and never changes its subscription clock.
                let tenant = self.tenant(&text(&s, "owner_tenant_id")).await?;
                w.push(self.tenant_guard(&tenant, false)?);
            }
            w.push(self.a.s.statement("INSERT INTO billing_subscription(id,owner_user_id,owner_tenant_id,plan_id,plan_version,enabled,starts_at,ends_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",vec![s["id"].clone(),s["owner_user_id"].clone(),s["owner_tenant_id"].clone(),s["plan_id"].clone(),s["plan_version"].clone(),s["enabled"].clone(),s["starts_at"].clone(),s["ends_at"].clone(),n.into(),n.into()])?);
        } else {
            s["version"] = (number(&s, "version") + 1).into();
            w.push(self.a.s.statement("UPDATE billing_subscription SET plan_id=?,plan_version=?,enabled=?,starts_at=?,ends_at=?,version=version+1,updated_at=? WHERE id=?",vec![s["plan_id"].clone(),s["plan_version"].clone(),s["enabled"].clone(),s["starts_at"].clone(),s["ends_at"].clone(),n.into(),s["id"].clone()])?);
        }
        let plan_changed = !create
            && (s["plan_id"] != ctx.record["plan_id"]
                || s["plan_version"] != ctx.record["plan_version"]);
        if !personal && (create || b.get("seatQuantities").is_some() || plan_changed) {
            w.extend(
                self.capacity_change(&s, &plan, b.get("seatQuantities"), plan_changed)
                    .await?,
            );
        }
        if personal {
            w.push(self.a.s.statement("INSERT INTO billing_user_revision VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET version=version+1",vec![s["owner_user_id"].clone()])?);
        } else {
            w.push(self.a.s.statement("UPDATE auth_managed_tenant SET entitlement_revision=entitlement_revision+1,updated_at=? WHERE space_id=?",vec![n.into(),s["owner_tenant_id"].clone()])?);
        }
        Ok(Change::new(view(&s), w))
    }
}
