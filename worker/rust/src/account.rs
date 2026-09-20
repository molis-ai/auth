use crate::{http::*, identity::Auth, security::avatar};
use serde_json::{Value, json};
use worker::Method;

pub async fn route(
    a: &mut Auth,
    p: &Value,
    path: &str,
    method: Method,
    b: &Value,
) -> Result<Value> {
    let url = a.request.url()?;
    let user = p["userId"].clone();
    match (path, method.clone()) {
        ("/users/me", Method::Get) => a.me(p).await,
        ("/users/me/profile", Method::Post) => {
            fields(b, &["displayName", "avatarUrl"], &[])?;
            let n = name(&b["displayName"])?;
            let image = avatar(&b["avatarUrl"])?;
            a.s.batch(
                vec![
                    a.s.statement(
                        "UPDATE auth_user SET display_name=?,avatar_data=?,updated_at=? WHERE id=?",
                        vec![n.clone().into(), image.clone(), now().into(), user.clone()],
                    )?,
                    a.s.audit(
                        "account.profile.update",
                        user,
                        &a.request_id,
                        Value::Null,
                        Value::Null,
                        Value::Null,
                        false,
                    )?,
                ],
                "VERSION_CONFLICT",
            )
            .await?;
            let mut p = p.clone();
            p["displayName"] = n.into();
            p["avatarUrl"] = image;
            a.me(&p).await
        }
        ("/sessions/current/logout", Method::Post) | ("/sessions/logout-all", Method::Post) => {
            fields(b, &[], &[])?;
            a.logout(p, path.ends_with("logout-all")).await
        }
        ("/sessions/login-methods", Method::Get) => {
            let password =
                !a.s.one(
                    "SELECT user_id FROM auth_local_credential WHERE user_id=?",
                    vec![user.clone()],
                )
                .await?
                .is_null();
            let mut external =
                a.s.all(
                    "SELECT id,provider FROM auth_external_identity WHERE user_id=?",
                    vec![user.clone()],
                )
                .await?;
            let providers = crate::federation::providers(a);
            for x in &mut external {
                x["available"] =
                    json!(providers.contains(&text(x, "provider").to_lowercase().as_str()));
            }
            Ok(
                json!({"userId":user,"password":password,"availableProviders":providers,"external":external}),
            )
        }
        ("/sessions/authentications", Method::Get) => {
            let mut result=a.s.paginate(&url,"SELECT a.*,(SELECT count(*) FROM auth_grant WHERE authentication_id=a.id AND revoked_at IS NULL) applicationSessionCount FROM auth_authentication a WHERE a.user_id=?",vec![user],"created_at DESC,id DESC").await?;
            for x in result["items"].as_array_mut().unwrap() {
                let expiry = (number(x, "created_at") + 7776000000)
                    .min(number(x, "activity_at") + 2592000000);
                *x = json!({"id":x["id"],"current":x["id"]==p["authenticationId"],"authenticatedAt":iso(&x["created_at"]),"lastUserActivityAt":iso(&x["activity_at"]),"expiresAt":iso(&expiry.into()),"revokedAt":iso(&x["revoked_at"]),"status":if !x["revoked_at"].is_null(){"REVOKED"}else if expiry>now(){"ACTIVE"}else{"EXPIRED"},"applicationSessionCount":x["applicationSessionCount"]});
            }
            Ok(result)
        }
        ("/sessions/security-events", Method::Get) => {
            let mut result=a.s.paginate(&url,"SELECT id,action,outcome,occurred_at occurredAt,request_id requestId,application_id applicationId,NULL authorizationSessionId,NULL authenticationSessionId FROM auth_audit_event WHERE target_user_id=?",vec![user],"occurredAt DESC,id DESC").await?;
            for x in result["items"].as_array_mut().unwrap() {
                x["occurredAt"] = iso(&x["occurredAt"]);
            }
            Ok(result)
        }
        _ => {
            let parts: Vec<_> = path.trim_matches('/').split('/').collect();
            if method == Method::Post && parts.len() == 4 && parts[0] == "sessions" {
                fields(b, &[], &[])?;
                let id = parts[2];
                if parts[1] == "authentications" && parts[3] == "revoke" {
                    ensure(
                        !a.s.one(
                            "SELECT id FROM auth_authentication WHERE id=? AND user_id=?",
                            vec![id.into(), user.clone()],
                        )
                        .await?
                        .is_null(),
                        404,
                        "NOT_FOUND",
                    )?;
                    a.s.batch(vec![a.s.statement("UPDATE auth_authentication SET revoked_at=? WHERE id=? AND user_id=?",vec![now().into(),id.into(),user.clone()])?,a.s.audit("account.session.revoke",user,&a.request_id,Value::Null,Value::Null,Value::Null,false)?],"VERSION_CONFLICT").await?;
                    return Ok(json!({"revoked":true,"current":p["authenticationId"]==id}));
                }
                if parts[1] == "login-methods" && parts[3] == "unlink" {
                    ensure(
                        !a.s.one(
                            "SELECT id FROM auth_external_identity WHERE id=? AND user_id=?",
                            vec![id.into(), user.clone()],
                        )
                        .await?
                        .is_null(),
                        404,
                        "NOT_FOUND",
                    )?;
                    a.s.batch(vec![a.s.guard("EXISTS(SELECT 1 FROM auth_local_credential WHERE user_id=?) OR EXISTS(SELECT 1 FROM auth_external_identity WHERE user_id=? AND id<>?)",vec![user.clone(),user.clone(),id.into()])?,a.s.statement("DELETE FROM auth_external_identity WHERE id=? AND user_id=?",vec![id.into(),user.clone()])?,a.s.statement("UPDATE auth_authentication SET revoked_at=? WHERE user_id=?",vec![now().into(),user.clone()])?,a.s.audit("account.identity.unlink",user,&a.request_id,Value::Null,Value::Null,Value::Null,false)?],"LAST_LOGIN_METHOD").await?;
                    return Ok(json!({"unlinked":true,"loggedOut":true}));
                }
            }
            Err(Failure {
                status: 404,
                code: "NOT_FOUND",
            })
        }
    }
}
