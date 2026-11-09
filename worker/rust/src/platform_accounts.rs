//! V2 user availability and explicit platform grants.
use crate::{
    http::*,
    tenant_protocol as protocol,
    tenants::{Action, Change, Context, Service},
};
use serde_json::{Value, json};
use worker::Method;
const USERS: &str = "SELECT u.*,s.account_version version,CAST(s.account_version AS TEXT) stamp FROM auth_user u JOIN auth_user_security s ON s.user_id=u.id";
fn user_view(r: &Value) -> Value {
    json!({"userId":r["id"],"displayName":r["display_name"],"status":r["status"],"version":r["version"]})
}
fn permission_view(r: &Value) -> Value {
    json!({"userId":r["user_id"],"capability":r["permission"],"status":r["status"],"version":r["version"]})
}
pub fn action(path: &str, method: Method) -> Result<Action> {
    let p: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let mut id = String::new();
    let mut target = String::new();
    let (op, schema) = match (&p[2..], method) {
        (["platform", "users"], Method::Get) => ("user.list", None),
        (["platform", "users", u], Method::Get) => {
            id = (*u).into();
            ("user.get", None)
        }
        (["platform", "users", u, "status"], Method::Patch) => {
            id = (*u).into();
            ("user.status", Some("UserStatusRequest"))
        }
        (["platform", "users", u, "permissions"], Method::Get) => {
            id = (*u).into();
            ("permission.list", None)
        }
        (["platform", "users", u, "permissions", cap], Method::Patch) => {
            id = (*u).into();
            target = (*cap).into();
            crate::sensitive_transactions::shape("PlatformCapability", &json!(cap))?;
            ("permission.set", Some("PlatformPermissionRequest"))
        }
        _ => {
            return Err(Failure {
                status: 404,
                code: "NOT_FOUND",
            });
        }
    };
    if !id.is_empty() {
        crate::sensitive_transactions::shape("Id", &json!(id))?;
    }
    Ok(Action {
        op,
        schema,
        path: path.into(),
        tenant_id: target,
        id,
    })
}
pub fn permission(a: &Action) -> &'static str {
    match a.op {
        "user.list" | "user.get" => "USER_READ",
        "user.status" => "USER_STATUS",
        "permission.list" | "permission.set" => "PLATFORM_PERMISSION_WRITE",
        _ => unreachable!("only current user and permission operations reach this owner"),
    }
}
pub async fn context(s: &Service<'_>, a: &Action, c: &mut Context) -> Result<()> {
    if a.op == "user.list" {
        return Ok(());
    }
    if a.op.starts_with("user.") || a.op.starts_with("permission.") {
        c.record =
            s.a.s
                .one(&format!("{USERS} WHERE u.id=?"), vec![a.id.clone().into()])
                .await?;
        ensure(!c.record.is_null(), 404, "NOT_FOUND")?;
        c.guards.push(s.a.s.guard("EXISTS(SELECT 1 FROM auth_user u JOIN auth_user_security us ON us.user_id=u.id WHERE u.id=? AND u.status=? AND us.account_version=?)",vec![a.id.clone().into(),c.record["status"].clone(),c.record["version"].clone()])?);
        if a.op == "permission.set" {
            c.from =
                s.a.s
                    .one(
                        "SELECT * FROM auth_platform_permission WHERE user_id=? AND permission=?",
                        vec![a.id.clone().into(), a.tenant_id.clone().into()],
                    )
                    .await?;
        }
    }
    Ok(())
}
pub async fn read(s: &Service<'_>, a: &Action, c: &mut Context) -> Result<Value> {
    match a.op{
 "user.list"=>protocol::page(s,a,c,USERS,vec![],user_view).await,
 "user.get"=>Ok(user_view(&c.record)),
 "permission.list"=>protocol::page(s,a,c,"SELECT *,permission id,CAST(version AS TEXT) stamp FROM auth_platform_permission WHERE user_id=?",vec![a.id.clone().into()],permission_view).await,
 _=>unreachable!("only current user and permission reads reach this owner")}
}
pub async fn change(s: &Service<'_>, a: &Action, c: &Context, b: &Value) -> Result<Change> {
    let n = now();
    let mut row = c.record.clone();
    let mut w = vec![];
    if a.op == "user.status" {
        ensure(
            b["expectedVersion"] == row["version"],
            409,
            "VERSION_CONFLICT",
        )?;
        ensure(a.id != text(&s.s, "user_id"), 403, "FORBIDDEN")?;
        if b["status"] == "DISABLED" {
            w.push(s.a.s.guard("NOT EXISTS(SELECT 1 FROM auth_platform_permission WHERE user_id=? AND permission='PLATFORM_PERMISSION_WRITE' AND status='ACTIVE') OR EXISTS(SELECT 1 FROM auth_platform_permission p JOIN auth_user u ON u.id=p.user_id WHERE p.user_id<>? AND p.permission='PLATFORM_PERMISSION_WRITE' AND p.status='ACTIVE' AND u.status='ACTIVE')",vec![a.id.clone().into(),a.id.clone().into()])?);
            w.extend(crate::account_management::revoke_password(
                s.a, &a.id, None,
            )?);
        } else {
            w.push(s.a.s.statement("UPDATE auth_user_security SET account_version=account_version+1,updated_at=? WHERE user_id=?",vec![n.into(),a.id.clone().into()])?);
        }
        w.push(s.a.s.statement(
            "UPDATE auth_user SET status=?,updated_at=? WHERE id=?",
            vec![b["status"].clone(), n.into(), a.id.clone().into()],
        )?);
        row["status"] = b["status"].clone();
        row["version"] = (number(&row, "version") + 1).into();
        return Ok(Change::new(user_view(&row), w));
    }
    if a.op == "permission.set" {
        ensure(
            b["expectedVersion"] == c.from["version"],
            409,
            "VERSION_CONFLICT",
        )?;
        if c.from.is_null() {
            w.push(s.a.s.guard("NOT EXISTS(SELECT 1 FROM auth_platform_permission WHERE user_id=? AND permission=?)",vec![a.id.clone().into(),a.tenant_id.clone().into()])?);
        } else {
            w.push(s.a.s.guard("EXISTS(SELECT 1 FROM auth_platform_permission WHERE user_id=? AND permission=? AND version=?)",vec![a.id.clone().into(),a.tenant_id.clone().into(),c.from["version"].clone()])?);
        }
        if b["enabled"] == true {
            ensure(row["status"] == "ACTIVE", 403, "FORBIDDEN")?;
        }
        if a.tenant_id == "PLATFORM_PERMISSION_WRITE" && b["enabled"] == false {
            w.push(s.a.s.guard("EXISTS(SELECT 1 FROM auth_platform_permission p JOIN auth_user u ON u.id=p.user_id WHERE p.user_id<>? AND p.permission='PLATFORM_PERMISSION_WRITE' AND p.status='ACTIVE' AND u.status='ACTIVE')",vec![a.id.clone().into()])?);
        }
        let status = if b["enabled"] == true {
            "ACTIVE"
        } else {
            "REVOKED"
        };
        let version = if c.from.is_null() {
            0
        } else {
            number(&c.from, "version") + 1
        };
        w.push(s.a.s.statement("INSERT INTO auth_platform_permission(user_id,permission,status,granted_by,granted_at,revoked_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,permission) DO UPDATE SET status=excluded.status,granted_by=CASE WHEN excluded.status='ACTIVE' THEN excluded.granted_by ELSE auth_platform_permission.granted_by END,granted_at=CASE WHEN excluded.status='ACTIVE' THEN excluded.granted_at ELSE auth_platform_permission.granted_at END,revoked_at=excluded.revoked_at,version=auth_platform_permission.version+1",vec![a.id.clone().into(),a.tenant_id.clone().into(),status.into(),s.user(),n.into(),if status=="REVOKED"{n.into()}else{Value::Null}])?);
        return Ok(Change::new(
            json!({"userId":a.id,"capability":a.tenant_id,"status":status,"version":version}),
            w,
        ));
    }

    unreachable!("only current user and permission changes reach this owner")
}
