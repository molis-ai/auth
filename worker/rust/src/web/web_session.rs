//! Auth's same-origin V2 BFF. Only an opaque HttpOnly cookie crosses the browser boundary.
use crate::{
    http::*,
    identity::Auth,
    security::{hash, secret},
    store::WebSessionAccess,
};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use worker::{Method, Request, RequestInit, Response};

static PRODUCT_ROUTES: &[(Method, &str)] = include!(concat!(env!("OUT_DIR"), "/product_routes.rs"));
const BUSY_LEASE_MS: i64 = 30_000;
const SESSION_MAX_AGE_MS: i64 = 7_776_000_000;

#[wasm_bindgen(module = "/src/runtime/federation.js")]
extern "C" {
    #[wasm_bindgen(catch,js_name=authSeal)]
    pub(crate) async fn seal(key: &str, value: &str) -> std::result::Result<String, JsValue>;
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
fn v2_failure(status: u16, code: &str) -> Failure {
    // Only forward declared codes, never an upstream body or secret-bearing message.
    let known = [
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
    Failure {
        status,
        code: known
            .into_iter()
            .find(|known| *known == code)
            .unwrap_or("AUTH_UNAVAILABLE"),
    }
}
fn should_clear(result: &Result<Value>) -> bool {
    result.as_ref().err().is_some_and(|failure| {
        matches!(
            failure.code,
            "SESSION_EXPIRED" | "SESSION_REVOKED" | "LOGIN_REQUIRED"
        )
    })
}
fn anonymous_data() -> Value {
    json!({"transactions":{},"tokens":null})
}
async fn decode(key: &str, id: &str, payload: &str) -> Result<Value> {
    let mut value: Value = serde_json::from_str(&open(key, payload).await.map_err(unavailable)?)?;
    ensure(value["id"] == id, 401, "INVALID_CREDENTIALS")?;
    Ok(value["data"].take())
}
pub(crate) fn browser_cookie_hash(a: &Auth, cookie: &str) -> String {
    match a.env.var("MOLIS_LOCAL_GENERATION") {
        Ok(generation) => hash(&format!("{generation}:{cookie}")),
        Err(_) => hash(cookie),
    }
}
pub(crate) fn setting(a: &Auth, name: &str) -> Result<String> {
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
    pub data: Value,
    id: String,
    revision: i64,
    key: String,
    read_only: bool,
}
impl WebSession<'_> {
    pub fn client(&self) -> Result<String> {
        setting(self.a, "AUTH_WEB_CLIENT_ID")
    }
    async fn payload(&self) -> Result<String> {
        ensure(
            self.data.to_string().len() <= 192000,
            400,
            "INVALID_REQUEST",
        )?;
        seal(
            &self.key,
            &json!({"id":self.id,"data":self.data}).to_string(),
        )
        .await
        .map_err(unavailable)
    }
    pub async fn save(&self) -> Result<()> {
        ensure(!self.read_only, 503, "AUTH_UNAVAILABLE")?;
        let payload = self.payload().await?;
        self.a.s.batch(vec![self.a.s.guard("EXISTS(SELECT 1 FROM auth_web_session WHERE id_hash=? AND revision=? AND status='BUSY')",vec![self.id.clone().into(),self.revision.into()])?,self.a.s.statement("UPDATE auth_web_session SET payload=? WHERE id_hash=?",vec![payload.into(),self.id.clone().into()])?],"VERSION_CONFLICT").await
    }
    async fn finish(&self) -> Result<()> {
        let row = self.a.s.one(
            "UPDATE auth_web_session SET payload=?,status='READY',busy_until=0 WHERE id_hash=? AND revision=? AND status='BUSY' RETURNING revision",
            vec![self.payload().await?.into(), self.id.clone().into(), self.revision.into()],
        ).await?;
        ensure(!row.is_null(), 409, "VERSION_CONFLICT")
    }
    async fn promote(&self, browser_id: &str) -> Result<()> {
        let payload = seal(
            &self.key,
            &json!({"id":browser_id,"data":self.data}).to_string(),
        )
        .await
        .map_err(unavailable)?;
        let s = &self.a.s;
        // Rotate authority atomically: the anonymous reference never stores the authenticated payload.
        s.batch(
            vec![
                s.guard(
                    "EXISTS(SELECT 1 FROM auth_web_session WHERE id_hash=? AND revision=? AND status='BUSY')",
                    vec![self.id.clone().into(), self.revision.into()],
                )?,
                s.statement(
                    "INSERT INTO auth_web_session(id_hash,payload,status,expires_at) VALUES (?,?,'READY',?)",
                    vec![browser_id.into(), payload.into(), (now() + SESSION_MAX_AGE_MS).into()],
                )?,
                s.statement(
                    "DELETE FROM auth_web_session WHERE id_hash=? AND revision=?",
                    vec![self.id.clone().into(), self.revision.into()],
                )?,
            ],
            "VERSION_CONFLICT",
        )
        .await
    }
    async fn logout(&mut self, body: &Value) -> Result<Value> {
        let saved = self.data["tokens"].take();
        self.data["transactions"] = json!({});
        self.data["loginVerification"] = Value::Null;
        self.save().await?;
        let path = if body["scope"] == "ALL_MOLIS_PRODUCTS" {
            "/api/v2/sessions/logout-all"
        } else {
            "/api/v2/sessions/current/logout"
        };
        // Logout uses the saved refresh proof; bearer plus refresh proof is rejected.
        let revoked = self
            .call(
                path,
                Method::Post,
                Some(json!({"refreshProof":{"clientId":self.client()?,"refreshToken":saved["refreshToken"]}})),
                None,
                Some(&self.a.header("Idempotency-Key")),
            )
            .await
            .is_ok();
        Ok(
            json!({"localCleared":true,"remoteRevocation":if revoked {"CONFIRMED"} else {"UNCONFIRMED"}}),
        )
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
            !self.read_only || method == Method::Get,
            503,
            "AUTH_UNAVAILABLE",
        )?;
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
        let access = if self.read_only {
            WebSessionAccess::ReadSnapshot(self.id.clone(), self.revision)
        } else {
            WebSessionAccess::Lease(self.id.clone(), self.revision)
        };
        let (mut response, retry_after_at) = crate::app::handle_internal(
            request,
            self.a.env.clone(),
            access,
            self.a.client_ip.clone(),
            self.a.request_id.clone(),
        )
        .await?;
        let value: Value = response.json().await?;
        let status = response.status_code();
        if status == 429 {
            self.a.retry_after_at.set(retry_after_at);
        }
        if status >= 400 {
            return Err(v2_failure(status, &text(&value["error"], "code")));
        }
        Ok(value["data"].clone())
    }
    fn access_is_fresh(&self) -> bool {
        self.data["tokens"]["accessExpiresAt"]
            .as_str()
            .map(js_sys::Date::parse)
            .is_some_and(|expiry| expiry > now() as f64 + 30_000.0)
    }
    pub async fn fresh(&mut self) -> Result<()> {
        ensure(!self.data["tokens"].is_null(), 401, "LOGIN_REQUIRED")?;
        if self.access_is_fresh() {
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
        if !self.data["tokens"].is_null() {
            self.fresh().await?;
        }
        self.account_view().await
    }
    async fn account_view(&self) -> Result<Value> {
        if self.data["tokens"].is_null() {
            return Ok(json!({"state":"ANONYMOUS"}));
        }
        let me = crate::account_management::web_account_view(
            self.a,
            self.data["tokens"]["accessToken"].as_str().unwrap_or(""),
        )
        .await
        .map_err(|failure| v2_failure(failure.status, failure.code))
        .map_err(session_failure)?;
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
    // Only the browser-bound callback completes provider authorization; status polling is read-only.
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
    let mut id = browser_cookie_hash(a, &cookie);
    let mut create = !token(&cookie);
    let session_read = path == "/api/account/session" && method == Method::Get;
    let capabilities = path == "/api/account/auth/capabilities" && method == Method::Get;
    let mut observed_revision = None;
    let mut rejected_read = None;
    let can_read_without_lease =
        method == Method::Get && a.request.inner().method() == "GET" && read_without_lease(path);
    if !create && can_read_without_lease {
        let loaded_at = now();
        let row = a.s.one(
            "SELECT revision,status,busy_until,payload FROM auth_web_session WHERE id_hash=? AND expires_at>?",
            vec![id.clone().into(), loaded_at.into()],
        ).await?;
        create = row.is_null();
        if !create {
            let revision = number(&row, "revision");
            observed_revision = Some(revision);
            if row["status"] == "READY" {
                let session = WebSession {
                    a,
                    data: decode(&key, &id, &text(&row, "payload")).await?,
                    id: id.clone(),
                    revision,
                    key: key.clone(),
                    read_only: true,
                };
                // Capabilities never use access credentials. Anonymous session status
                // is also available without a token or a browser-session write.
                if capabilities
                    || (session_read && session.data["tokens"].is_null())
                    || (session.access_is_fresh()
                        && session.data["tokens"]["accessToken"]
                            .as_str()
                            .is_some_and(token))
                {
                    let result = if session_read {
                        session.account_view().await
                    } else if capabilities {
                        crate::web::web_auth::capabilities(&session).await
                    } else {
                        management(&session, path, Method::Get, json!({})).await
                    };
                    if !should_clear(&result) {
                        return browser_response(a, path, &key, &id, None, result);
                    }
                    rejected_read = Some(result);
                }
            } else if number(&row, "busy_until") > loaded_at {
                a.retry_browser_read = true;
                return Err(version_conflict());
            }
        }
    }
    ensure(
        !create || session_read || capabilities,
        401,
        "LOGIN_REQUIRED",
    )?;
    let logout = path == "/api/account/logout" && method == Method::Post;
    let body = write_input(a, &key, &id, method.clone(), logout).await;
    if body.is_err() {
        // Retain the missing-session response for invalid writes without
        // checking existence on the normal, single-statement claim.
        ensure(session_exists(a, &id).await?, 401, "LOGIN_REQUIRED")?;
    }
    let mut body = body?;
    let (revision, stored_payload) = if create {
        cookie = secret();
        id = browser_cookie_hash(a, &cookie);
        let payload = seal(&key, &json!({"id":id,"data":anonymous_data()}).to_string())
            .await
            .map_err(unavailable)?;
        let claimed_at = now();
        a.s.run(
            "INSERT INTO auth_web_session(id_hash,payload,revision,status,expires_at,busy_until) VALUES (?,?,0,'BUSY',?,?)",
            vec![id.clone().into(), payload.into(), (claimed_at + SESSION_MAX_AGE_MS).into(), (claimed_at + BUSY_LEASE_MS).into()],
        ).await?;
        (0, None)
    } else {
        let claimed = claim(a, &id, observed_revision, logout)
            .await
            .inspect_err(|failure| {
                // Only a predispatch conflict is safe to retry. A page that
                // already reached the backend may have attempted to issue a cursor.
                a.retry_browser_read =
                    can_read_without_lease && rejected_read.is_none() && failure.status == 409;
            })?;
        (
            number(&claimed, "revision"),
            Some(text(&claimed, "payload")),
        )
    };

    let mut browser_id = id.clone();
    let mut set_cookie = create;
    let completed: Result<Result<Value>> = async {
        let data = if let Some(payload) = stored_payload {
            decode(&key, &id, &payload).await?
        } else {
            anonymous_data()
        };
        let authenticated_before = !data["tokens"].is_null();
        let mut session = WebSession {
            a,
            id: id.clone(),
            revision,
            data,
            key: key.clone(),
            read_only: false,
        };
        let mut result = if let Some(rejection) = rejected_read {
            rejection
        } else if session_read {
            session.view().await
        } else if logout {
            session.logout(&body).await
        } else if path == "/api/account/reauthentications"
            || path.starts_with("/api/account/auth/")
            || path == "/api/account/password/reset"
            || path == "/api/account/password/change"
            || path.starts_with("/api/account/login-methods/")
            || path == "/account/callback"
        {
            crate::web::web_auth::route(&mut session, path, method, &mut body).await
        } else {
            match session.fresh().await {
                Ok(()) => management(&session, path, method, body).await,
                Err(failure) => Err(failure),
            }
        };
        if should_clear(&result) {
            // A rejected central session cannot keep blocking a fresh login behind stale recovery material.
            session.data["tokens"] = Value::Null;
            session.data["transactions"] = json!({});
            session.data["loginVerification"] = Value::Null;
            if session_read {
                result = Ok(json!({"state":"EXPIRED"}));
            }
        }
        let promote = !authenticated_before && !session.data["tokens"].is_null() && result.is_ok();
        if !authenticated_before && result.is_err() {
            // A failed login must never grant authority to its anonymous browser reference.
            session.data["tokens"] = Value::Null;
        }
        if promote {
            cookie = secret();
            browser_id = browser_cookie_hash(a, &cookie);
            session.promote(&browser_id).await?;
            set_cookie = true;
        } else {
            session.finish().await?;
        }
        Ok(result)
    }
    .await;
    if completed.is_err() {
        let released = a.s.one(
            "UPDATE auth_web_session SET status='READY',busy_until=0 WHERE id_hash=? AND revision=? AND status='BUSY' RETURNING revision",
            vec![id.clone().into(), revision.into()],
        ).await?;
        ensure(!released.is_null(), 409, "VERSION_CONFLICT")?;
    }
    browser_response(
        a,
        path,
        &key,
        &browser_id,
        set_cookie.then_some(cookie.as_str()),
        completed?,
    )
}

async fn write_input(
    a: &mut Auth,
    key: &str,
    id: &str,
    method: Method,
    logout: bool,
) -> Result<Value> {
    if method == Method::Get {
        return Ok(json!({}));
    }
    ensure(
        a.header("Origin") == a.origin && a.header("X-CSRF-Token") == csrf(key, id),
        403,
        "FORBIDDEN",
    )?;
    ensure(
        a.header("Content-Type").split(';').next() == Some("application/json"),
        400,
        "INVALID_REQUEST",
    )?;
    let body = serde_json::from_str(&crate::app::bounded(a, 220000).await?)?;
    if logout {
        shape("ProductLogoutRequest", &body)?;
        ensure(
            (16..=128).contains(&a.header("Idempotency-Key").len()),
            400,
            "INVALID_REQUEST",
        )?;
    }
    Ok(body)
}

async fn session_exists(a: &Auth, id: &str) -> Result<bool> {
    let row =
        a.s.one(
            "SELECT 1 FROM auth_web_session WHERE id_hash=? AND expires_at>?",
            vec![id.into(), now().into()],
        )
        .await?;
    Ok(!row.is_null())
}

async fn claim(a: &Auth, id: &str, expected_revision: Option<i64>, logout: bool) -> Result<Value> {
    let claimed_at = now();
    let expected = json!(expected_revision);
    let claimed =
        a.s.one(
            "UPDATE auth_web_session SET revision=revision+1,status='BUSY',busy_until=?
         WHERE id_hash=? AND expires_at>? AND (? IS NULL OR revision=?)
           AND (status='READY' OR (status='BUSY' AND busy_until<=?) OR ?=1)
         RETURNING revision,payload",
            vec![
                (claimed_at + BUSY_LEASE_MS).into(),
                id.into(),
                claimed_at.into(),
                expected.clone(),
                expected,
                claimed_at.into(),
                logout.into(),
            ],
        )
        .await?;
    if claimed.is_null() {
        ensure(
            expected_revision.is_some() || session_exists(a, id).await?,
            401,
            "LOGIN_REQUIRED",
        )?;
        return Err(version_conflict());
    }
    Ok(claimed)
}

fn version_conflict() -> Failure {
    Failure {
        status: 409,
        code: "VERSION_CONFLICT",
    }
}

fn browser_response(
    a: &Auth,
    path: &str,
    key: &str,
    browser_id: &str,
    cookie: Option<&str>,
    result: Result<Value>,
) -> Result<Response> {
    let mut response = if path == "/account/callback" {
        let (message, status) = match &result {
            Ok(value) if value["status"] == "CONSUMED" => (
                "授权已完成，请返回原页面继续。此窗口将由原页面自动关闭。",
                200,
            ),
            Ok(_) => ("授权已取消，请返回原页面重试。", 200),
            Err(failure) => (
                "暂时无法完成授权，请返回原页面重新发起登录。",
                failure.status,
            ),
        };
        let nonce = secret();
        let mut page = Response::from_html(format!("<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Molis · 账号授权</title><body><script nonce=\"{nonce}\">window.close();</script><main><h1>Molis 账号授权</h1><p>{message}</p><a href=\"/\">返回 Molis</a></main></body></html>"))?.with_status(status);
        page.headers_mut().set(
            "Content-Security-Policy",
            &format!("default-src 'none'; script-src 'nonce-{nonce}'; frame-ancestors 'none'; base-uri 'none'"),
        )?;
        page.headers_mut().set("Cache-Control", "no-store")?;
        page.headers_mut().set("Referrer-Policy", "no-referrer")?;
        page
    } else {
        json_response(json!({"data":result?,"requestId":a.request_id}), 200)?
    };
    response
        .headers_mut()
        .set("X-CSRF-Token", &csrf(key, browser_id))?;
    if let Some(cookie) = cookie {
        response.headers_mut().append(
            "Set-Cookie",
            &format!(
                "molis-auth-web={cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
                SESSION_MAX_AGE_MS / 1000,
                if a.origin.starts_with("https:") {
                    "; Secure"
                } else {
                    ""
                }
            ),
        )?;
    }
    Ok(response)
}
fn is_product_route(path: &str, method: &Method) -> bool {
    PRODUCT_ROUTES
        .iter()
        .any(|(declared, template)| declared == method && matches_route_template(path, template))
}

fn read_without_lease(path: &str) -> bool {
    // Capabilities, status and approved management reads only. A managed page
    // can issue a cursor under its initial READY revision, through the cursor batch.
    const ROUTES: &[&str] = &[
        "/api/account/session",
        "/api/account/auth/capabilities",
        "/api/account/login-methods",
        "/api/account/me",
        "/api/account/platform/users",
        "/api/account/platform/users/{userId}",
        "/api/account/platform/users/{userId}/permissions",
        "/api/account/platform/applications",
        "/api/account/platform/applications/{applicationId}",
        "/api/account/platform/applications/{applicationId}/clients",
        "/api/account/platform/clients/{clientId}",
        "/api/account/tenants",
        "/api/account/tenant-creation-policy",
        "/api/account/tenants/{tenantId}",
        "/api/account/platform/tenants",
        "/api/account/platform/tenants/{tenantId}",
        "/api/account/tenants/{tenantId}/members",
        "/api/account/tenants/{tenantId}/invitations",
        "/api/account/invitations",
        "/api/account/ownership-transfers",
        "/api/account/catalog/plans",
        "/api/account/catalog/features",
        "/api/account/subscriptions",
        "/api/account/tenants/{tenantId}/subscriptions",
        "/api/account/tenants/{tenantId}/seat-pools",
        "/api/account/tenants/{tenantId}/seat-assignments",
        "/api/account/platform/subscriptions",
        "/api/account/platform/subscriptions/{subscriptionId}",
        "/api/account/platform/subscriptions/{subscriptionId}/seat-pools",
        "/api/account/tenants/{tenantId}/audit-events",
        "/api/account/platform/audit-events",
    ];
    ROUTES
        .iter()
        .any(|template| matches_route_template(path, template))
}

fn product_target(path: &str, query: Option<&str>) -> String {
    let suffix = path.strip_prefix("/api/account").expect("prefix");
    let prefix = if suffix.starts_with("/subscriptions") {
        "/api/v2/users/me"
    } else {
        "/api/v2"
    };
    let mut target = format!("{prefix}{suffix}");
    if let Some(query) = query {
        target.push('?');
        target.push_str(query);
    }
    target
}

async fn management(s: &WebSession<'_>, path: &str, method: Method, body: Value) -> Result<Value> {
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
    let url = s.a.request.url()?;
    if is_product_route(path, &method) {
        let target = product_target(path, url.query());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_routes_equal_the_original_openapi_lookup() {
        let doc: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/unified-account/openapi.json"
        )))
        .expect("contract");
        let mut methods = Method::all();
        methods.sort_by_key(|method| method.to_string().to_lowercase());
        let mut expected = Vec::new();
        for (template, operations) in doc["paths"].as_object().expect("paths") {
            if !template.starts_with("/api/account/") {
                continue;
            }
            for method in &methods {
                let Some(declaration) = operations.get(method.to_string().to_lowercase()) else {
                    continue;
                };
                if text(declaration, "operationId").starts_with("product_") {
                    expected.push((method.clone(), template.as_str()));
                }
            }
        }
        assert_eq!(PRODUCT_ROUTES, expected.as_slice());
    }

    #[test]
    fn product_matching_preserves_methods_and_path_segments() {
        for (method, path, matches) in [
            (Method::Get, "/api/account/me", true),
            (Method::Head, "/api/account/me", false),
            (Method::Post, "/api/account/me", false),
            (Method::Get, "/api/account/me/", false),
            (Method::Get, "/api/account/tenants/", true),
            (Method::Get, "/api/account/tenants//members", true),
            (Method::Get, "/api/account/tenants/%2F/members", true),
            (Method::Get, "/api/account/tenants/members/", false),
            (Method::Get, "/api/account/tenants/one/members/", false),
        ] {
            assert_eq!(is_product_route(path, &method), matches, "{method} {path}");
        }
    }

    #[test]
    fn product_targets_preserve_the_request_path_and_query() {
        use url::Url;

        let origin = "https://auth.example";
        for (request, target) in [
            ("/api/account/me", "/api/v2/me"),
            ("/api/account/me?", "/api/v2/me?"),
            (
                "/api/account/subscriptions",
                "/api/v2/users/me/subscriptions",
            ),
            (
                "/api/account/tenants/%2F/members?x=%2F&x=+",
                "/api/v2/tenants/%2F/members?x=%2F&x=+",
            ),
        ] {
            let url = Url::parse(&format!("{origin}{request}")).expect("request URL");
            assert_eq!(product_target(url.path(), url.query()), target);
        }
    }
}
