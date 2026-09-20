use crate::{
    authorization::*,
    http::*,
    identity::Auth,
    security::{hash, secret, uuid},
};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Method};
pub struct Platform<'a> {
    a: &'a Auth,
    p: &'a Value,
}
impl<'a> Platform<'a> {
    pub fn new(a: &'a Auth, p: &'a Value) -> Result<Self> {
        ensure(p["platformAdmin"] == true, 403, "PLATFORM_ADMIN_REQUIRED")?;
        Ok(Self { a, p })
    }
    fn audit(
        &self,
        action: &str,
        app: Value,
        target: Value,
        summary: Value,
    ) -> Result<D1PreparedStatement> {
        self.a.s.statement("INSERT INTO auth_audit_event(id,action,outcome,actor_user_id,target_user_id,application_id,request_id,occurred_at,change_summary) VALUES (?,?,'SUCCESS',?,?,?,?,?,?)",vec![uuid().into(),action.into(),self.p["userId"].clone(),if target.is_null(){self.p["userId"].clone()}else{target},app,self.a.request_id.clone().into(),now().into(),summary])
    }
    async fn app(&self, id: &str) -> Result<Value> {
        let a = self
            .a
            .s
            .one("SELECT * FROM auth_application WHERE id=?", vec![id.into()])
            .await?;
        ensure(!a.is_null(), 404, "NOT_FOUND")?;
        Ok(a)
    }
    fn view(a: &Value) -> Result<Value> {
        Ok(
            json!({"id":a["id"],"name":a["name"],"status":a["status"],"version":a["version"],"actions":parsed(a,"actions")?}),
        )
    }
    async fn apps(&self) -> Result<Value> {
        let mut r = self
            .a
            .s
            .paginate(
                &self.a.request.url()?,
                "SELECT * FROM auth_application",
                vec![],
                "id",
            )
            .await?;
        for x in r["items"].as_array_mut().unwrap() {
            *x = Self::view(x)?;
        }
        Ok(r)
    }
    async fn application(&self, id: Option<&str>, b: &Value) -> Result<Value> {
        fields(
            b,
            if id.is_some() {
                &["name", "status", "actions", "version"]
            } else {
                &["name", "actions"]
            },
            &[],
        )?;
        ensure(
            b["actions"].as_array().is_some_and(|a| {
                a.len() <= 100
                    && a.iter()
                        .all(|v| CATALOG.contains(&v.as_str().unwrap_or_default()))
            }),
            400,
            "INVALID_REQUEST",
        )?;
        let n = name(&b["name"])?;
        let app = id.map(str::to_owned).unwrap_or_else(uuid);
        let writes = if let Some(id) = id {
            let old = self.app(id).await?;
            ensure(
                b["version"].is_i64()
                    && ["ACTIVE", "DISABLED"].contains(&text(b, "status").as_str()),
                400,
                "INVALID_REQUEST",
            )?;
            ensure(
                number(&old, "is_console") == 0 || b["status"] == "ACTIVE",
                403,
                "CONSOLE_PROTECTED",
            )?;
            vec![self.a.s.guard("EXISTS(SELECT 1 FROM auth_application WHERE id=? AND version=?)",vec![id.into(),b["version"].clone()])?,self.a.s.statement("UPDATE auth_application SET name=?,status=?,actions=?,version=version+1 WHERE id=?",vec![n.into(),b["status"].clone(),b["actions"].to_string().into(),id.into()])?,self.audit("platform.application.update",app.clone().into(),Value::Null,Value::Null)?]
        } else {
            vec![
                self.a.s.statement(
                    "INSERT INTO auth_application(id,name,actions) VALUES (?,?,?)",
                    vec![
                        app.clone().into(),
                        n.into(),
                        b["actions"].to_string().into(),
                    ],
                )?,
                self.audit(
                    "platform.application.create",
                    app.clone().into(),
                    Value::Null,
                    Value::Null,
                )?,
            ]
        };
        self.a.s.batch(writes, "VERSION_CONFLICT").await?;
        Self::view(&self.app(&app).await?)
    }
    async fn matrix(&self, id: &str) -> Result<Value> {
        let a = self.app(id).await?;
        let console = number(&a, "is_console") != 0;
        let actions = if console {
            json!(CAPABILITIES)
        } else {
            parsed(&a, "actions")?
        };
        let grants = parsed(&a, "grants")?;
        let mut app = Self::view(&a)?;
        app["actions"] = actions.clone();
        let roles:Vec<_>=ROLES.iter().map(|r|json!({"role":r,"actions":if a["status"]!="ACTIVE"{json!([])}else if console{json!(console_actions(r))}else{json!(actions.as_array().unwrap().iter().filter(|x|grants[format!("{r}:{}",x.as_str().unwrap())].as_bool().unwrap_or(default_grant(r,x.as_str().unwrap()))).collect::<Vec<_>>())}})).collect();
        Ok(json!({"console":console,"application":app,"roles":roles}))
    }
    async fn save_matrix(&self, id: &str, b: &Value) -> Result<Value> {
        fields(b, &["grants", "version"], &[])?;
        let a = self.app(id).await?;
        ensure(
            number(&a, "is_console") == 0,
            403,
            "BUILTIN_PERMISSIONS_READ_ONLY",
        )?;
        ensure(a["status"] == "ACTIVE", 409, "APPLICATION_DISABLED")?;
        let actions = parsed(&a, "actions")?;
        let valid: Vec<_> = ROLES
            .iter()
            .flat_map(|r| {
                actions
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(move |x| format!("{r}:{}", x.as_str().unwrap()))
            })
            .collect();
        ensure(
            b["version"].is_i64()
                && b["grants"].as_array().is_some_and(|g| {
                    g.len() <= 400
                        && g.iter()
                            .all(|x| x.as_str().is_some_and(|s| valid.iter().any(|v| v == s)))
                }),
            400,
            "INVALID_REQUEST",
        )?;
        let mut mapping = json!({});
        for key in valid {
            mapping[&key] = json!(contains(&b["grants"], &json!(key)));
        }
        self.a
            .s
            .batch(
                vec![
                    self.a.s.guard(
                        "EXISTS(SELECT 1 FROM auth_application WHERE id=? AND version=?)",
                        vec![id.into(), b["version"].clone()],
                    )?,
                    self.a.s.statement(
                        "UPDATE auth_application SET grants=?,version=version+1 WHERE id=?",
                        vec![mapping.to_string().into(), id.into()],
                    )?,
                    self.audit(
                        "platform.permissions.update",
                        id.into(),
                        Value::Null,
                        mapping.to_string().into(),
                    )?,
                ],
                "VERSION_CONFLICT",
            )
            .await?;
        Ok(json!({"saved":true,"version":number(b,"version")+1}))
    }
    async fn client(&self, id: &str) -> Result<Value> {
        let mut c=self.a.s.one("SELECT id,client_id clientId,application_id applicationId,client_type clientType,status,version,scopes,redirects FROM auth_client WHERE client_id=?",vec![id.into()]).await?;
        ensure(!c.is_null(), 404, "NOT_FOUND")?;
        c["scopes"] = parsed(&c, "scopes")?;
        c["redirects"] = parsed(&c, "redirects")?;
        Ok(c)
    }
    async fn clients(&self, app: &str) -> Result<Value> {
        self.app(app).await?;
        let mut r=self.a.s.paginate(&self.a.request.url()?,"SELECT id,client_id clientId,application_id applicationId,client_type clientType,status,version,scopes,redirects FROM auth_client WHERE application_id=?",vec![app.into()],"id").await?;
        for x in r["items"].as_array_mut().unwrap() {
            x["scopes"] = parsed(x, "scopes")?;
            x["redirects"] = parsed(x, "redirects")?;
        }
        Ok(r)
    }
    async fn save_client(&self, app: Option<&str>, id: Option<&str>, b: &Value) -> Result<Value> {
        fields(
            b,
            if id.is_some() {
                &["status", "scopes", "redirects", "version"]
            } else {
                &["clientId", "clientType", "scopes", "redirects"]
            },
            &[],
        )?;
        let old = if let Some(id) = id {
            self.client(id).await?
        } else {
            Value::Null
        };
        let client = id.map(str::to_owned).unwrap_or(text(b, "clientId"));
        let kind = if old.is_null() {
            text(b, "clientType")
        } else {
            text(&old, "clientType")
        };
        ensure(
            !client.is_empty()
                && client.len() <= 100
                && client.as_bytes()[0].is_ascii_alphanumeric()
                && client
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
                && !client.starts_with("svc_")
                && ["WEB", "MACOS", "CLI"].contains(&kind.as_str()),
            400,
            "INVALID_REQUEST",
        )?;
        ensure(
            b["scopes"].as_array().is_some_and(|s| {
                (1..=2).contains(&s.len()) && s.iter().all(|v| v == "account" || v == "profile")
            }),
            400,
            "INVALID_REQUEST",
        )?;
        ensure(
            b["redirects"]
                .as_array()
                .is_some_and(|r| (1..=20).contains(&r.len())),
            400,
            "INVALID_REQUEST",
        )?;
        for v in b["redirects"].as_array().unwrap() {
            let u = worker::Url::parse(string(v, 1024)?).map_err(|_| Failure {
                status: 400,
                code: "INVALID_REQUEST",
            })?;
            ensure(
                u.username().is_empty()
                    && u.password().is_none()
                    && u.fragment().is_none()
                    && !u.query_pairs().any(|(k, _)| k == "code" || k == "state"),
                400,
                "INVALID_REQUEST",
            )?;
            ensure(
                u.scheme() == "https"
                    || (u.scheme() == "http"
                        && ["127.0.0.1", "localhost", "[::1]"]
                            .contains(&u.host_str().unwrap_or_default()))
                    || (kind != "WEB" && u.scheme() == "molis"),
                400,
                "INVALID_REQUEST",
            )?;
        }
        let writes = if id.is_some() {
            ensure(
                b["version"].is_i64()
                    && ["ACTIVE", "DISABLED"].contains(&text(b, "status").as_str()),
                400,
                "INVALID_REQUEST",
            )?;
            if client == "molis-auth-console" {
                ensure(
                    b["status"] == "ACTIVE"
                        && contains(
                            &b["redirects"],
                            &json!(format!("{}/console/callback", self.a.origin)),
                        )
                        && contains(&b["scopes"], &json!("account")),
                    403,
                    "CONSOLE_PROTECTED",
                )?;
            }
            vec![self.a.s.guard("EXISTS(SELECT 1 FROM auth_client WHERE client_id=? AND version=?)",vec![client.clone().into(),b["version"].clone()])?,self.a.s.statement("UPDATE auth_client SET status=?,scopes=?,redirects=?,version=version+1 WHERE client_id=?",vec![b["status"].clone(),b["scopes"].to_string().into(),b["redirects"].to_string().into(),client.clone().into()])?,self.audit("platform.client.update",Value::Null,Value::Null,Value::Null)?]
        } else {
            let app = app.unwrap();
            self.app(app).await?;
            vec![self.a.s.statement("INSERT INTO auth_client(id,client_id,application_id,client_type,scopes,redirects) VALUES (?,?,?,?,?,?)",vec![uuid().into(),client.clone().into(),app.into(),kind.into(),b["scopes"].to_string().into(),b["redirects"].to_string().into()])?,self.audit("platform.client.create",app.into(),Value::Null,Value::Null)?]
        };
        self.a.s.batch(writes, "VERSION_CONFLICT").await?;
        self.client(&client).await
    }
    async fn users(&self, id: Option<&str>) -> Result<Value> {
        let sql = "SELECT u.id,u.display_name displayName,u.status,(SELECT json_group_array(canonical_email) FROM auth_user_email WHERE user_id=u.id) emails FROM auth_user u";
        if let Some(id) = id {
            let mut u = self
                .a
                .s
                .one(&format!("{sql} WHERE u.id=?"), vec![id.into()])
                .await?;
            ensure(!u.is_null(), 404, "NOT_FOUND")?;
            u["emails"] = parsed(&u, "emails")?;
            return Ok(u);
        }
        let mut r = self
            .a
            .s
            .paginate(&self.a.request.url()?, sql, vec![], "id")
            .await?;
        for x in r["items"].as_array_mut().unwrap() {
            x["emails"] = parsed(x, "emails")?;
        }
        Ok(r)
    }
    async fn user_status(&self, id: &str, b: &Value) -> Result<Value> {
        fields(b, &["status"], &[])?;
        ensure(
            ["ACTIVE", "DISABLED"].contains(&text(b, "status").as_str()),
            400,
            "INVALID_REQUEST",
        )?;
        ensure(self.p["userId"] != id, 403, "SELF_DISABLE_FORBIDDEN")?;
        ensure(
            !self.a.admins.split(',').any(|x| x.trim() == id),
            403,
            "ADMIN_PROTECTED",
        )?;
        self.users(Some(id)).await?;
        let mut writes = vec![self.a.s.statement(
            "UPDATE auth_user SET status=?,updated_at=? WHERE id=?",
            vec![b["status"].clone(), now().into(), id.into()],
        )?];
        if b["status"] == "DISABLED" {
            writes.push(self.a.s.statement(
                "UPDATE auth_authentication SET revoked_at=? WHERE user_id=?",
                vec![now().into(), id.into()],
            )?);
        }
        writes.push(self.audit("platform.user.status", Value::Null, id.into(), Value::Null)?);
        self.a.s.batch(writes, "VERSION_CONFLICT").await?;
        self.users(Some(id)).await
    }
    async fn services(&self, app: &str) -> Result<Value> {
        self.app(app).await?;
        self.a.s.paginate(&self.a.request.url()?,"SELECT id,client_id clientId,name,status,credential_id activeCredentialId FROM auth_service WHERE application_id=?",vec![app.into()],"id").await
    }
    async fn service(
        &self,
        app: Option<&str>,
        id: Option<&str>,
        b: &Value,
        disable: bool,
    ) -> Result<Value> {
        fields(b, if id.is_some() { &[] } else { &["name"] }, &[])?;
        let key = secret();
        let credential = uuid();
        let client = id
            .map(str::to_owned)
            .unwrap_or_else(|| format!("svc_{}", uuid()));
        let mut writes = vec![];
        if let Some(id) = id {
            ensure(
                !self
                    .a
                    .s
                    .one(
                        "SELECT id FROM auth_service WHERE client_id=?",
                        vec![id.into()],
                    )
                    .await?
                    .is_null(),
                404,
                "NOT_FOUND",
            )?;
            if !disable {
                writes.push(self.a.s.guard(
                    "EXISTS(SELECT 1 FROM auth_service WHERE client_id=? AND status='ACTIVE')",
                    vec![id.into()],
                )?);
            }
            writes.push(if disable{self.a.s.statement("UPDATE auth_service SET status='DISABLED' WHERE client_id=?",vec![id.into()])?}else{self.a.s.statement("UPDATE auth_service SET credential_id=?,secret_hash=? WHERE client_id=? AND status='ACTIVE'",vec![credential.into(),hash(&key).into(),id.into()])?});
            writes.push(self.audit(
                if disable {
                    "platform.service.disable"
                } else {
                    "platform.service.rotate"
                },
                Value::Null,
                Value::Null,
                Value::Null,
            )?);
        } else {
            let app = app.unwrap();
            self.app(app).await?;
            writes.extend([
                self.a.s.statement(
                    "INSERT INTO auth_service VALUES (?,?,?,?,'ACTIVE',?,?)",
                    vec![
                        uuid().into(),
                        client.clone().into(),
                        app.into(),
                        name(&b["name"])?.into(),
                        credential.into(),
                        hash(&key).into(),
                    ],
                )?,
                self.audit(
                    "platform.service.create",
                    app.into(),
                    Value::Null,
                    Value::Null,
                )?,
            ]);
        }
        self.a.s.batch(writes, "SERVICE_DISABLED").await?;
        Ok(if disable {
            json!({"disabled":true})
        } else {
            json!({"clientId":client,"secret":key})
        })
    }
    async fn audit_page(&self) -> Result<Value> {
        let mut r=self.a.s.paginate(&self.a.request.url()?,"SELECT id,action,outcome,actor_user_id actorUserId,target_user_id targetUserId,application_id applicationId,occurred_at occurredAt,request_id requestId,change_summary changeSummary FROM auth_audit_event",vec![],"occurredAt DESC,id DESC").await?;
        for x in r["items"].as_array_mut().unwrap() {
            x["occurredAt"] = iso(&x["occurredAt"]);
        }
        Ok(r)
    }
    pub async fn route(&self, path: &str, method: Method, b: &Value) -> Result<Value> {
        let parts: Vec<_> = path.trim_matches('/').split('/').collect();
        match (parts.as_slice(), method) {
            (["platform", "me"], Method::Get) => {
                Ok(json!({"userId":self.p["userId"],"platformAdministrator":true}))
            }
            (["platform", "permission-catalog"], Method::Get) => Ok(json!(CATALOG)),
            (["platform", "applications"], Method::Get) => self.apps().await,
            (["platform", "applications"], Method::Post) => self.application(None, b).await,
            (["platform", "applications", id], Method::Get) => Self::view(&self.app(id).await?),
            (["platform", "applications", id], Method::Put) => self.application(Some(id), b).await,
            (["platform", "applications", id, "permission-matrix"], Method::Get) => {
                self.matrix(id).await
            }
            (["platform", "applications", id, "permission-matrix"], Method::Put) => {
                self.save_matrix(id, b).await
            }
            (["platform", "applications", id, "clients"], Method::Get) => self.clients(id).await,
            (["platform", "applications", id, "clients"], Method::Post) => {
                self.save_client(Some(id), None, b).await
            }
            (["platform", "applications", id, "services"], Method::Get) => self.services(id).await,
            (["platform", "applications", id, "services"], Method::Post) => {
                self.service(Some(id), None, b, false).await
            }
            (["platform", "clients", id], Method::Get) => self.client(id).await,
            (["platform", "clients", id], Method::Put) => self.save_client(None, Some(id), b).await,
            (["platform", "users"], Method::Get) => self.users(None).await,
            (["platform", "users", id], Method::Get) => self.users(Some(id)).await,
            (["platform", "users", id, "status"], Method::Put) => self.user_status(id, b).await,
            (["platform", "services", id, "rotate"], Method::Post) => {
                self.service(None, Some(id), b, false).await
            }
            (["platform", "services", id, "disable"], Method::Post) => {
                self.service(None, Some(id), b, true).await
            }
            (["platform", "audit"], Method::Get) => self.audit_page().await,
            (["platform", "mail"], Method::Get) => Ok(json!({"items":[],"nextCursor":null})),
            (["platform", "mail", ..], Method::Post) => Err(Failure {
                status: 409,
                code: "EMAIL_FLOW_UNAVAILABLE",
            }),
            _ => Err(Failure {
                status: 404,
                code: "NOT_FOUND",
            }),
        }
    }
}
