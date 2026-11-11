//! AUTH-07 managed tenants, membership roles, and platform authorization.
use crate::{
    http::*, identity::Auth, login_sessions, security::uuid, sensitive_transactions::shape,
    tenant_protocol as protocol,
};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Method, Response};
pub(crate) struct Service<'a> {
    pub a: &'a Auth,
    pub s: Value,
    pub c: Value,
}
pub(crate) struct Context {
    pub tenant: Value,
    pub member: Value,
    pub record: Value,
    pub from: Value,
    pub to: Value,
    pub permission: Value,
    pub guards: Vec<D1PreparedStatement>,
}
impl Context {
    pub(crate) fn new() -> Self {
        Self {
            tenant: Value::Null,
            member: Value::Null,
            record: Value::Null,
            from: Value::Null,
            to: Value::Null,
            permission: Value::Null,
            guards: vec![],
        }
    }
}
pub(crate) struct Action {
    pub op: &'static str,
    pub path: String,
    pub tenant_id: String,
    pub id: String,
    pub schema: Option<&'static str>,
}
pub(crate) struct Change {
    pub result: Value,
    pub writes: Vec<D1PreparedStatement>,
    pub target_user: Value,
}
impl Change {
    pub fn new(result: Value, writes: Vec<D1PreparedStatement>) -> Self {
        Self {
            result,
            writes,
            target_user: Value::Null,
        }
    }
}
pub(crate) fn member_view(m: &Value) -> Value {
    json!({"membershipId":m["id"],"tenantId":m["tenant_id"],"userId":m["user_id"],"role":m["role"],"status":m["status"],"version":m["version"]})
}
pub(crate) fn tenant_view(t: &Value) -> Value {
    json!({"tenantId":t["id"],"name":t["name"],"status":t["status"],"myRole":t["role"],"membershipId":t["membership_id"],"version":t["version"]})
}
pub(crate) fn platform_view(t: &Value) -> Value {
    json!({"tenantId":t["id"],"name":t["name"],"status":t["status"],"ownerUserId":t["owner_user_id"],"version":t["version"]})
}
pub(crate) fn expected(b: &Value, row: &Value) -> Result<()> {
    ensure(
        b["expectedVersion"] == row["version"],
        409,
        "VERSION_CONFLICT",
    )
}
pub(crate) const TENANTS: &str = "SELECT t.space_id id,s.name,t.status,t.version,t.entitlement_revision,(SELECT user_id FROM auth_tenant_membership m WHERE m.tenant_id=t.space_id AND m.status='ACTIVE' AND m.role='OWNER') owner_user_id,CAST(t.version AS TEXT) stamp FROM auth_managed_tenant t JOIN auth_space s ON s.id=t.space_id";
impl Service<'_> {
    pub fn user(&self) -> Value {
        self.s["user_id"].clone()
    }
    pub async fn tenant(&self, id: &str) -> Result<Value> {
        let t = self
            .a
            .s
            .one(&format!("{TENANTS} WHERE t.space_id=?"), vec![id.into()])
            .await?;
        ensure(!t.is_null(), 404, "NOT_FOUND")?;
        Ok(t)
    }
    pub async fn membership(&self, id: &str, tenant: &str) -> Result<Value> {
        let m=self.a.s.one("SELECT m.*,u.status user_status FROM auth_tenant_membership m JOIN auth_user u ON u.id=m.user_id WHERE m.id=? AND m.tenant_id=?",vec![id.into(),tenant.into()]).await?;
        ensure(!m.is_null(), 404, "NOT_FOUND")?;
        Ok(m)
    }
    pub fn tenant_guard(&self, t: &Value, active: bool) -> Result<D1PreparedStatement> {
        self.a.s.guard("EXISTS(SELECT 1 FROM auth_managed_tenant WHERE space_id=? AND version=? AND (?=0 OR status='ACTIVE'))",vec![t["id"].clone(),t["version"].clone(),active.into()])
    }
    pub fn member_guard(&self, m: &Value) -> Result<D1PreparedStatement> {
        self.a.s.guard("EXISTS(SELECT 1 FROM auth_tenant_membership WHERE id=? AND tenant_id=? AND user_id=? AND status='ACTIVE' AND role=? AND version=?)",vec![m["id"].clone(),m["tenant_id"].clone(),m["user_id"].clone(),m["role"].clone(),m["version"].clone()])
    }
    pub async fn member_context(&self, ctx: &mut Context, id: &str, roles: &[&str]) -> Result<()> {
        ctx.tenant = self.tenant(id).await?;
        ctx.member=self.a.s.one("SELECT * FROM auth_tenant_membership WHERE tenant_id=? AND user_id=? AND status='ACTIVE'",vec![id.into(),self.user()]).await?;
        ensure(!ctx.member.is_null(), 404, "NOT_FOUND")?;
        ensure(ctx.tenant["status"] == "ACTIVE", 403, "TENANT_DISABLED")?;
        ensure(
            roles.contains(&text(&ctx.member, "role").as_str()),
            403,
            "FORBIDDEN",
        )?;
        ctx.guards.extend([
            self.tenant_guard(&ctx.tenant, true)?,
            self.member_guard(&ctx.member)?,
        ]);
        Ok(())
    }
    pub fn record_guard(
        &self,
        table: &str,
        r: &Value,
        pending: bool,
    ) -> Result<D1PreparedStatement> {
        self.a.s.guard(
            &format!(
                "EXISTS(SELECT 1 FROM {table} WHERE id=? AND version=?{})",
                if pending {
                    " AND status='PENDING' AND expires_at>?"
                } else {
                    ""
                }
            ),
            {
                let mut v = vec![r["id"].clone(), r["version"].clone()];
                if pending {
                    v.push(now().into());
                }
                v
            },
        )
    }
    pub async fn platform_permission(&self, ctx: &mut Context, permission: &str) -> Result<()> {
        ctx.permission=self.a.s.one("SELECT * FROM auth_platform_permission WHERE user_id=? AND permission=? AND status='ACTIVE'",vec![self.user(),permission.into()]).await?;
        ensure(!ctx.permission.is_null(), 403, "FORBIDDEN")?;
        ctx.guards.push(self.a.s.guard("EXISTS(SELECT 1 FROM auth_platform_permission WHERE user_id=? AND permission=? AND status='ACTIVE' AND version=?)",vec![self.user(),permission.into(),ctx.permission["version"].clone()])?);
        Ok(())
    }
    pub async fn authorize(&self, action: &Action) -> Result<Context> {
        let mut ctx = Context::new();
        match action.op {
            "tenant.create"
            | "tenant.platform-list"
            | "tenant.platform-get"
            | "tenant.disable"
            | "tenant.enable" => {
                let permission = match action.op {
                    "tenant.create" => "TENANT_CREATE",
                    "tenant.disable" | "tenant.enable" => "TENANT_STATUS",
                    _ => "TENANT_READ",
                };
                self.platform_permission(&mut ctx, permission).await?;
                if !action.tenant_id.is_empty() {
                    ctx.tenant = self.tenant(&action.tenant_id).await?;
                    ctx.guards.push(self.tenant_guard(&ctx.tenant, false)?);
                }
            }
            "tenant.self-create" => {
                ensure(
                    crate::tenant_creation::policy(&self.a.env)? == "SELF_SERVICE",
                    403,
                    "FORBIDDEN",
                )?;
            }
            "tenant.creation-policy" | "tenant.list" | "invitation.list-mine" | "transfer.list" => {
            }
            "invitation.accept" | "invitation.decline" => {
                self.invitation_context(&mut ctx, &action.id).await?
            }
            "transfer.accept" | "transfer.cancel" => {
                self.transfer_context(&mut ctx, action).await?
            }
            _ => {
                let roles: &[&str] = match action.op {
                    "tenant.update"
                    | "invitation.create"
                    | "invitation.list-tenant"
                    | "invitation.revoke"
                    | "member.remove" => &["OWNER", "ADMIN"],
                    "member.role" | "transfer.create" => &["OWNER"],
                    _ => &["OWNER", "ADMIN", "MEMBER"],
                };
                self.member_context(&mut ctx, &action.tenant_id, roles)
                    .await?;
                if action.op == "member.role" || action.op == "member.remove" {
                    ctx.record = self.membership(&action.id, &action.tenant_id).await?;
                    if action.op == "member.role" {
                        ensure(ctx.record["status"] == "ACTIVE", 404, "NOT_FOUND")?;
                        ctx.guards.push(self.member_guard(&ctx.record)?);
                    } else {
                        // An ended target may be read only through a committed retry;
                        // new removals still require ACTIVE in the transition plan.
                        ensure(
                            ctx.member["role"] == "OWNER" || ctx.record["role"] == "MEMBER",
                            403,
                            "FORBIDDEN",
                        )?;
                        // Target guards are part of a new removal plan. A receipt
                        // may already describe its just-completed ACTIVE -> REMOVED.
                    }
                }
                if action.op == "invitation.revoke" {
                    ctx.record = self
                        .a
                        .s
                        .one(
                            "SELECT * FROM auth_tenant_invitation WHERE id=? AND tenant_id=?",
                            vec![action.id.clone().into(), action.tenant_id.clone().into()],
                        )
                        .await?;
                    ensure(!ctx.record.is_null(), 404, "NOT_FOUND")?;
                }
            }
        }
        Ok(ctx)
    }
    async fn read(&self, action: &Action, ctx: &mut Context) -> Result<Value> {
        match action.op {
            "tenant.creation-policy" => Ok(json!({"mode":crate::tenant_creation::policy(&self.a.env)?})),
            "tenant.get"=>{let mut t=ctx.tenant.clone();t["role"]=ctx.member["role"].clone();t["membership_id"]=ctx.member["id"].clone();Ok(tenant_view(&t))},
            "tenant.platform-get"=>Ok(platform_view(&ctx.tenant)),
            "tenant.platform-list"=>protocol::page(self,action,ctx,TENANTS,vec![],platform_view).await,
            "tenant.list"=>{
                let mut r=protocol::page(self,action,ctx,"SELECT t.space_id id,s.name,t.status,t.version,m.id membership_id,m.role,printf('%d:%d',t.version,m.version) stamp FROM auth_managed_tenant t JOIN auth_space s ON s.id=t.space_id JOIN auth_tenant_membership m ON m.tenant_id=t.space_id WHERE m.user_id=? AND m.status='ACTIVE'",vec![self.user()],tenant_view).await?;
                r["personalScope"]=json!({"kind":"PERSONAL"});Ok(r)
            }
            "member.list"=>protocol::page(self,action,ctx,"SELECT m.*,CAST(m.version AS TEXT) stamp FROM auth_tenant_membership m WHERE m.tenant_id=? AND m.status='ACTIVE'",vec![ctx.tenant["id"].clone()],member_view).await,
            "invitation.list-mine"|"invitation.list-tenant"=>self.invitation_list(action,ctx).await,
            "transfer.list"=>self.transfer_list(action,ctx).await,
            _=>Err(Failure{status:501,code:"UNIFIED_ACCOUNT_NOT_IMPLEMENTED"}),
        }
    }
    async fn change(&self, action: &Action, ctx: &Context, b: &Value) -> Result<Change> {
        match action.op {
            "tenant.create" | "tenant.self-create" => {
                // A self-service request cannot choose another account as owner.
                let owner_id = if action.op == "tenant.self-create" {
                    self.user()
                } else {
                    b["ownerUserId"].clone()
                };
                let owner = self
                    .a
                    .s
                    .one(
                        "SELECT id FROM auth_user WHERE id=? AND status='ACTIVE'",
                        vec![owner_id],
                    )
                    .await?;
                ensure(!owner.is_null(), 404, "NOT_FOUND")?;
                let id = uuid();
                let member = uuid();
                let n = now();
                let name = name(&b["name"]).map_err(|_| Failure {
                    status: 400,
                    code: "INVALID_REQUEST",
                })?;
                let mut result = json!({"id":id,"name":name,"status":"ACTIVE","version":0,"owner_user_id":owner["id"]});
                let writes=vec![self.a.s.guard("EXISTS(SELECT 1 FROM auth_user WHERE id=? AND status='ACTIVE')",vec![owner["id"].clone()])?,self.a.s.statement("INSERT INTO auth_space(id,name,space_type,status,created_at,updated_at) VALUES (?,?,'TEAM','ACTIVE',?,?)",vec![id.clone().into(),result["name"].clone(),n.into(),n.into()])?,self.a.s.statement("INSERT INTO auth_managed_tenant(space_id,status,managed_by,managed_at,updated_at) VALUES (?,'ACTIVE',?,?,?)",vec![id.clone().into(),self.user(),n.into(),n.into()])?,self.a.s.statement("INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at) VALUES (?,?,?,'OWNER','ACTIVE',?)",vec![member.clone().into(),id.into(),owner["id"].clone(),n.into()])?];
                result = if action.op == "tenant.self-create" {
                    result["role"] = "OWNER".into();
                    result["membership_id"] = member.into();
                    tenant_view(&result)
                } else {
                    platform_view(&result)
                };
                Ok(Change {
                    result,
                    writes,
                    target_user: owner["id"].clone(),
                })
            }
            "tenant.update" | "tenant.disable" | "tenant.enable" => {
                expected(b, &ctx.tenant)?;
                let mut t = ctx.tenant.clone();
                t["version"] = (number(&t, "version") + 1).into();
                let n = now();
                let mut w = vec![];
                if action.op == "tenant.update" {
                    t["name"] = name(&b["name"])
                        .map_err(|_| Failure {
                            status: 400,
                            code: "INVALID_REQUEST",
                        })?
                        .into();
                    w.push(self.a.s.statement(
                        "UPDATE auth_space SET name=?,updated_at=? WHERE id=?",
                        vec![t["name"].clone(), n.into(), t["id"].clone()],
                    )?);
                } else {
                    t["status"] = if action.op == "tenant.disable" {
                        "DISABLED"
                    } else {
                        "ACTIVE"
                    }
                    .into();
                }
                w.push(self.a.s.statement("UPDATE auth_managed_tenant SET status=?,version=version+1,entitlement_revision=entitlement_revision+1,updated_at=? WHERE space_id=?",vec![t["status"].clone(),n.into(),t["id"].clone()])?);
                t["role"] = ctx.member["role"].clone();
                t["membership_id"] = ctx.member["id"].clone();
                Ok(Change::new(
                    if action.op == "tenant.update" {
                        tenant_view(&t)
                    } else {
                        platform_view(&t)
                    },
                    w,
                ))
            }
            "member.role" => {
                expected(b, &ctx.record)?;
                ensure(
                    ctx.record["role"] != "OWNER",
                    409,
                    "OWNER_TRANSFER_REQUIRED",
                )?;
                let mut m = ctx.record.clone();
                m["role"] = b["role"].clone();
                m["version"] = (number(&m, "version") + 1).into();
                Ok(Change {
                    result: member_view(&m),
                    target_user: m["user_id"].clone(),
                    writes: vec![self.a.s.statement(
                        "UPDATE auth_tenant_membership SET role=?,version=version+1 WHERE id=?",
                        vec![m["role"].clone(), m["id"].clone()],
                    )?],
                })
            }
            "member.leave" | "member.remove" => {
                let plan = crate::tenant_membership::prepare_exit(self, action, ctx, b)?;
                let mut writes = plan.guards;
                writes.extend(plan.writes);
                Ok(Change {
                    target_user: plan.membership["userId"].clone(),
                    result: plan.membership,
                    writes,
                })
            }
            op if op.starts_with("invitation.") => self.invitation_change(action, ctx, b).await,
            op if op.starts_with("transfer.") => self.transfer_change(action, ctx, b).await,
            _ => Err(Failure {
                status: 501,
                code: "UNIFIED_ACCOUNT_NOT_IMPLEMENTED",
            }),
        }
    }
}
fn action(path: &str, method: Method) -> Result<Action> {
    let p: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let mut tenant = String::new();
    let mut id = String::new();
    let (op, schema) = match (&p[2..], method) {
        (["tenant-creation-policy"], Method::Get) => ("tenant.creation-policy", None),
        (["tenants"], Method::Post) => ("tenant.self-create", Some("SelfTenantCreateRequest")),
        (["tenants"], Method::Get) => ("tenant.list", None),
        (["platform", "tenants"], Method::Get) => ("tenant.platform-list", None),
        (["platform", "tenants"], Method::Post) => ("tenant.create", Some("TenantCreateRequest")),
        (["platform", "tenants", t], Method::Get) => {
            tenant = t.to_string();
            ("tenant.platform-get", None)
        }
        (["platform", "tenants", t, status @ ("disable" | "enable")], Method::Post) => {
            tenant = t.to_string();
            (
                if *status == "disable" {
                    "tenant.disable"
                } else {
                    "tenant.enable"
                },
                Some("PlatformVersionRequest"),
            )
        }
        (["tenants", t], Method::Get) => {
            tenant = t.to_string();
            ("tenant.get", None)
        }
        (["tenants", t], Method::Patch) => {
            tenant = t.to_string();
            ("tenant.update", Some("TenantUpdateRequest"))
        }
        (["tenants", t, "members"], Method::Get) => {
            tenant = t.to_string();
            ("member.list", None)
        }
        (["tenants", t, "members", m, "role"], Method::Patch) => {
            tenant = t.to_string();
            id = m.to_string();
            ("member.role", Some("RoleUpdateRequest"))
        }
        (["tenants", t, "members", m, "remove"], Method::Post) => {
            tenant = t.to_string();
            id = m.to_string();
            ("member.remove", Some("ExpectedVersionRequest"))
        }
        (["tenants", t, "leave"], Method::Post) => {
            tenant = t.to_string();
            ("member.leave", Some("ExpectedVersionRequest"))
        }
        (["tenants", t, "invitations"], Method::Post) => {
            tenant = t.to_string();
            ("invitation.create", Some("InvitationCreateRequest"))
        }
        (["tenants", t, "invitations"], Method::Get) => {
            tenant = t.to_string();
            ("invitation.list-tenant", None)
        }
        (["tenants", t, "invitations", i, "revoke"], Method::Post) => {
            tenant = t.to_string();
            id = i.to_string();
            ("invitation.revoke", Some("ExpectedVersionRequest"))
        }
        (["invitations"], Method::Get) => ("invitation.list-mine", None),
        (["invitations", i, op @ ("accept" | "decline")], Method::Post) => {
            id = i.to_string();
            (
                if *op == "accept" {
                    "invitation.accept"
                } else {
                    "invitation.decline"
                },
                Some("ExpectedVersionRequest"),
            )
        }
        (["tenants", t, "ownership-transfers"], Method::Post) => {
            tenant = t.to_string();
            ("transfer.create", Some("TransferCreateRequest"))
        }
        (["ownership-transfers"], Method::Get) => ("transfer.list", None),
        (["ownership-transfers", i, op @ ("accept" | "cancel")], Method::Post) => {
            id = i.to_string();
            (
                if *op == "accept" {
                    "transfer.accept"
                } else {
                    "transfer.cancel"
                },
                Some("ExpectedVersionRequest"),
            )
        }
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
        tenant_id: tenant,
        id,
        schema,
    })
}
pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    let (s, c) = login_sessions::active(a).await?;
    let action = action(path, method)?;
    let b = if let Some(schema) = action.schema {
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/json"),
            400,
            "INVALID_REQUEST",
        )?;
        let b = serde_json::from_str(&crate::app::bounded(a, 16384).await?)?;
        shape(schema, &b)?;
        if b.get("reason").is_some() {
            ensure(
                !text(&b, "reason").trim().is_empty(),
                400,
                "INVALID_REQUEST",
            )?;
        }
        b
    } else {
        json!({})
    };
    let mut service = Service { a, s, c };
    let result = if action.schema.is_none() {
        let mut ctx = service.authorize(&action).await?;
        let result = service.read(&action, &mut ctx).await?;
        let mut w = protocol::base(&service)?;
        w.extend(ctx.guards);
        a.s.batch(w, "VERSION_CONFLICT").await?;
        result
    } else {
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
            if action.op == "member.leave" {
                if let Some(result) =
                    crate::tenant_membership::replay_leave(&service, &action, &b, &key).await?
                {
                    output = Some(result);
                    break;
                }
            }
            let ctx = match service.authorize(&action).await {
                Ok(ctx) => ctx,
                Err(e) if action.op == "member.leave" && e.status == 404 => {
                    // Another same-key leave can finish between the receipt read and
                    // membership lookup. Re-read only its committed result.
                    if let Some(result) =
                        crate::tenant_membership::replay_leave(&service, &action, &b, &key).await?
                    {
                        output = Some(result);
                        break;
                    }
                    return Err(e);
                }
                Err(e) => return Err(e),
            };
            let replay = if action.op == "member.leave" {
                None
            } else {
                protocol::replay(&service, &action, &b, &key).await?
            };
            if let Some(result) = replay {
                let mut w = protocol::base(&service)?;
                w.extend(ctx.guards);
                a.s.batch(w, "VERSION_CONFLICT").await?;
                output = Some(result);
                break;
            }
            if attempt > 0 {
                break;
            }
            let attempt: Result<Value> = async {
                let change = service.change(&action, &ctx, &b).await?;
                let mut w = protocol::base(&service)?;
                w.extend(ctx.guards);
                w.extend(change.writes);
                let tenant = if ctx.tenant.is_null() {
                    change.result["tenantId"].clone()
                } else {
                    ctx.tenant["id"].clone()
                };
                w.push(a.s.audit(
                    action.op,
                    service.user(),
                    &a.request_id,
                    tenant,
                    change.target_user,
                    json!({"reason":b["reason"],"targetKind":b["target"]["kind"]}),
                    false,
                )?);
                w.extend(protocol::receipt(
                    &service,
                    &action,
                    &b,
                    &key,
                    &change.result,
                )?);
                a.s.batch(w, "VERSION_CONFLICT").await?;
                Ok(change.result)
            }
            .await;
            match attempt {
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
