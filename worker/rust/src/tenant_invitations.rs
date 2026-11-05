//! Directed invitations: possession of an id is never proof of recipient identity.
use crate::{
    http::*,
    security::uuid,
    tenant_protocol as protocol,
    tenants::{Action, Change, Context, Service, expected, member_view},
};
use serde_json::{Value, json};
pub(crate) const TARGET: &str = "((i.target_kind='USER' AND i.target_user_id=?) OR (i.target_kind='EMAIL' AND EXISTS(SELECT 1 FROM auth_user_email e WHERE e.user_id=? AND e.canonical_email=i.target_email AND e.verified_at IS NOT NULL)) OR (i.target_kind='PHONE' AND EXISTS(SELECT 1 FROM auth_user_phone p WHERE p.user_id=? AND p.canonical_phone=i.target_phone)))";
fn view(i: &Value) -> Value {
    let target = match text(i, "target_kind").as_str() {
        "EMAIL" => format!(
            "***@{}",
            text(i, "target_email").split('@').nth(1).unwrap_or("***")
        ),
        "PHONE" => format!(
            "+86 **** {}",
            text(i, "target_phone")
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>()
        ),
        _ => format!(
            "账号 …{}",
            text(i, "target_user_id")
                .chars()
                .rev()
                .take(6)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>()
        ),
    };
    json!({"invitationId":i["id"],"tenantId":i["tenant_id"],"targetSummary":target.chars().take(254).collect::<String>(),"status":if i["status"]=="PENDING"&&number(i,"expires_at")<=now(){json!("EXPIRED")}else{i["status"].clone()},"expiresAt":iso(&i["expires_at"]),"version":i["version"]})
}
impl Service<'_> {
    pub async fn invitation_context(&self, ctx: &mut Context, id: &str) -> Result<()> {
        let args = vec![id.into(), self.user(), self.user(), self.user()];
        ctx.record = self
            .a
            .s
            .one(
                &format!("SELECT i.* FROM auth_tenant_invitation i WHERE i.id=? AND {TARGET}"),
                args.clone(),
            )
            .await?;
        ensure(!ctx.record.is_null(), 404, "NOT_FOUND")?;
        ctx.tenant = self.tenant(&text(&ctx.record, "tenant_id")).await?;
        ensure(ctx.tenant["status"] == "ACTIVE", 403, "TENANT_DISABLED")?;
        ctx.guards.extend([
            self.tenant_guard(&ctx.tenant, true)?,
            self.a.s.guard(
                &format!(
                    "EXISTS(SELECT 1 FROM auth_tenant_invitation i WHERE i.id=? AND {TARGET})"
                ),
                args,
            )?,
        ]);
        Ok(())
    }
    pub async fn invitation_list(&self, action: &Action, ctx: &mut Context) -> Result<Value> {
        if action.op == "invitation.list-tenant" {
            protocol::page(self,action,ctx,"SELECT i.*,CAST(i.version AS TEXT) stamp FROM auth_tenant_invitation i WHERE i.tenant_id=?",vec![ctx.tenant["id"].clone()],view).await
        } else {
            protocol::page(self,action,ctx,&format!("SELECT i.*,printf('%d:%d',i.version,t.version) stamp FROM auth_tenant_invitation i JOIN auth_managed_tenant t ON t.space_id=i.tenant_id WHERE t.status='ACTIVE' AND i.status='PENDING' AND i.expires_at>{} AND {TARGET}",now()),vec![self.user(),self.user(),self.user()],view).await
        }
    }
    pub async fn invitation_change(
        &self,
        action: &Action,
        ctx: &Context,
        b: &Value,
    ) -> Result<Change> {
        let n = now();
        if action.op == "invitation.create" {
            self.a.rate_ip("v2-tenant-invite", 60).await?;
            let target = &b["target"];
            let kind = text(target, "kind");
            let value = if kind == "EMAIL" {
                email(&target["value"])?
            } else {
                text(target, "value")
            };
            let id = uuid();
            let expires = n + protocol::ttl("invitationTtlSeconds");
            let row = json!({"id":id,"tenant_id":ctx.tenant["id"],"target_kind":kind,"target_email":if kind=="EMAIL"{json!(value)}else{Value::Null},"target_phone":if kind=="PHONE"{json!(value)}else{Value::Null},"target_user_id":if kind=="USER"{json!(value)}else{Value::Null},"status":"PENDING","version":0,"expires_at":expires});
            let mut w = vec![];
            if kind == "USER" {
                ensure(
                    !self
                        .a
                        .s
                        .one(
                            "SELECT id FROM auth_user WHERE id=? AND status='ACTIVE'",
                            vec![value.clone().into()],
                        )
                        .await?
                        .is_null(),
                    404,
                    "NOT_FOUND",
                )?;
                w.push(self.a.s.guard(
                    "EXISTS(SELECT 1 FROM auth_user WHERE id=? AND status='ACTIVE')",
                    vec![value.clone().into()],
                )?);
            }
            w.push(self.a.s.statement("INSERT INTO auth_tenant_invitation(id,tenant_id,target_kind,target_email,target_phone,target_user_id,inviter_membership_id,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,'PENDING',?,?)",vec![id.clone().into(),ctx.tenant["id"].clone(),row["target_kind"].clone(),row["target_email"].clone(),row["target_phone"].clone(),row["target_user_id"].clone(),ctx.member["id"].clone(),n.into(),expires.into()])?);
            if kind != "USER" {
                w.push(crate::delivery::invitation_notification(self.a,&self.c,if kind=="EMAIL"{"EMAIL"}else{"SMS"},&value,&json!({"invitationId":id,"tenantName":ctx.tenant["name"],"expiresAt":iso(&json!(expires))}),expires)?);
            }
            return Ok(Change::new(view(&row), w));
        }
        let mut row = ctx.record.clone();
        expected(b, &row)?;
        ensure(
            row["status"] == "PENDING" && number(&row, "expires_at") > n,
            409,
            "VERSION_CONFLICT",
        )?;
        let mut w = vec![self.record_guard("auth_tenant_invitation", &row, true)?];
        let mut membership = Value::Null;
        if action.op == "invitation.accept" {
            membership=self.a.s.one("SELECT * FROM auth_tenant_membership WHERE tenant_id=? AND user_id=? AND status='ACTIVE'",vec![row["tenant_id"].clone(),self.user()]).await?;
            if membership.is_null() {
                let id = uuid();
                // Keep optimistic versions distinct across membership incarnations so
                // a stale leave request cannot target a newly joined membership.
                let version = number(&self.a.s.one("SELECT COALESCE(MAX(version)+1,0) AS version FROM auth_tenant_membership WHERE tenant_id=? AND user_id=?",vec![row["tenant_id"].clone(),self.user()]).await?, "version");
                membership = json!({"id":id,"tenant_id":row["tenant_id"],"user_id":self.user(),"role":"MEMBER","status":"ACTIVE","version":version});
                w.push(self.a.s.guard("NOT EXISTS(SELECT 1 FROM auth_tenant_membership WHERE tenant_id=? AND user_id=? AND status='ACTIVE')",vec![row["tenant_id"].clone(),self.user()])?);
                w.push(self.a.s.guard("(SELECT COALESCE(MAX(version)+1,0) FROM auth_tenant_membership WHERE tenant_id=? AND user_id=?)=?",vec![row["tenant_id"].clone(),self.user(),version.into()])?);
                w.push(self.a.s.statement("INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,version,joined_at) VALUES (?,?,?,'MEMBER','ACTIVE',?,?)",vec![id.into(),row["tenant_id"].clone(),self.user(),version.into(),n.into()])?);
                w.push(self.a.s.statement("UPDATE auth_managed_tenant SET entitlement_revision=entitlement_revision+1,updated_at=? WHERE space_id=?",vec![n.into(),row["tenant_id"].clone()])?);
            } else {
                w.push(self.member_guard(&membership)?);
            }
            row["status"] = "ACCEPTED".into();
        } else {
            row["status"] = if action.op == "invitation.decline" {
                "DECLINED"
            } else {
                "REVOKED"
            }
            .into();
        }
        row["version"] = (number(&row, "version") + 1).into();
        w.push(self.a.s.statement("UPDATE auth_tenant_invitation SET status=?,accepted_membership_id=?,resolved_at=?,version=version+1 WHERE id=?",vec![row["status"].clone(),membership["id"].clone(),n.into(),row["id"].clone()])?);
        Ok(Change {
            result: if action.op == "invitation.accept" {
                json!({"invitation":view(&row),"membership":member_view(&membership)})
            } else {
                view(&row)
            },
            writes: w,
            target_user: if action.op == "invitation.revoke" {
                Value::Null
            } else {
                self.user()
            },
        })
    }
}
