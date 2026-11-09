//! Auth's same-origin V2 BFF. Only an opaque HttpOnly cookie crosses the browser boundary.
use crate::{
    http::*,
    identity::Auth,
    security::{hash, secret},
    sensitive_transactions::shape,
};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use worker::{Method, Request, RequestInit, Response};
#[wasm_bindgen(module = "/src/runtime/federation.js")]
extern "C" {
    #[wasm_bindgen(catch,js_name=authSeal)]
    async fn seal(key: &str, value: &str) -> std::result::Result<String, JsValue>;
    #[wasm_bindgen(catch,js_name=authOpen)]
    async fn open(key: &str, value: &str) -> std::result::Result<String, JsValue>;
}
fn unavailable(_: JsValue) -> Failure {
    Failure {
        status: 503,
        code: "AUTH_UNAVAILABLE",
    }
}
fn session_failure(failure: Failure) -> Failure {
    if failure.status == 401 {
        Failure {
            status: 401,
            code: "SESSION_EXPIRED",
        }
    } else {
        failure
    }
}
fn setting(a: &Auth, name: &str) -> Result<String> {
    let value = a
        .env
        .secret(name)
        .map(|v| v.to_string())
        .or_else(|_| a.env.var(name).map(|v| v.to_string()))
        .unwrap_or_default();
    ensure(!value.is_empty(), 503, "UNIFIED_CONFIGURATION_INVALID")?;
    Ok(value)
}
pub(crate) struct WebSession<'a> {
    pub a: &'a Auth,
    pub id: String,
    pub revision: i64,
    pub data: Value,
    key: String,
}
impl WebSession<'_> {
    pub fn client(&self) -> Result<String> {
        setting(self.a, "AUTH_WEB_CLIENT_ID")
    }
    pub async fn save(&self) -> Result<()> {
        ensure(
            self.data.to_string().len() <= 192000,
            400,
            "INVALID_REQUEST",
        )?;
        let payload = seal(
            &self.key,
            &json!({"id":self.id,"data":self.data}).to_string(),
        )
        .await
        .map_err(unavailable)?;
        self.a.s.batch(vec![self.a.s.guard("EXISTS(SELECT 1 FROM auth_web_session WHERE id_hash=? AND revision=? AND status='BUSY')",vec![self.id.clone().into(),self.revision.into()])?,self.a.s.statement("UPDATE auth_web_session SET payload=? WHERE id_hash=?",vec![payload.into(),self.id.clone().into()])?],"VERSION_CONFLICT").await
    }
    pub async fn call(
        &self,
        path: &str,
        method: Method,
        body: Option<Value>,
        proof: Option<&str>,
        key: Option<&str>,
    ) -> Result<Value> {
        ensure(
            path.starts_with("/api/v2/") && !path.contains('#') && !path.contains(".."),
            400,
            "INVALID_REQUEST",
        )?;
        let mut init = RequestInit::new();
        init.with_method(method);
        if let Some(body) = body {
            init.with_body(Some(body.to_string().into()));
        }
        let mut request = Request::new_with_init(&(self.a.origin.clone() + path), &init)?;
        let h = request.headers_mut()?;
        h.set("Content-Type", "application/json")?;
        if let Some(token) = self.data["tokens"]["accessToken"].as_str() {
            h.set("Authorization", &format!("Bearer {token}"))?;
        }
        if let Some(proof) = proof {
            h.set("X-Auth-Initiator-Proof", proof)?;
        }
        if let Some(key) = key {
            h.set("Idempotency-Key", key)?;
        }
        let mut response = crate::app::handle_internal(
            request,
            self.a.env.clone(),
            (self.id.clone(), self.revision),
        )
        .await?;
        let value: Value = response.json().await?;
        if response.status_code() >= 400 {
            // Return a bounded, declared code, never an upstream body or secret-bearing message.
            let code = text(&value["error"], "code");
            let known: [&'static str; 15] = [
                "INVALID_REQUEST",
                "INVALID_CREDENTIALS",
                "LOGIN_REQUIRED",
                "SESSION_EXPIRED",
                "SESSION_REVOKED",
                "FORBIDDEN",
                "VERSION_CONFLICT",
                "IDENTITY_IN_USE",
                "LAST_LOGIN_METHOD",
                "IDEMPOTENCY_CONFLICT",
                "RATE_LIMITED",
                "OWNER_TRANSFER_REQUIRED",
                "NOT_FOUND",
                "POLICY_MISMATCH",
                "CAPACITY_CONFLICT",
            ];
            return Err(Failure {
                status: response.status_code(),
                code: known
                    .into_iter()
                    .find(|v| *v == code)
                    .unwrap_or("AUTH_UNAVAILABLE"),
            });
        }
        Ok(value["data"].clone())
    }
    pub async fn fresh(&mut self) -> Result<()> {
        let expiry = self.data["tokens"]["accessExpiresAt"]
            .as_str()
            .map(js_sys::Date::parse)
            .unwrap_or(0.0);
        ensure(!self.data["tokens"].is_null(), 401, "LOGIN_REQUIRED")?;
        if expiry > now() as f64 + 30000.0 {
            return Ok(());
        }
        let old = self.data["tokens"].take();
        self.save().await?; // Burn recovery material before rotating.
        let tokens=self.call("/api/v2/auth/token",Method::Post,Some(json!({"grantType":"refresh_token","clientId":self.client()?,"refreshToken":old["refreshToken"]})),None,None).await.map_err(session_failure)?;
        shape("TokenSet", &tokens)?;
        ensure(
            tokens["session"]["loginSessionId"] == old["session"]["loginSessionId"],
            403,
            "FORBIDDEN",
        )?;
        self.data["tokens"] = tokens;
        Ok(())
    }
    pub async fn view(&mut self) -> Result<Value> {
        if self.data["tokens"].is_null() {
            return Ok(json!({"state":"ANONYMOUS"}));
        }
        self.fresh().await?;
        let me = self
            .call("/api/v2/users/me", Method::Get, None, None, None)
            .await
            .map_err(session_failure)?;
        self.data["user"] = me["user"].clone();
        Ok(
            json!({"state":"AUTHENTICATED","user":me["user"],"session":me["session"],"capabilities":me["platformCapabilities"]}),
        )
    }
}
fn csrf(key: &str, id: &str) -> String {
    hash(&format!("web-csrf:{key}:{id}"))
}
pub async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    ensure(
        a.header("Authorization").is_empty() && a.header("X-Auth-Initiator-Proof").is_empty(),
        400,
        "INVALID_REQUEST",
    )?;
    let request_url = a.request.url()?;
    if path != "/account/callback"
        && (path == "/api/account/session"
            || path.starts_with("/api/account/auth/")
            || path == "/api/account/reauthentications"
            || path.starts_with("/api/account/password/")
            || path.starts_with("/api/account/login-methods/"))
    {
        ensure(request_url.query().is_none(), 400, "INVALID_REQUEST")?;
    }
    if method == Method::Get {
        ensure(
            a.header("Transfer-Encoding").is_empty()
                && a.header("Content-Length").parse::<u64>().unwrap_or(0) == 0,
            400,
            "INVALID_REQUEST",
        )?;
    }
    let origin = a.header("Origin");
    let site = a.header("Sec-Fetch-Site");
    ensure(
        (origin.is_empty() || origin == a.origin)
            && (path == "/account/callback"
                || !matches!(site.as_str(), "cross-site" | "same-site")),
        403,
        "FORBIDDEN",
    )?;
    // The callback only confirms the Cookie-bound provider state. Adoption occurs in the original same-origin poll.
    if path == "/account/callback" {
        ensure(method == Method::Get, 403, "FORBIDDEN")?;
    }
    let key = setting(a, "AUTH_WEB_SESSION_KEY")?;
    ensure(token(&key), 503, "UNIFIED_CONFIGURATION_INVALID")?;
    let values: Vec<_> = a
        .header("Cookie")
        .split(';')
        .map(str::trim)
        .filter_map(|v| v.strip_prefix("molis-auth-web=").map(str::to_owned))
        .collect();
    ensure(values.len() <= 1, 401, "INVALID_CREDENTIALS")?;
    let mut cookie = values.first().cloned().unwrap_or_default();
    let mut row = if token(&cookie) {
        a.s.one(
            "SELECT * FROM auth_web_session WHERE id_hash=? AND expires_at>?",
            vec![hash(&cookie).into(), now().into()],
        )
        .await?
    } else {
        Value::Null
    };
    if row.is_null() {
        ensure(
            method == Method::Get && path == "/api/account/session",
            401,
            "LOGIN_REQUIRED",
        )?;
        cookie = secret();
        let id = hash(&cookie);
        let payload = seal(
            &key,
            &json!({"id":id,"data":{"transactions":{},"tokens":null}}).to_string(),
        )
        .await
        .map_err(unavailable)?;
        a.s.run("INSERT INTO auth_web_session(id_hash,payload,status,expires_at) VALUES (?,?,'READY',?)",vec![id.clone().into(),payload.into(),(now()+7776000000_i64).into()]).await?;
        row =
            a.s.one(
                "SELECT * FROM auth_web_session WHERE id_hash=?",
                vec![id.into()],
            )
            .await?;
    }
    let id = hash(&cookie);
    let revision = number(&row, "revision") + 1;
    let mut data: Value = serde_json::from_str(
        &open(&key, &text(&row, "payload"))
            .await
            .map_err(unavailable)?,
    )?;
    ensure(data["id"] == id, 401, "INVALID_CREDENTIALS")?;
    if method != Method::Get {
        ensure(
            origin == a.origin && a.header("X-CSRF-Token") == csrf(&key, &id),
            403,
            "FORBIDDEN",
        )?;
    }
    let mut body = if method != Method::Get {
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/json"),
            400,
            "INVALID_REQUEST",
        )?;
        serde_json::from_str(&crate::app::bounded(a, 220000).await?)?
    } else {
        json!({})
    };
    let logout = path == "/api/account/logout" && method == Method::Post;
    if logout {
        shape("ProductLogoutRequest", &body)?;
        ensure(
            (16..=128).contains(&a.header("Idempotency-Key").len()),
            400,
            "INVALID_REQUEST",
        )?;
    }
    ensure(logout || row["status"] == "READY", 409, "VERSION_CONFLICT")?;
    a.s.batch(
        vec![
            a.s.guard(
                "EXISTS(SELECT 1 FROM auth_web_session WHERE id_hash=? AND revision=?)",
                vec![id.clone().into(), row["revision"].clone()],
            )?,
            a.s.statement(
                "UPDATE auth_web_session SET status='BUSY',revision=revision+1 WHERE id_hash=?",
                vec![id.clone().into()],
            )?,
        ],
        "VERSION_CONFLICT",
    )
    .await?;
    let authenticated_before = !data["data"]["tokens"].is_null();
    let mut session = WebSession {
        a,
        id: id.clone(),
        revision,
        data: data["data"].take(),
        key: key.clone(),
    };
    let session_read = path == "/api/account/session" && method == Method::Get;
    let mut result = async { if session_read {
        session.view().await
    } else if logout {
        shape("ProductLogoutRequest", &body)?;
        let scope = text(&body, "scope");
        let saved = session.data["tokens"].take();
        session.data["transactions"] = json!({});
        session.save().await?;
        let key = a.header("Idempotency-Key");
        ensure((16..=128).contains(&key.len()), 400, "INVALID_REQUEST")?;
        let op = if scope == "ALL_MOLIS_PRODUCTS" {
            "/api/v2/sessions/logout-all"
        } else {
            "/api/v2/sessions/current/logout"
        };
        session.data["tokens"] = saved.clone();
        let revoked=session.call(op,Method::Post,Some(json!({"refreshProof":{"clientId":session.client()?,"refreshToken":saved["refreshToken"]}})),None,Some(&key)).await.is_ok();
        session.data["tokens"] = Value::Null;
        Ok(
            json!({"localCleared":true,"remoteRevocation":if revoked{"CONFIRMED"}else{"UNCONFIRMED"}}),
        )
    } else if path == "/api/account/reauthentications" || path.starts_with("/api/account/auth/") || path == "/api/account/password/reset" || path == "/api/account/password/change" || path.starts_with("/api/account/login-methods/") || path == "/account/callback" {
        crate::web_auth::route(&mut session, path, method, &mut body).await
    } else {
        management(&mut session, path, method, body).await
    } }.await;
    if result.as_ref().err().is_some_and(|failure| {
        matches!(
            failure.code,
            "SESSION_EXPIRED" | "SESSION_REVOKED" | "LOGIN_REQUIRED"
        )
    }) {
        // A rejected central session cannot keep blocking a fresh login behind stale recovery material.
        session.data["tokens"] = Value::Null;
        session.data["transactions"] = json!({});
        if session_read {
            result = Ok(json!({"state":"EXPIRED"}));
        }
    }
    let promote = !authenticated_before && !session.data["tokens"].is_null() && result.is_ok();
    if !authenticated_before && result.is_err() {
        // A failed login must never grant authority to its anonymous browser reference.
        session.data["tokens"] = Value::Null;
    }
    let mut browser_id = id.clone();
    let persisted = async {
        if !promote {
            return session.save().await;
        }
        cookie = secret();
        browser_id = hash(&cookie);
        let payload = seal(&key, &json!({"id":browser_id,"data":session.data}).to_string())
            .await.map_err(unavailable)?;
        // Rotate authority atomically: the anonymous reference never stores the authenticated payload.
        a.s.batch(vec![
            a.s.guard("EXISTS(SELECT 1 FROM auth_web_session WHERE id_hash=? AND revision=? AND status='BUSY')", vec![id.clone().into(), revision.into()])?,
            a.s.statement("INSERT INTO auth_web_session(id_hash,payload,status,expires_at) VALUES (?,?,'READY',?)", vec![browser_id.clone().into(),payload.into(),(now()+7776000000_i64).into()])?,
            a.s.statement("DELETE FROM auth_web_session WHERE id_hash=? AND revision=?", vec![id.clone().into(),revision.into()])?,
        ],"VERSION_CONFLICT").await
    }.await;
    let released = if promote && persisted.is_ok() {
        Ok(())
    } else {
        a.s.run(
            "UPDATE auth_web_session SET status='READY' WHERE id_hash=? AND revision=?",
            vec![id.clone().into(), revision.into()],
        )
        .await
    };
    persisted?;
    released?;
    let mut response = json_response(json!({"data":result?,"requestId":a.request_id}), 200)?;
    response
        .headers_mut()
        .set("X-CSRF-Token", &csrf(&key, &browser_id))?;
    response.headers_mut().append(
        "Set-Cookie",
        &format!(
            "molis-auth-web={cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000{}",
            if a.origin.starts_with("https:") {
                "; Secure"
            } else {
                ""
            }
        ),
    )?;
    Ok(response)
}
async fn management(
    s: &mut WebSession<'_>,
    path: &str,
    method: Method,
    body: Value,
) -> Result<Value> {
    s.fresh().await?;
    if path == "/api/account/activity" {
        shape("ActivityRequest", &body)?;
        return s
            .call(
                "/api/v2/sessions/current/activity",
                method,
                Some(body),
                None,
                None,
            )
            .await;
    }
    // Only declared noncredential product operations are forwarded. No user-selected URL or headers.
    let doc: Value = serde_json::from_str(include_str!(
        "../../../contracts/unified-account/openapi.json"
    ))
    .expect("contract");
    let url = s.a.request.url()?;
    for (template, operations) in doc["paths"].as_object().expect("paths") {
        if !template.starts_with("/api/account/") {
            continue;
        }
        let Some(declaration) = operations.get(method.to_string().to_lowercase()) else {
            continue;
        };
        let operation = text(declaration, "operationId");
        if !operation.starts_with("product_") {
            continue;
        }
        let parts: Vec<_> = path.split('/').collect();
        let pattern: Vec<_> = template.split('/').collect();
        if parts.len() != pattern.len()
            || !pattern
                .iter()
                .zip(&parts)
                .all(|(t, v)| t.starts_with('{') || t == v)
        {
            continue;
        }
        let suffix = path.strip_prefix("/api/account").expect("prefix");
        let central = if suffix.starts_with("/subscriptions") {
            format!("/users/me{suffix}")
        } else {
            suffix.into()
        };
        let mut target = format!("/api/v2{central}");
        if let Some(query) = url.query() {
            target.push('?');
            target.push_str(query);
        }
        let key = s.a.header("Idempotency-Key");
        return s
            .call(
                &target,
                method.clone(),
                if method == Method::Get {
                    None
                } else {
                    Some(body)
                },
                None,
                if key.is_empty() { None } else { Some(&key) },
            )
            .await;
    }
    if path == "/api/account/profile" && method == Method::Patch {
        return s
            .call(
                "/api/v2/users/me/profile",
                method,
                Some(body),
                None,
                Some(&s.a.header("Idempotency-Key")),
            )
            .await;
    }
    if path == "/api/account/login-methods" && method == Method::Get {
        return s
            .call("/api/v2/users/me/login-methods", method, None, None, None)
            .await;
    }
    Err(Failure {
        status: 404,
        code: "NOT_FOUND",
    })
}
