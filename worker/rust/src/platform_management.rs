//! V2 application/client administration. Every commit rechecks the session and explicit permission.
use crate::{
    http::*,
    identity::Auth,
    login_sessions,
    security::uuid,
    sensitive_transactions::shape,
    tenant_protocol as protocol,
    tenants::{Action, Change, Context, Service},
};
use serde_json::{Value, json};
use worker::{Method, Response};

pub fn matches(path: &str) -> bool {
    [
        "/api/v2/platform/applications",
        "/api/v2/platform/clients",
        "/api/v2/platform/users",
    ]
    .iter()
    .any(|p| path == *p || path.starts_with(&format!("{p}/")))
}
const APPLICATIONS: &str = "SELECT *,CAST(version AS TEXT) stamp FROM auth_application";
const CLIENTS: &str = "SELECT c.*,p.environment_id,p.allowed_origins,p.version policy_version,cp.product,printf('%d:%d',c.version,p.version) stamp FROM auth_client c JOIN auth_client_policy p ON p.client_id=c.client_id LEFT JOIN auth_client_product cp ON cp.client_id=c.client_id";
fn application_view(v: &Value) -> Value {
    json!({"applicationId":v["id"],"name":v["name"],"status":v["status"],"version":v["version"]})
}
fn client_view(v: &Value) -> Value {
    json!({"clientId":v["client_id"],"applicationId":v["application_id"],"clientType":v["client_type"],"status":v["status"],"version":v["version"],"environmentId":v["environment_id"],"policyVersion":v["policy_version"],"allowedOrigins":serde_json::from_str::<Value>(v["allowed_origins"].as_str().expect("stored origins")).expect("origin JSON"),"redirectAllowlist":serde_json::from_str::<Value>(v["redirects"].as_str().expect("stored redirects")).expect("redirect JSON"),"product":v["product"]})
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
        _ => return crate::platform_accounts::action(path, method),
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
            "application.list" | "application.get" => "APPLICATION_READ",
            "application.create" | "application.update" => "APPLICATION_WRITE",
            "client.list" | "client.get" => "CLIENT_READ",
            "client.create" | "client.update" => "CLIENT_WRITE",
            _ => crate::platform_accounts::permission(action),
        };
        self.platform_permission(&mut ctx, permission).await?;
        if !action.op.starts_with("application.") && !action.op.starts_with("client.") {
            crate::platform_accounts::context(self, action, &mut ctx).await?;
            return Ok(ctx);
        }
        if [
            "application.get",
            "application.update",
            "client.list",
            "client.create",
        ]
        .contains(&action.op)
        {
            ctx.record = self
                .a
                .s
                .one(
                    &format!("{APPLICATIONS} WHERE id=?"),
                    vec![action.id.clone().into()],
                )
                .await?;
            ensure(!ctx.record.is_null(), 404, "NOT_FOUND")?;
            ctx.guards.push(self.a.s.guard(
                "EXISTS(SELECT 1 FROM auth_application WHERE id=? AND version=?)",
                vec![ctx.record["id"].clone(), ctx.record["version"].clone()],
            )?);
        } else if ["client.get", "client.update"].contains(&action.op) {
            ctx.record = self
                .a
                .s
                .one(
                    &format!("{CLIENTS} WHERE c.client_id=?"),
                    vec![action.id.clone().into()],
                )
                .await?;
            ensure(!ctx.record.is_null(), 404, "NOT_FOUND")?;
            ctx.guards.push(self.a.s.guard("EXISTS(SELECT 1 FROM auth_client c JOIN auth_client_policy p ON p.client_id=c.client_id WHERE c.client_id=? AND c.version=? AND p.version=?)",vec![ctx.record["client_id"].clone(),ctx.record["version"].clone(),ctx.record["policy_version"].clone()])?);
        }
        Ok(ctx)
    }
    async fn administration_read(&self, action: &Action, ctx: &mut Context) -> Result<Value> {
        if !action.op.starts_with("application.") && !action.op.starts_with("client.") {
            return crate::platform_accounts::read(self, action, ctx).await;
        }
        match action.op {
            "application.list" => {
                protocol::page(self, action, ctx, APPLICATIONS, vec![], application_view).await
            }
            "application.get" => Ok(application_view(&ctx.record)),
            "client.get" => Ok(client_view(&ctx.record)),
            _ => {
                protocol::page(
                    self,
                    action,
                    ctx,
                    &format!("{CLIENTS} WHERE c.application_id=?"),
                    vec![action.id.clone().into()],
                    client_view,
                )
                .await
            }
        }
    }
    async fn administration_change(
        &self,
        action: &Action,
        ctx: &Context,
        b: &Value,
    ) -> Result<Change> {
        if !action.op.starts_with("application.") && !action.op.starts_with("client.") {
            return crate::platform_accounts::change(self, action, ctx, b).await;
        }
        let n = now();
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
            row = json!({"id":uuid(),"client_id":client,"application_id":action.id,"client_type":b["clientType"],"status":"ACTIVE","version":0,"environment_id":env["id"],"policy_version":0,"allowed_origins":b["allowedOrigins"].to_string(),"redirects":b["redirectAllowlist"].to_string(),"product":b["product"]});
            writes.push(self.a.s.statement("INSERT INTO auth_client(id,client_id,application_id,client_type,scopes,redirects) VALUES (?,?,?,?, '[\"account\",\"profile\"]',?)",vec![row["id"].clone(),row["client_id"].clone(),row["application_id"].clone(),row["client_type"].clone(),row["redirects"].clone()])?);
            writes.push(self.a.s.statement("INSERT INTO auth_client_policy(client_id,policy_profile,environment_id,allowed_origins,created_at,updated_at) VALUES (?,'unified-account-v2',?,?,?,?)",vec![row["client_id"].clone(),row["environment_id"].clone(),row["allowed_origins"].clone(),n.into(),n.into()])?);
            if !row["product"].is_null() {
                writes.push(self.a.s.statement(
                    "INSERT INTO auth_client_product(client_id,product) VALUES (?,?)",
                    vec![row["client_id"].clone(), row["product"].clone()],
                )?);
            }
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
                "UPDATE auth_client SET status=?,redirects=?,version=version+1 WHERE client_id=?",
                vec![
                    row["status"].clone(),
                    row["redirects"].clone(),
                    row["client_id"].clone(),
                ],
            )?);
            writes.push(self.a.s.statement("UPDATE auth_client_policy SET allowed_origins=?,version=version+1,updated_at=? WHERE client_id=?",vec![row["allowed_origins"].clone(),n.into(),row["client_id"].clone()])?);
        }
        Ok(Change::new(client_view(&row), writes))
    }
}
fn validate_redirects(b: &Value) -> Result<()> {
    for redirect in b["redirectAllowlist"]
        .as_array()
        .expect("validated redirects")
    {
        let raw = redirect.as_str().expect("validated URL");
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

pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    let action = action(path, method)?;
    let body = if let Some(schema) = action.schema {
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/json"),
            400,
            "INVALID_REQUEST",
        )?;
        let b: Value = serde_json::from_str(&crate::app::bounded(a, 16384).await?)?;
        shape(schema, &b)?;
        b
    } else {
        json!({})
    };
    let q = form(a.request.url()?.query().unwrap_or_default())?;
    fields(
        &q,
        &[],
        if action.op.ends_with(".list") {
            &["limit", "cursor"]
        } else {
            &[]
        },
    )?;
    let key = if action.schema.is_some() {
        Some(protocol::key(a)?)
    } else {
        None
    };
    let mut output = None;
    let mut last = Failure {
        status: 409,
        code: "VERSION_CONFLICT",
    };
    for attempt in 0..2 {
        let (s, c) = login_sessions::active(a).await?;
        let service = Service { a, s, c };
        let mut ctx = service.administration_context(&action).await?;
        if let Some(key) = &key {
            if let Some(result) = protocol::replay(&service, &action, &body, key).await? {
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
            w.extend(ctx.guards);
            w.extend(change.writes);
            let target = change.result["clientId"]
                .as_str()
                .or(change.result["applicationId"].as_str())
                .unwrap_or_default();
            w.push(a.s.audit(
                action.op,
                service.user(),
                &a.request_id,
                Value::Null,
                Value::Null,
                json!({"targetId":target,"reason":body["reason"]}),
                false,
            )?);
            w.extend(protocol::receipt(
                &service,
                &action,
                &body,
                key,
                &change.result,
            )?);
            match a.s.batch(w, "VERSION_CONFLICT").await {
                Ok(()) => {
                    output = Some(change.result);
                    break;
                }
                Err(e) => last = e,
            }
        } else {
            let result = service.administration_read(&action, &mut ctx).await?;
            let mut w = protocol::base(&service)?;
            w.extend(ctx.guards);
            a.s.batch(w, "VERSION_CONFLICT").await?;
            output = Some(result);
            break;
        }
    }
    Ok(json_response(
        json!({"data":output.ok_or(last)?,"requestId":a.request_id}),
        200,
    )?)
}
