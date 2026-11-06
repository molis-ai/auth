//! Ownership transfer swaps roles atomically and never changes seat assignments.
use crate::{
    http::*,
    security::uuid,
    tenant_protocol as protocol,
    tenants::{Action, Change, Context, Service, expected, member_view},
};
use serde_json::{Value, json};
fn view(r: &Value) -> Value {
    json!({"transferId":r["id"],"tenantId":r["tenant_id"],"fromMembershipId":r["from_membership_id"],"toMembershipId":r["to_membership_id"],"status":if r["status"]=="PENDING"&&number(r,"expires_at")<=now(){json!("EXPIRED")}else{r["status"].clone()},"expiresAt":iso(&r["expires_at"]),"version":r["version"]})
}
impl Service<'_> {
    pub async fn transfer_context(&self, ctx: &mut Context, action: &Action) -> Result<()> {
        ctx.record = self
            .a
            .s
            .one(
                "SELECT * FROM auth_ownership_transfer WHERE id=?",
                vec![action.id.clone().into()],
            )
            .await?;
        ensure(!ctx.record.is_null(), 404, "NOT_FOUND")?;
        let tenant = text(&ctx.record, "tenant_id");
        ctx.from = self
            .membership(&text(&ctx.record, "from_membership_id"), &tenant)
            .await?;
        ctx.to = self
            .membership(&text(&ctx.record, "to_membership_id"), &tenant)
            .await?;
        let actor = if action.op == "transfer.accept" {
            &ctx.to
        } else {
            &ctx.from
        };
        ensure(
            actor["user_id"] == self.user() && actor["status"] == "ACTIVE",
            404,
            "NOT_FOUND",
        )?;
        if action.op == "transfer.cancel" {
            ensure(actor["role"] == "OWNER", 403, "FORBIDDEN")?;
        }
        ctx.guards.push(self.member_guard(actor)?);
        ctx.tenant = self.tenant(&tenant).await?;
        ensure(ctx.tenant["status"] == "ACTIVE", 403, "TENANT_DISABLED")?;
        ctx.guards.push(self.tenant_guard(&ctx.tenant, true)?);
        Ok(())
    }
    pub async fn transfer_list(&self, action: &Action, ctx: &mut Context) -> Result<Value> {
        protocol::page(self,action,ctx,"SELECT x.*,printf('%d:%d:%d:%d',x.version,t.version,f.version,m.version) stamp FROM auth_ownership_transfer x JOIN auth_managed_tenant t ON t.space_id=x.tenant_id JOIN auth_tenant_membership f ON f.id=x.from_membership_id JOIN auth_tenant_membership m ON m.id=x.to_membership_id WHERE t.status='ACTIVE' AND ((f.user_id=? AND f.status='ACTIVE') OR (m.user_id=? AND m.status='ACTIVE'))",vec![self.user(),self.user()],view).await
    }
    pub async fn transfer_change(
        &self,
        action: &Action,
        ctx: &Context,
        b: &Value,
    ) -> Result<Change> {
        let n = now();
        if action.op == "transfer.create" {
            expected(b, &ctx.tenant)?;
            let target = self
                .membership(&text(b, "targetMembershipId"), &text(&ctx.tenant, "id"))
                .await?;
            ensure(
                target["status"] == "ACTIVE"
                    && target["user_status"] == "ACTIVE"
                    && target["id"] != ctx.member["id"],
                400,
                "INVALID_REQUEST",
            )?;
            let id = uuid();
            let expires = n + protocol::ttl("transferTtlSeconds");
            let row = json!({"id":id,"tenant_id":ctx.tenant["id"],"from_membership_id":ctx.member["id"],"to_membership_id":target["id"],"status":"PENDING","version":0,"expires_at":expires});
            let w=vec![self.member_guard(&target)?,self.a.s.guard("EXISTS(SELECT 1 FROM auth_user WHERE id=? AND status='ACTIVE')",vec![target["user_id"].clone()])?,self.a.s.statement("UPDATE auth_ownership_transfer SET status='EXPIRED',version=version+1,resolved_at=? WHERE tenant_id=? AND status='PENDING' AND expires_at<=?",vec![n.into(),ctx.tenant["id"].clone(),n.into()])?,self.a.s.statement("INSERT INTO auth_ownership_transfer(id,tenant_id,from_membership_id,to_membership_id,status,created_at,expires_at) VALUES (?,?,?,?,'PENDING',?,?)",vec![id.into(),ctx.tenant["id"].clone(),ctx.member["id"].clone(),target["id"].clone(),n.into(),expires.into()])?];
            return Ok(Change {
                result: view(&row),
                writes: w,
                target_user: target["user_id"].clone(),
            });
        }
        let mut row = ctx.record.clone();
        expected(b, &row)?;
        ensure(
            row["status"] == "PENDING" && number(&row, "expires_at") > n,
            409,
            "VERSION_CONFLICT",
        )?;
        let mut w = vec![self.record_guard("auth_ownership_transfer", &row, true)?];
        row["version"] = (number(&row, "version") + 1).into();
        let result = if action.op == "transfer.cancel" {
            row["status"] = "CANCELLED".into();
            view(&row)
        } else {
            ensure(
                ctx.from["status"] == "ACTIVE"
                    && ctx.from["role"] == "OWNER"
                    && ctx.to["status"] == "ACTIVE"
                    && ctx.to["role"] != "OWNER"
                    && ctx.from["user_status"] == "ACTIVE"
                    && ctx.to["user_status"] == "ACTIVE",
                409,
                "VERSION_CONFLICT",
            )?;
            w.extend([
                self.member_guard(&ctx.from)?,
                self.member_guard(&ctx.to)?,
                self.a.s.guard(
                    "(SELECT count(*) FROM auth_user WHERE id IN (?,?) AND status='ACTIVE')=2",
                    vec![ctx.from["user_id"].clone(), ctx.to["user_id"].clone()],
                )?,
            ]);
            // The partial unique OWNER index requires demotion first; the D1 batch
            // is one transaction and its final guard requires exactly one owner.
            w.push(self.a.s.statement(
                "UPDATE auth_tenant_membership SET role='MEMBER',version=version+1 WHERE id=?",
                vec![ctx.from["id"].clone()],
            )?);
            w.push(self.a.s.statement(
                "UPDATE auth_tenant_membership SET role='OWNER',version=version+1 WHERE id=?",
                vec![ctx.to["id"].clone()],
            )?);
            w.push(self.a.s.statement("UPDATE auth_managed_tenant SET version=version+1,entitlement_revision=entitlement_revision+1,updated_at=? WHERE space_id=?",vec![n.into(),ctx.tenant["id"].clone()])?);
            w.push(self.a.s.guard("(SELECT count(*) FROM auth_tenant_membership WHERE tenant_id=? AND status='ACTIVE' AND role='OWNER')=1",vec![ctx.tenant["id"].clone()])?);
            let mut from = ctx.from.clone();
            from["role"] = "MEMBER".into();
            from["version"] = (number(&from, "version") + 1).into();
            let mut to = ctx.to.clone();
            to["role"] = "OWNER".into();
            to["version"] = (number(&to, "version") + 1).into();
            row["status"] = "ACCEPTED".into();
            json!({"transfer":view(&row),"previousOwner":member_view(&from),"owner":member_view(&to),"tenantVersion":number(&ctx.tenant,"version")+1})
        };
        w.push(self.a.s.statement("UPDATE auth_ownership_transfer SET status=?,version=version+1,resolved_at=? WHERE id=?",vec![row["status"].clone(),n.into(),row["id"].clone()])?);
        Ok(Change {
            result,
            writes: w,
            target_user: ctx.to["user_id"].clone(),
        })
    }
}
