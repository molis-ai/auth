//! V2 application/client administration. Every commit rechecks the session and explicit permission.
use crate::{
    auth::login_sessions,
    auth::management_access::{self as protocol, Access, Lookup, Read},
    auth::management_access::{Action, Change, Context, Service},
    core::http::*,
    core::identity::Auth,
    core::security::uuid,
};
use serde_json::{Value, json};
use worker::{Method, Response};

pub fn matches(path: &str) -> bool {
    [
        "/api/v1/platform/applications",
        "/api/v1/platform/clients",
        "/api/v1/platform/users",
    ]
    .iter()
    .any(|p| path == *p || path.starts_with(&format!("{p}/")))
}
const APPLICATIONS: &str = "SELECT * FROM auth_application";
const CLIENTS: &str = "SELECT c.* FROM auth_client c";
fn application_view(v: &Value) -> Value {
    json!({"applicationId":v["id"],"name":v["name"],"status":v["status"],"version":v["version"]})
}
fn client_view(v: &Value) -> Result<Value> {
    let origins: Vec<String> = stored_json(v, "allowed_origins")?;
    let redirects: Vec<String> = stored_json(v, "redirects")?;
    Ok(
        json!({"clientId":v["client_id"],"applicationId":v["application_id"],"clientType":v["client_type"],"status":v["status"],"version":v["version"],"environmentId":v["environment_id"],"policyVersion":v["policy_version"],"allowedOrigins":origins,"redirectAllowlist":redirects}),
    )
}
fn action(path: &str, method: Method) -> Result<Action> {
    let p: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let mut id = String::new();
    let (op, schema) = match (&p[2..], method.clone()) {
        (["platform", "applications"], Method::Get) => ("application.list", None),
        (["platform", "applications"], Method::Post) => {
            ("application.create", Some("ApplicationCreateRequest"))
        }
        (["platform", "applications", v], Method::Get) => {
            id = (*v).into();
            ("application.get", None)
        }
        (["platform", "applications", v], Method::Patch) => {
            id = (*v).into();
            ("application.update", Some("ApplicationUpdateRequest"))
        }
        (["platform", "applications", v, "clients"], Method::Get) => {
            id = (*v).into();
            ("client.list", None)
        }
        (["platform", "applications", v, "clients"], Method::Post) => {
            id = (*v).into();
            ("client.create", Some("LoginClientCreateRequest"))
        }
        (["platform", "clients", v], Method::Get) => {
            id = (*v).into();
            ("client.get", None)
        }
        (["platform", "clients", v], Method::Patch) => {
            id = (*v).into();
            ("client.update", Some("LoginClientUpdateRequest"))
        }
        _ => return crate::platform::platform_accounts::action(path, method),
    };
    if !id.is_empty() {
        shape("Id", &json!(id))?;
    }
    Ok(Action {
        op,
        schema,
        path: path.into(),
        tenant_id: String::new(),
        id,
    })
}
impl Service<'_> {
    async fn administration_context(&self, action: &Action) -> Result<Context> {
        let mut ctx = Context::new();
        let permission = match action.op {
            "application.create" | "application.update" => "APPLICATION_WRITE",
            "client.create" | "client.update" => "CLIENT_WRITE",
            _ => crate::platform::platform_accounts::permission(action),
        };
        self.platform_permission(&mut ctx, permission).await?;
        if !action.op.starts_with("application.") && !action.op.starts_with("client.") {
            crate::platform::platform_accounts::context(self, action, &mut ctx).await?;
            return Ok(ctx);
        }
        if ["application.update", "client.create"].contains(&action.op) {
            ctx.record = self
                .a
                .s
                .one(
                    &format!("{APPLICATIONS} WHERE id=?"),
                    vec![action.id.clone().into()],
                )
                .await?;
            ensure(!ctx.record.is_null(), 404, "NOT_FOUND")?;
            ctx.guards.push(application_guard(self, &ctx.record)?);
        } else if action.op == "client.update" {
            ctx.record = self
                .a
                .s
                .one(
                    &format!("{CLIENTS} WHERE c.client_id=?"),
                    vec![action.id.clone().into()],
                )
                .await?;
            ensure(!ctx.record.is_null(), 404, "NOT_FOUND")?;
            ctx.guards.push(self.a.s.guard("EXISTS(SELECT 1 FROM auth_client c WHERE c.client_id=? AND c.version=? AND c.policy_version=?)",vec![ctx.record["client_id"].clone(),ctx.record["version"].clone(),ctx.record["policy_version"].clone()])?);
        }
        Ok(ctx)
    }
    async fn administration_change(
        &self,
        action: &Action,
        ctx: &Context,
        b: &Value,
    ) -> Result<Change> {
        if !action.op.starts_with("application.") && !action.op.starts_with("client.") {
            return crate::platform::platform_accounts::change(self, action, ctx, b).await;
        }
        if action.op.starts_with("application.") {
            let title = name(&b["name"]).map_err(|_| Failure {
                status: 400,
                code: "INVALID_REQUEST",
            })?;
            let mut row = ctx.record.clone();
            let writes = if action.op == "application.create" {
                row = json!({"id":uuid(),"name":title,"status":"ACTIVE","version":0});
                vec![self.a.s.statement(
                    "INSERT INTO auth_application(id,name) VALUES (?,?)",
                    vec![row["id"].clone(), row["name"].clone()],
                )?]
            } else {
                ensure(
                    b["expectedVersion"] == row["version"],
                    409,
                    "VERSION_CONFLICT",
                )?;
                ensure(
                    b["status"] != "DISABLED"
                        || (row["id"] != self.c["application_id"]
                            && number(&row, "is_console") == 0),
                    403,
                    "FORBIDDEN",
                )?;
                row["name"] = title.into();
                row["status"] = b["status"].clone();
                row["version"] = (number(&row, "version") + 1).into();
                vec![self.a.s.statement(
                    "UPDATE auth_application SET name=?,status=?,version=version+1 WHERE id=?",
                    vec![
                        row["name"].clone(),
                        row["status"].clone(),
                        row["id"].clone(),
                    ],
                )?]
            };
            return Ok(Change::new(application_view(&row), writes));
        }
        validate_redirects(b)?;
        let mut row = ctx.record.clone();
        let mut writes = vec![];
        if action.op == "client.create" {
            ensure(row["status"] == "ACTIVE", 403, "FORBIDDEN")?;
            let client = text(b, "clientId");
            ensure(!client.starts_with("svc_"), 400, "INVALID_REQUEST")?;
            let env = self
                .a
                .s
                .one(
                    "SELECT id,version FROM auth_environment WHERE id=? AND status='ACTIVE'",
                    vec![b["environmentId"].clone()],
                )
                .await?;
            ensure(!env.is_null(), 400, "INVALID_REQUEST")?;
            writes.push(self.a.s.guard("EXISTS(SELECT 1 FROM auth_environment WHERE id=? AND version=? AND status='ACTIVE')",vec![env["id"].clone(),env["version"].clone()])?);
            row = json!({"id":uuid(),"client_id":client,"application_id":action.id,"client_type":b["clientType"],"status":"ACTIVE","version":0,"environment_id":env["id"],"policy_version":0,"allowed_origins":b["allowedOrigins"].to_string(),"redirects":b["redirectAllowlist"].to_string()});
            writes.push(self.a.s.statement(
                "INSERT INTO auth_client(id,client_id,application_id,client_type,redirects,environment_id,allowed_origins)
                 VALUES (?,?,?,?,?,?,?)",
                ["id", "client_id", "application_id", "client_type", "redirects", "environment_id", "allowed_origins"]
                    .map(|field| row[field].clone()).to_vec(),
            )?);
        } else {
            ensure(
                b["expectedVersion"] == row["version"]
                    && b["expectedPolicyVersion"] == row["policy_version"],
                409,
                "VERSION_CONFLICT",
            )?;
            // Administration cannot lock out its own current client.
            ensure(row["client_id"] != self.c["client_id"], 403, "FORBIDDEN")?;
            row["status"] = b["status"].clone();
            row["redirects"] = b["redirectAllowlist"].to_string().into();
            row["allowed_origins"] = b["allowedOrigins"].to_string().into();
            row["version"] = (number(&row, "version") + 1).into();
            row["policy_version"] = (number(&row, "policy_version") + 1).into();
            writes.push(self.a.s.statement(
                "UPDATE auth_client SET status=?,redirects=?,allowed_origins=?,version=version+1,
                 policy_version=policy_version+1 WHERE client_id=?",
                ["status", "redirects", "allowed_origins", "client_id"].map(|field| row[field].clone()).to_vec(),
            )?);
        }
        Ok(Change::new(client_view(&row)?, writes))
    }
}
fn audit(
    service: &Service<'_>,
    action: &Action,
    ctx: &Context,
    body: &Value,
    after: &Value,
) -> Result<worker::D1PreparedStatement> {
    use crate::audit::{diff, success};
    let (kind, key, before, fields): (_, _, _, &[_]) = match action.op {
        "application.create" | "application.update" => (
            "APPLICATION",
            "applicationId",
            ctx.record.clone(),
            &["name", "status"],
        ),
        "client.create" | "client.update" => {
            let before = if action.op == "client.update" {
                client_view(&ctx.record)?
            } else {
                Value::Null
            };
            (
                "CLIENT",
                "clientId",
                before,
                &[
                    "applicationId",
                    "clientType",
                    "status",
                    "environmentId",
                    "product",
                    "allowedOrigins",
                    "redirectAllowlist",
                ],
            )
        }
        "permission.set" => {
            let before = json!({"capability":ctx.from["permission"],"status":ctx.from["status"]});
            ("USER", "userId", before, &["capability", "status"])
        }
        "user.status" => ("USER", "userId", ctx.record.clone(), &["status"]),
        "user.email" => ("USER", "userId", ctx.record.clone(), &["email"]),
        _ => return Err(Failure::unavailable()),
    };
    let mut changes = diff(&before, after, fields);
    if action.op == "permission.set" && before["capability"] == after["capability"] {
        changes.insert(
            0,
            json!({"field":"capability","before":before["capability"],"after":after["capability"]}),
        );
    }
    success(
        service,
        action,
        Value::Null,
        kind,
        &after[key],
        &body["reason"],
        json!({"changes": changes}),
    )
}

fn validate_redirects(b: &Value) -> Result<()> {
    for redirect in b["redirectAllowlist"]
        .as_array()
        .ok_or_else(Failure::invalid_request)?
    {
        let raw = redirect.as_str().ok_or_else(Failure::invalid_request)?;
        let url = worker::Url::parse(raw).map_err(|_| Failure {
            status: 400,
            code: "INVALID_REQUEST",
        })?;
        let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        ensure(
            url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && !raw.contains('*')
                && contains(
                    &b["allowedOrigins"],
                    &json!(url.origin().ascii_serialization()),
                )
                && (url.scheme() == "https" || (url.scheme() == "http" && local)),
            400,
            "INVALID_REQUEST",
        )?;
    }
    Ok(())
}

fn application_guard(s: &Service<'_>, row: &Value) -> Result<worker::D1PreparedStatement> {
    s.a.s.guard(
        "EXISTS(SELECT 1 FROM auth_application WHERE id=? AND version=?)",
        vec![row["id"].clone(), row["version"].clone()],
    )
}

async fn read(a: &Auth, action: &Action) -> Result<Value> {
    if action.op == "user.list" {
        return protocol::read(
            a,
            action,
            Access::Permission("USER_READ"),
            None,
            crate::platform::platform_accounts::user_page(a),
        )
        .await;
    }
    let application = || Lookup {
        sql: format!("{APPLICATIONS} WHERE id=?"),
        id: action.id.clone(),
    };
    let (permission, lookup, plan) = match action.op {
        "application.list" => (
            "APPLICATION_READ",
            None,
            Read::page(APPLICATIONS, vec![], |row| Ok(application_view(row))),
        ),
        "application.get" => (
            "APPLICATION_READ",
            Some(application()),
            Read::Detail(|ctx| Ok(application_view(&ctx.record))),
        ),
        "client.get" => (
            "CLIENT_READ",
            Some(Lookup {
                sql: format!("{CLIENTS} WHERE c.client_id=?"),
                id: action.id.clone(),
            }),
            Read::Detail(|ctx| client_view(&ctx.record)),
        ),
        "client.list" => (
            "CLIENT_READ",
            Some(application()),
            Read::page(
                format!("{CLIENTS} WHERE c.application_id=?"),
                vec![action.id.clone().into()],
                client_view,
            ),
        ),
        _ => crate::platform::platform_accounts::read(action),
    };
    protocol::read(a, action, Access::Permission(permission), lookup, Ok(plan)).await
}

pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    let action = action(path, method)?;
    let body = if let Some(schema) = action.schema {
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/json"),
            400,
            "INVALID_REQUEST",
        )?;
        let b: Value = serde_json::from_str(&bounded(&mut a.request, 16384).await?)?;
        shape(schema, &b)?;
        b
    } else {
        json!({})
    };
    let q = form(a.request.url()?.query().unwrap_or_default())?;
    fields(
        &q,
        &[],
        match action.op {
            "user.list" => &["limit", "cursor", "status", "q"],
            op if op.ends_with(".list") => &["limit", "cursor"],
            _ => &[],
        },
    )?;
    if action.schema.is_none() {
        let result = read(a, &action).await?;
        return Ok(json_response(
            json!({"data":result,"requestId":a.request_id}),
            200,
        )?);
    }
    let key = protocol::key(a)?;
    let mut output = None;
    let mut last = Failure {
        status: 409,
        code: "VERSION_CONFLICT",
    };
    for attempt in 0..2 {
        let (s, c) = login_sessions::active(a).await?;
        let service = Service { a, s, c };
        let ctx = service.administration_context(&action).await?;
        if let Some(result) = protocol::replay(&service, &action, &body, &key).await? {
            let mut w = protocol::base(&service)?;
            w.extend(ctx.guards);
            a.s.batch(w, "VERSION_CONFLICT").await?;
            output = Some(result);
            break;
        }
        if attempt > 0 {
            break;
        }
        let change = service.administration_change(&action, &ctx, &body).await?;
        let mut w = protocol::base(&service)?;
        let management_event = audit(&service, &action, &ctx, &body, &change.result)?;
        w.extend(ctx.guards);
        w.extend(change.writes);
        w.push(management_event);
        w.extend(protocol::receipt(
            &service,
            &action,
            &body,
            &key,
            &change.result,
        )?);
        match a.s.batch(w, "VERSION_CONFLICT").await {
            Ok(()) => {
                output = Some(change.result);
                break;
            }
            Err(e) => last = e,
        }
    }
    Ok(json_response(
        json!({"data":output.ok_or(last)?,"requestId":a.request_id}),
        200,
    )?)
}
