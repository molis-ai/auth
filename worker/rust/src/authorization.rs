use crate::{
    http::*,
    identity::Auth,
    security::{hash, uuid},
};
use serde_json::{Value, json};
pub const ROLES: &[&str] = &["OWNER", "ADMIN", "MEMBER", "VIEWER"];
pub const CATALOG: &[&str] = &[
    "space.read",
    "space.member.read",
    "role.read",
    "space.update",
    "space.archive",
    "space.restore",
    "project.read",
    "project.create",
    "project.update",
    "project.delete",
    "goal.read",
    "goal.advance",
    "goal.approve",
    "session.read",
    "session.manage",
    "feed.read",
    "feed.manage",
    "planning.read",
    "planning.update",
];
pub const CAPABILITIES: &[&str] = &[
    "team.read",
    "team.update",
    "members.read",
    "members.invite",
    "members.role",
    "members.remove",
    "invitations.read",
    "invitations.revoke",
    "audit.read",
    "team.archive",
    "team.leave",
];
pub fn console_actions(role: &str) -> Vec<&'static str> {
    CAPABILITIES
        .iter()
        .copied()
        .filter(|a| match *a {
            "team.leave" => role != "OWNER",
            "team.archive" => role == "OWNER",
            _ => ["team.read", "members.read"].contains(a) || ["OWNER", "ADMIN"].contains(&role),
        })
        .collect()
}
pub fn default_grant(role: &str, action: &str) -> bool {
    if !ROLES.contains(&role) || !CATALOG.contains(&action) {
        return false;
    }
    if ["space.archive", "space.restore"].contains(&action) {
        return role == "OWNER";
    }
    if action.ends_with(".read") {
        return true;
    }
    if [
        "space.update",
        "project.delete",
        "goal.approve",
        "feed.manage",
    ]
    .contains(&action)
    {
        return ["OWNER", "ADMIN"].contains(&role);
    }
    role != "VIEWER"
}
pub fn decision(
    role: &str,
    status: &str,
    kind: &str,
    action: &str,
    actions: &Value,
    grants: &Value,
) -> &'static str {
    if !CATALOG.contains(&action) {
        return "UNKNOWN_ACTION";
    }
    if !contains(actions, &json!(action)) {
        return "APPLICATION_ACTION_FORBIDDEN";
    }
    if role.is_empty() {
        return "NO_MEMBERSHIP";
    }
    if !grants[format!("{role}:{action}")]
        .as_bool()
        .unwrap_or(default_grant(role, action))
    {
        return "ROLE_FORBIDDEN";
    }
    if kind == "PERSONAL"
        && (role != "OWNER" || ["space.archive", "space.restore"].contains(&action))
    {
        return "PERSONAL_SPACE";
    }
    if status == "ARCHIVED" && !action.ends_with(".read") && action != "space.restore" {
        return "ARCHIVED_SPACE";
    }
    "NONE"
}
pub async fn authorize(a: &mut Auth, operation: &str, b: &Value) -> Result<Value> {
    ensure(a.header("Origin").is_empty(), 403, "ORIGIN_NOT_ALLOWED")?;
    let h = a.header("Authorization");
    let service = if h
        .get(..7)
        .is_some_and(|s| s.eq_ignore_ascii_case("Bearer "))
    {
        &h[7..]
    } else {
        &h
    };
    let user = a.header("X-User-Token");
    ensure(
        token(service) && token(&user),
        401,
        "SERVICE_UNAUTHENTICATED",
    )?;
    a.rate_ip("authorization-ip", 300).await?;
    let p = a.principal(Some(&user)).await?;
    ensure(
        contains(&p["scopes"], &json!("account")),
        403,
        "USER_SCOPE_REQUIRED",
    )?;
    let app=a.s.one("SELECT s.application_id,app.actions,app.grants FROM auth_service_token t JOIN auth_service s ON s.id=t.service_id JOIN auth_application app ON app.id=s.application_id WHERE t.token_hash=? AND t.expires_at>? AND t.credential_id=s.credential_id AND s.status='ACTIVE' AND app.status='ACTIVE'",vec![hash(service).into(),now().into()]).await?;
    ensure(!app.is_null(), 401, "SERVICE_UNAUTHENTICATED")?;
    ensure(
        app["application_id"] == p["applicationId"],
        403,
        "APPLICATION_MISMATCH",
    )?;
    let actions = parsed(&app, "actions")?;
    let grants = parsed(&app, "grants")?;
    let id = uuid();
    let mut space = Value::Null;
    let result = match operation {
        "activity" => {
            fields(b, &[], &[])?;
            a.s.batch(
                vec![a.s.statement(
                    "UPDATE auth_authentication SET activity_at=max(activity_at,?) WHERE id=?",
                    vec![now().into(), p["authenticationId"].clone()],
                )?],
                "VERSION_CONFLICT",
            )
            .await?;
            json!({"recorded":true,"decisionId":id})
        }
        "spaces" => {
            fields(b, &["action"], &["cursor", "limit"])?;
            let action = string(&b["action"], 100)?;
            let limit = b.get("limit").unwrap_or(&json!(50)).as_i64().unwrap_or(0);
            let cursor = string(b.get("cursor").unwrap_or(&json!("")), 1024)?.to_owned();
            ensure((1..=200).contains(&limit), 400, "INVALID_REQUEST")?;
            let mut clauses = vec![];
            let mut args = vec![p["userId"].clone(), cursor.into()];
            for role in ROLES {
                for status in ["ACTIVE", "ARCHIVED"] {
                    for kind in ["PERSONAL", "TEAM"] {
                        if decision(role, status, kind, action, &actions, &grants) == "NONE" {
                            clauses.push("(m.role=? AND s.status=? AND s.space_type=?)");
                            args.extend([json!(role), json!(status), json!(kind)]);
                        }
                    }
                }
            }
            let mut rows = if clauses.is_empty() {
                vec![]
            } else {
                args.push((limit + 1).into());
                a.s.all(&format!("SELECT s.id,s.name,s.space_type spaceType,s.status,m.role FROM auth_space s JOIN auth_membership m ON m.space_id=s.id WHERE m.user_id=? AND s.id>? AND ({}) ORDER BY s.id LIMIT ?",clauses.join(" OR ")),args).await?
            };
            let next = if rows.len() > limit as usize {
                rows[limit as usize - 1]["id"].clone()
            } else {
                Value::Null
            };
            rows.truncate(limit as usize);
            json!({"spaces":rows,"nextCursor":next,"decisionId":id})
        }
        "check" | "allowed-actions" => {
            fields(
                b,
                if operation == "check" {
                    &["spaceId", "action"]
                } else {
                    &["spaceId"]
                },
                if operation == "check" {
                    &["resourceType", "resourceId"]
                } else {
                    &[]
                },
            )?;
            let sid = string(&b["spaceId"], 36)?;
            ensure(
                sid.len() == 36
                    && sid.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
                    && b.get("resourceId").is_some() == b.get("resourceType").is_some(),
                400,
                "INVALID_REQUEST",
            )?;
            if let Some(v) = b.get("resourceId") {
                let r = string(v, 1024)?;
                ensure(r != user && r != service, 400, "INVALID_REQUEST")?;
            }
            space = sid.into();
            let row=a.s.one("SELECT s.status,s.space_type,m.role FROM auth_space s LEFT JOIN auth_membership m ON m.space_id=s.id AND m.user_id=? WHERE s.id=?",vec![p["userId"].clone(),space.clone()]).await?;
            if operation == "allowed-actions" {
                ensure(!text(&row, "role").is_empty(), 403, "NO_MEMBERSHIP")?;
                json!({"allowedActions":actions.as_array().unwrap().iter().filter(|x|decision(&text(&row,"role"),&text(&row,"status"),&text(&row,"space_type"),x.as_str().unwrap_or_default(),&actions,&grants)=="NONE").collect::<Vec<_>>(),"role":row["role"],"decisionId":id})
            } else {
                let reason = decision(
                    &text(&row, "role"),
                    &text(&row, "status"),
                    &text(&row, "space_type"),
                    string(&b["action"], 100)?,
                    &actions,
                    &grants,
                );
                json!({"allowed":reason=="NONE","reason":reason,"decisionId":id})
            }
        }
        _ => {
            return Err(Failure {
                status: 404,
                code: "NOT_FOUND",
            });
        }
    };
    a.s.db.batch(vec![a.s.statement("INSERT INTO auth_audit_event(id,action,outcome,actor_user_id,target_user_id,space_id,application_id,request_id,occurred_at,change_summary) VALUES (?,?,'SUCCESS',?,?,?,?,?,?,?)",vec![uuid().into(),format!("authorization.{operation}").into(),p["userId"].clone(),p["userId"].clone(),space,p["applicationId"].clone(),a.request_id.clone().into(),now().into(),result.to_string().into()])?]).await?;
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn viewer_cannot_write() {
        assert!(!default_grant("VIEWER", "project.update"));
        assert!(default_grant("VIEWER", "project.read"));
    }
    #[test]
    fn no_membership_is_never_granted() {
        assert_eq!(
            decision(
                "",
                "ACTIVE",
                "TEAM",
                "project.read",
                &json!(["project.read"]),
                &json!({})
            ),
            "NO_MEMBERSHIP"
        );
    }
    #[test]
    fn archived_is_read_only() {
        assert_eq!(
            decision(
                "OWNER",
                "ARCHIVED",
                "TEAM",
                "project.update",
                &json!(["project.update"]),
                &json!({})
            ),
            "ARCHIVED_SPACE"
        );
    }
    #[test]
    fn explicit_false_overrides_default() {
        assert_eq!(
            decision(
                "OWNER",
                "ACTIVE",
                "TEAM",
                "project.read",
                &json!(["project.read"]),
                &json!({"OWNER:project.read":false})
            ),
            "ROLE_FORBIDDEN"
        );
    }
}
