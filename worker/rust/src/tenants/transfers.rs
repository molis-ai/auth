//! Ownership transfer swaps roles atomically and never changes seat assignments.
use crate::{
    http::*,
    security::uuid,
    tenants::protocol::{self, ACTOR, Read},
    tenants::{Action, Change, Context, Service, expected, member_view},
};
use serde_json::{Value, json};
fn view(r: &Value) -> Value {
    json!({"transferId":r["id"],"tenantId":r["tenant_id"],"fromMembershipId":r["from_membership_id"],"toMembershipId":r["to_membership_id"],"status":if r["status"]=="PENDING"&&number(r,"expires_at")<=now(){json!("EXPIRED")}else{r["status"].clone()},"expiresAt":iso(&r["expires_at"]),"version":r["version"]})
}
pub fn list() -> Read {
    Read::page(
        format!(
            "SELECT x.* FROM auth_tenant_membership f
                 JOIN auth_ownership_transfer x ON x.from_membership_id=f.id
                 JOIN auth_managed_tenant t ON t.space_id=x.tenant_id
                 WHERE t.status='ACTIVE' AND f.user_id={ACTOR} AND f.status='ACTIVE'
             UNION
             SELECT x.* FROM auth_tenant_membership m
                 JOIN auth_ownership_transfer x ON x.to_membership_id=m.id
                 JOIN auth_managed_tenant t ON t.space_id=x.tenant_id
                 WHERE t.status='ACTIVE' AND m.user_id={ACTOR} AND m.status='ACTIVE'"
        ),
        vec![],
        |row| Ok(view(row)),
    )
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

impl Service<'_> {
    pub(super) async fn platform_transfer_owner(
        &self,
        ctx: &Context,
        body: &Value,
    ) -> Result<Change> {
        expected(body, &ctx.tenant)?;
        let tenant = &ctx.tenant["id"];
        let previous = &ctx.tenant["owner_user_id"];
        let target = &body["newOwnerUserId"];
        ensure(target != previous, 409, "VERSION_CONFLICT")?;

        let member = |user: &Value| {
            self.a.s.one(
                "SELECT * FROM auth_tenant_membership WHERE tenant_id=? AND user_id=? AND status='ACTIVE'",
                vec![tenant.clone(), user.clone()],
            )
        };
        let owner = member(previous).await?;
        ensure(owner["role"] == "OWNER", 409, "VERSION_CONFLICT")?;
        let new_user = self
            .a
            .s
            .one(
                "SELECT id FROM auth_user WHERE id=? AND status='ACTIVE'",
                vec![target.clone()],
            )
            .await?;
        ensure(!new_user.is_null(), 404, "NOT_FOUND")?;
        let new_member = member(target).await?;
        let n = now();
        let mut writes = vec![
            self.member_guard(&owner)?,
            self.a.s.guard(
                "EXISTS(SELECT 1 FROM auth_user WHERE id=? AND status='ACTIVE')",
                vec![target.clone()],
            )?,
        ];
        if new_member.is_null() {
            writes.push(self.a.s.guard(
                "NOT EXISTS(SELECT 1 FROM auth_tenant_membership WHERE tenant_id=? AND user_id=? AND status='ACTIVE')",
                vec![tenant.clone(), target.clone()],
            )?);
        } else {
            writes.push(self.member_guard(&new_member)?);
        }
        writes.push(self.a.s.statement(
            "UPDATE auth_tenant_membership SET role='ADMIN',version=version+1 WHERE id=?",
            vec![owner["id"].clone()],
        )?);
        writes.push(if new_member.is_null() {
            self.a.s.statement(
                "INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at) VALUES (?,?,?,'OWNER','ACTIVE',?)",
                vec![uuid().into(), tenant.clone(), target.clone(), n.into()],
            )?
        } else {
            self.a.s.statement(
                "UPDATE auth_tenant_membership SET role='OWNER',version=version+1 WHERE id=?",
                vec![new_member["id"].clone()],
            )?
        });
        writes.push(self.a.s.statement(
            "UPDATE auth_ownership_transfer
             SET status=CASE WHEN expires_at<=? THEN 'EXPIRED' ELSE 'CANCELLED' END,
                 version=version+1,resolved_at=? WHERE tenant_id=? AND status='PENDING'",
            vec![n.into(), n.into(), tenant.clone()],
        )?);
        writes.push(self.a.s.statement(
            "UPDATE auth_managed_tenant SET version=version+1,entitlement_revision=entitlement_revision+1,updated_at=? WHERE space_id=?",
            vec![n.into(), tenant.clone()],
        )?);
        let mut updated = ctx.tenant.clone();
        updated["owner_user_id"] = target.clone();
        updated["version"] = (number(&updated, "version") + 1).into();
        Ok(Change {
            result: super::platform_view(&updated),
            writes,
            target_user: target.clone(),
        })
    }
}
