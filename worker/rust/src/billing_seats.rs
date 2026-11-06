//! AUTH-09 seat allocation. All changes share AUTH-08 subscription/pool concurrency.
use crate::{
    billing_subscriptions::{POOLS, pool_view},
    http::*,
    security::uuid,
    tenant_protocol as protocol,
    tenants::{Action, Change, Context, Service, expected},
};
use serde_json::{Value, json};
use worker::D1PreparedStatement;

pub fn view(r: &Value) -> Value {
    json!({"assignmentId":r["id"],"subscriptionId":r["subscription_id"],"seatTypeId":r["seat_type_id"],"membershipId":r["membership_id"],"userId":r["user_id"],"status":r["status"],"assignedAt":iso(&r["assigned_at"]),"endedAt":iso(&r["ended_at"]),"endReason":r["end_reason"],"version":r["version"]})
}
impl Service<'_> {
    /// Compose this plan with the membership owner transition. Every statement
    /// selects the current ASSIGNED set inside the same D1 transaction; no pre-read
    /// list can miss a concurrent allocation. Ended rows and other memberships stay.
    pub(crate) fn release_member_seats(
        &self,
        m: &Value,
        leaving: bool,
        n: i64,
    ) -> Result<Vec<D1PreparedStatement>> {
        let reason = if leaving {
            "MEMBER_LEFT"
        } else {
            "MEMBER_REMOVED"
        };
        Ok(vec![
            self.a.s.statement("UPDATE billing_seat_pool SET version=version+1 WHERE tenant_id=? AND EXISTS(SELECT 1 FROM billing_seat_assignment a WHERE a.subscription_id=billing_seat_pool.subscription_id AND a.seat_type_id=billing_seat_pool.seat_type_id AND a.membership_id=? AND a.status='ASSIGNED')",vec![m["tenant_id"].clone(),m["id"].clone()])?,
            self.a.s.statement("INSERT INTO auth_management_audit(id,actor_user_id,client_id,tenant_id,operation,target_type,target_id,outcome,reason,change_summary,request_id,occurred_at) SELECT lower(hex(randomblob(16))),?,?,tenant_id,'seat.member-release','ASSIGNMENT',id,'SUCCESS',?,json_object('membershipId',membership_id,'subscriptionId',subscription_id,'seatTypeId',seat_type_id,'userId',user_id,'changes',json_array(json_object('field','status','before','ASSIGNED','after','ENDED'),json_object('field','endReason','before',NULL,'after',?))),?,? FROM billing_seat_assignment WHERE tenant_id=? AND membership_id=? AND status='ASSIGNED'",vec![self.user(),self.s["client_id"].clone(),reason.into(),reason.into(),self.a.request_id.clone().into(),n.into(),m["tenant_id"].clone(),m["id"].clone()])?,
            self.a.s.statement("UPDATE billing_seat_assignment SET status='ENDED',ended_at=?,end_reason=?,version=version+1 WHERE tenant_id=? AND membership_id=? AND status='ASSIGNED'",vec![n.into(),reason.into(),m["tenant_id"].clone(),m["id"].clone()])?,
            self.a.s.guard("NOT EXISTS(SELECT 1 FROM billing_seat_assignment WHERE tenant_id=? AND membership_id=? AND status='ASSIGNED')",vec![m["tenant_id"].clone(),m["id"].clone()])?,
            self.a.s.statement("INSERT INTO billing_user_revision VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET version=version+1",vec![m["user_id"].clone()])?,
        ])
    }
    pub async fn seat_assignment(&self, id: &str, tenant: &str) -> Result<Value> {
        let r = self
            .a
            .s
            .one(
                "SELECT * FROM billing_seat_assignment WHERE id=? AND tenant_id=?",
                vec![id.into(), tenant.into()],
            )
            .await?;
        ensure(!r.is_null(), 404, "NOT_FOUND")?;
        Ok(r)
    }
    pub async fn seat_list(&self, action: &Action, ctx: &mut Context) -> Result<Value> {
        let q = form(self.a.request.url()?.query().unwrap_or_default())?;
        let state = q.get("state").and_then(Value::as_str).unwrap_or("current");
        ensure(
            ["current", "history"].contains(&state),
            400,
            "INVALID_REQUEST",
        )?;
        let mut args = vec![
            ctx.tenant["id"].clone(),
            if state == "current" {
                "ASSIGNED"
            } else {
                "ENDED"
            }
            .into(),
        ];
        let mut sql="SELECT a.*,CAST(a.version AS TEXT) stamp FROM billing_seat_assignment a WHERE a.tenant_id=? AND a.status=?".to_string();
        if ctx.member["role"] == "MEMBER" {
            sql.push_str(" AND a.user_id=?");
            args.push(self.user());
        }
        protocol::filtered_page(self, action, ctx, &sql, args, view, &json!({"state":state})).await
    }
    pub async fn seat_change(&self, action: &Action, ctx: &Context, b: &Value) -> Result<Change> {
        let assign = action.op == "seat.assign";
        let release = action.op == "seat.release";
        let subscription_id = if assign {
            b["subscriptionId"].clone()
        } else {
            ctx.record["subscription_id"].clone()
        };
        let seat_type = if assign {
            b["seatTypeId"].clone()
        } else {
            ctx.record["seat_type_id"].clone()
        };
        let subscription = self
            .a
            .s
            .one(
                "SELECT * FROM billing_subscription WHERE id=? AND owner_tenant_id=?",
                vec![subscription_id.clone(), ctx.tenant["id"].clone()],
            )
            .await?;
        ensure(!subscription.is_null(), 404, "NOT_FOUND")?;
        let mut pool = self
            .a
            .s
            .one(
                &format!(
                    "{POOLS} WHERE p.subscription_id=? AND p.seat_type_id=? AND p.tenant_id=?"
                ),
                vec![
                    subscription_id.clone(),
                    seat_type.clone(),
                    ctx.tenant["id"].clone(),
                ],
            )
            .await?;
        ensure(!pool.is_null(), 404, "NOT_FOUND")?;
        expected(b, if assign { &pool } else { &ctx.record })?;
        ensure(pool["status"] == "CURRENT", 409, "VERSION_CONFLICT")?;
        if !assign {
            ensure(ctx.record["status"] == "ASSIGNED", 409, "VERSION_CONFLICT")?;
        }
        let mut w=vec![self.subscription_guard(&subscription)?,
            self.a.s.guard("EXISTS(SELECT 1 FROM billing_seat_pool WHERE subscription_id=? AND tenant_id=? AND seat_type_id=? AND status='CURRENT' AND version=?)",vec![subscription_id.clone(),ctx.tenant["id"].clone(),seat_type.clone(),pool["version"].clone()])?,
            // Make the revision returned to callers refer to the actual committed value.
            self.a.s.guard("EXISTS(SELECT 1 FROM auth_managed_tenant WHERE space_id=? AND entitlement_revision=?)",vec![ctx.tenant["id"].clone(),ctx.tenant["entitlement_revision"].clone()])?,
        ];
        let mut target = Value::Null;
        if !release {
            let n = now();
            ensure(
                number(&subscription, "enabled") == 1
                    && number(&subscription, "starts_at") <= n
                    && n < number(&subscription, "ends_at"),
                409,
                "VERSION_CONFLICT",
            )?;
            // Use the database clock at commit, not only the earlier request-time check.
            w.push(self.a.s.guard("EXISTS(SELECT 1 FROM billing_subscription s JOIN billing_plan_seat_type t ON t.plan_id=s.plan_id AND t.plan_version=s.plan_version WHERE s.id=? AND s.enabled=1 AND s.starts_at<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AND s.ends_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AND t.seat_type_id=?)",vec![subscription_id.clone(),seat_type.clone()])?);
            target = self
                .membership(
                    &text(
                        b,
                        if assign {
                            "membershipId"
                        } else {
                            "targetMembershipId"
                        },
                    ),
                    &action.tenant_id,
                )
                .await?;
            ensure(
                target["status"] == "ACTIVE" && target["user_status"] == "ACTIVE",
                409,
                "VERSION_CONFLICT",
            )?;
            if !assign {
                ensure(
                    target["id"] != ctx.record["membership_id"],
                    400,
                    "INVALID_REQUEST",
                )?;
            }
            let duplicate=self.a.s.one("SELECT id FROM billing_seat_assignment WHERE subscription_id=? AND seat_type_id=? AND membership_id=? AND status='ASSIGNED'",vec![subscription_id.clone(),seat_type.clone(),target["id"].clone()]).await?;
            ensure(duplicate.is_null(), 409, "VERSION_CONFLICT")?;
            w.push(self.member_guard(&target)?);
            w.push(self.a.s.guard(
                "EXISTS(SELECT 1 FROM auth_user WHERE id=? AND status='ACTIVE')",
                vec![target["user_id"].clone()],
            )?);
        }
        let count = number(&pool, "assigned_count");
        let delta = if assign {
            1
        } else if release {
            -1
        } else {
            0
        };
        ensure(
            count + delta >= 0 && count + delta <= number(&pool, "quantity"),
            409,
            "CAPACITY_CONFLICT",
        )?;
        let n = now();
        let mut ended = ctx.record.clone();
        if !assign {
            w.push(self.a.s.guard("EXISTS(SELECT 1 FROM billing_seat_assignment WHERE id=? AND tenant_id=? AND version=? AND status='ASSIGNED')",vec![ctx.record["id"].clone(),ctx.tenant["id"].clone(),ctx.record["version"].clone()])?);
            ended["status"] = "ENDED".into();
            ended["ended_at"] = n.into();
            ended["end_reason"] = if release { "RELEASED" } else { "REASSIGNED" }.into();
            ended["version"] = (number(&ended, "version") + 1).into();
            w.push(self.a.s.statement("UPDATE billing_seat_assignment SET status='ENDED',ended_at=?,end_reason=?,version=version+1 WHERE id=?",vec![n.into(),ended["end_reason"].clone(),ended["id"].clone()])?);
        }
        let assignment = if release {
            ended.clone()
        } else {
            let r = json!({"id":uuid(),"subscription_id":subscription_id,"seat_type_id":seat_type,"membership_id":target["id"],"user_id":target["user_id"],"status":"ASSIGNED","assigned_at":n,"ended_at":null,"end_reason":null,"version":0});
            w.push(self.a.s.statement("INSERT INTO billing_seat_assignment(id,subscription_id,seat_type_id,tenant_id,membership_id,user_id,status,assigned_at) VALUES (?,?,?,?,?,?,'ASSIGNED',?)",vec![r["id"].clone(),subscription_id.clone(),seat_type.clone(),ctx.tenant["id"].clone(),target["id"].clone(),target["user_id"].clone(),n.into()])?);
            r
        };
        // Reassignment ends the old record before inserting the new one. Validate the
        // final occupancy in the same batch, including late competing changes.
        w.push(self.a.s.guard("EXISTS(SELECT 1 FROM billing_seat_pool p WHERE p.subscription_id=? AND p.seat_type_id=? AND p.status='CURRENT' AND (SELECT count(*) FROM billing_seat_assignment a WHERE a.subscription_id=p.subscription_id AND a.seat_type_id=p.seat_type_id AND a.status='ASSIGNED')=? AND p.quantity>=?)",vec![subscription_id.clone(),seat_type.clone(),(count+delta).into(),(count+delta).into()])?);
        w.push(self.a.s.statement("UPDATE billing_seat_pool SET version=version+1 WHERE subscription_id=? AND seat_type_id=?",vec![subscription_id,seat_type])?);
        w.push(self.a.s.statement("UPDATE auth_managed_tenant SET entitlement_revision=entitlement_revision+1,updated_at=? WHERE space_id=?",vec![n.into(),ctx.tenant["id"].clone()])?);
        let mut users = vec![assignment["user_id"].clone()];
        if !assign && ctx.record["user_id"] != assignment["user_id"] {
            users.push(ctx.record["user_id"].clone());
        }
        w.push(self.a.s.statement("INSERT INTO billing_user_revision SELECT value,1 FROM json_each(?) WHERE true ON CONFLICT(user_id) DO UPDATE SET version=version+1",vec![json!(users).to_string().into()])?);
        pool["version"] = (number(&pool, "version") + 1).into();
        pool["assigned_count"] = (count + delta).into();
        let mut result = json!({"assignment":view(&assignment),"pool":pool_view(&pool),"entitlementRevision":format!("tenant:{}:{}",text(&ctx.tenant,"id"),number(&ctx.tenant,"entitlement_revision")+1)});
        if !assign && !release {
            result["endedAssignment"] = view(&ended);
        }
        Ok(Change::new(result, w))
    }
    pub fn seat_audit(
        &self,
        action: &Action,
        b: &Value,
        before: &Value,
        result: &Value,
    ) -> Result<D1PreparedStatement> {
        let after = &result["assignment"];
        let fields = [
            "assignmentId",
            "membershipId",
            "userId",
            "status",
            "assignedAt",
            "endedAt",
            "endReason",
            "version",
        ];
        let changes:Vec<_>=fields.into_iter().filter(|k|before[k]!=after[k]).map(|k|json!({"field":k,"before":if before[k].is_null(){Value::Null}else{json!(before[k].to_string())},"after":if after[k].is_null(){Value::Null}else{json!(after[k].to_string())}})).collect();
        self.a.s.statement("INSERT INTO auth_management_audit(id,actor_user_id,client_id,tenant_id,operation,target_type,target_id,outcome,reason,change_summary,request_id,occurred_at) VALUES (?,?,?,?,?,'ASSIGNMENT',?,'SUCCESS',?,?,?,?)",vec![uuid().into(),self.user(),self.s["client_id"].clone(),action.tenant_id.clone().into(),action.op.into(),after["assignmentId"].clone(),b["reason"].clone(),json!({"before":before,"after":result,"changes":changes}).to_string().into(),self.a.request_id.clone().into(),now().into()])
    }
}
