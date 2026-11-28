//! Auth's same-origin BFF. Only an opaque HttpOnly cookie crosses the browser boundary.
use super::{browser_transactions::BrowserTransactions, upstream};
use crate::{
    auth::{login_capabilities, login_sessions},
    core::http::*,
    core::identity::{Auth, OperationInput},
    core::security::{hash, secret},
    core::store::CommitFence,
};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use worker::{Method, Response};

static PRODUCT_ROUTES: &[(Method, &str)] = include!(concat!(env!("OUT_DIR"), "/product_routes.rs"));
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
fn central_failure(status: u16, code: &str) -> Failure {
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
enum BrowserPayload {
    Account(Value),
    Upstream(upstream::Reply),
}

fn should_clear(result: &Result<BrowserPayload>) -> bool {
    let code = match result {
        Err(failure) => Some(failure.code),
        Ok(BrowserPayload::Upstream(reply)) => reply.error_code(),
        Ok(BrowserPayload::Account(_)) => None,
    };
    matches!(
        code,
        Some("SESSION_EXPIRED" | "SESSION_REVOKED" | "LOGIN_REQUIRED" | "UNAUTHENTICATED")
    )
}
pub(super) async fn decode(key: &str, id: &str, payload: &str) -> Result<Value> {
    let mut value: Value = serde_json::from_str(&open(key, payload).await.map_err(unavailable)?)?;
    ensure(value["id"] == id, 401, "INVALID_CREDENTIALS")?;
    Ok(value["data"].take())
}

async fn seal_tokens(key: &str, id: &str, tokens: &Value) -> Result<String> {
    seal(key, &json!({"id":id,"data":tokens}).to_string())
        .await
        .map_err(unavailable)
}

const CURRENT_BROWSER_SESSION: &str =
    "EXISTS(SELECT 1 FROM auth_web_session WHERE id_hash=? AND revision=? AND expires_at>?)";

async fn load_session(a: &Auth, id: &str) -> Result<Value> {
    a.s.one(
        "SELECT payload,revision FROM auth_web_session WHERE id_hash=? AND expires_at>?",
        vec![id.into(), now().into()],
    )
    .await
}
pub(crate) fn browser_cookie_hash(a: &Auth, cookie: &str) -> String {
    match a.env.var("MOLIS_LOCAL_GENERATION") {
        Ok(generation) => hash(&format!("{generation}:{cookie}")),
        Err(_) => hash(cookie),
    }
}
pub(crate) fn browser_cookie_name(a: &Auth) -> &'static str {
    if a.origin.starts_with("https:") {
        "__Host-molis-auth-web"
    } else {
        "molis-auth-web"
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
    revision: Option<i64>,
    key: String,
}
impl WebSession<'_> {
    pub fn client(&self) -> Result<String> {
        setting(self.a, "AUTH_WEB_CLIENT_ID")
    }
    fn fence_bindings(&self) -> Option<Vec<Value>> {
        self.revision
            .map(|revision| vec![self.id.clone().into(), revision.into(), now().into()])
    }

    async fn clear_rejected_tokens(&self) -> Result<bool> {
        let Some(bindings) = self.fence_bindings() else {
            return Ok(false);
        };
        let writes = vec![
            self.a.s.guard(CURRENT_BROWSER_SESSION, bindings)?,
            self.a.s.statement(
                "DELETE FROM auth_browser_transaction WHERE browser_hash=?",
                vec![self.id.clone().into()],
            )?,
            self.a.s.statement(
                "DELETE FROM auth_web_session WHERE id_hash=?",
                vec![self.id.clone().into()],
            )?,
        ];
        match self.a.s.batch(writes, "VERSION_CONFLICT").await {
            Ok(()) => Ok(true),
            Err(failure) if failure.code == "VERSION_CONFLICT" => Ok(false),
            Err(failure) => Err(failure),
        }
    }

    async fn logout(&mut self, body: &Value) -> Result<Value> {
        let mut writes = vec![];
        if let Some(bindings) = self.fence_bindings() {
            writes.push(self.a.s.guard(CURRENT_BROWSER_SESSION, bindings)?);
            writes.push(self.a.s.statement(
                "DELETE FROM auth_web_session WHERE id_hash=?",
                vec![self.id.clone().into()],
            )?);
        }
        writes.push(self.a.s.statement(
            "DELETE FROM auth_browser_transaction WHERE browser_hash=?",
            vec![self.id.clone().into()],
        )?);
        self.a.s.batch(writes, "VERSION_CONFLICT").await?;
        self.revision = None;
        let saved = self.data["tokens"].take();
        if saved.is_null() {
            return Ok(json!({"localCleared":true,"remoteRevocation":"UNCONFIRMED"}));
        }
        let path = if body["scope"] == "ALL_MOLIS_PRODUCTS" {
            "/api/v1/sessions/logout-all"
        } else {
            "/api/v1/sessions/current/logout"
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
            path.starts_with("/api/v1/") && !path.contains('#') && !path.contains(".."),
            400,
            "INVALID_REQUEST",
        )?;
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        let log = self.command_log(path, &method);
        let command = self.command(
            OperationInput {
                query: query.to_owned(),
                authorization: self.data["tokens"]["accessToken"]
                    .as_str()
                    .map_or_else(String::new, |token| format!("Bearer {token}")),
                initiator_proof: proof.unwrap_or_default().to_owned(),
                idempotency_key: key.unwrap_or_default().to_owned(),
                ..OperationInput::default()
            },
            &log,
        );
        let result = super::v1::execute(
            &command,
            super::v1::CallInput {
                path,
                method: method.clone(),
                body: body.unwrap_or_else(|| json!({})),
            },
        )
        .await;
        self.command_result(&command, &log, result)
    }

    fn command_log<'a>(&'a self, path: &str, method: &'a Method) -> RequestLog<'a> {
        RequestLog {
            started: now(),
            env: log_env(&self.a.env),
            id: &self.a.request_id,
            route: super::http::log_route(path),
            method: method.as_ref(),
        }
    }

    fn command(&self, input: OperationInput, log: &RequestLog<'_>) -> Auth {
        let fence = self.fence_bindings().map(|bindings| CommitFence {
            condition: CURRENT_BROWSER_SESSION,
            bindings,
        });
        self.a.for_operation(input, log.route, fence)
    }

    fn command_result<T>(
        &self,
        command: &Auth,
        log: &RequestLog<'_>,
        result: Result<T>,
    ) -> Result<T> {
        result.map_err(|failure| {
            command.s.log_failure("internal", &failure, log.started);
            if failure.status == 429 {
                self.a.retry_after_at.set(command.retry_after_at.get());
            }
            central_failure(failure.status, failure.code)
        })
    }

    pub(crate) async fn login(&self, path: &str, body: &Value, proof: &str) -> Result<Value> {
        let log = self.command_log(path, &Method::Post);
        let command = self.command(
            OperationInput {
                initiator_proof: proof.to_owned(),
                ..OperationInput::default()
            },
            &log,
        );
        let result = crate::auth::login_commands::execute(
            &command,
            path,
            body,
            crate::auth::login_commands::Completion::Session,
        )
        .await;
        self.command_result(&command, &log, result)
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
        let old = &self.data["tokens"];
        let revision = self.revision.ok_or_else(version_conflict)?;
        let tokens = login_sessions::refresh_browser(
            self.a, &self.client()?, &text(old, "refreshToken"), async |tokens| {
                shape("TokenSet", tokens)?;
                ensure(tokens["session"]["loginSessionId"] == old["session"]["loginSessionId"], 403, "FORBIDDEN")?;
                let payload = seal_tokens(&self.key, &self.id, tokens).await?;
                Ok(vec![
                    self.a.s.guard(CURRENT_BROWSER_SESSION, self.fence_bindings().ok_or_else(version_conflict)?)?,
                    self.a.s.statement(
                        "UPDATE auth_web_session SET payload=?,revision=revision+1 WHERE id_hash=? AND revision=?",
                        vec![payload.into(), self.id.clone().into(), revision.into()],
                    )?,
                ])
            }
        ).await;
        match tokens {
            Ok(tokens) => {
                self.revision = Some(revision + 1);
                self.data["tokens"] = tokens;
            }
            Err(failure) if failure.status == 409 => {
                let latest = load_session(self.a, &self.id).await?;
                ensure(
                    !latest.is_null() && number(&latest, "revision") > revision,
                    409,
                    "VERSION_CONFLICT",
                )?;
                let tokens = decode(&self.key, &self.id, &text(&latest, "payload")).await?;
                ensure(
                    tokens["session"]["loginSessionId"] == old["session"]["loginSessionId"],
                    409,
                    "VERSION_CONFLICT",
                )?;
                self.data["tokens"] = tokens;
                self.revision = Some(number(&latest, "revision"));
                ensure(self.access_is_fresh(), 409, "VERSION_CONFLICT")?;
            }
            Err(failure) => return Err(session_failure(failure)),
        }
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
        let me = crate::account::management::web_account_view(
            self.a,
            self.data["tokens"]["accessToken"].as_str().unwrap_or(""),
        )
        .await
        .map_err(|failure| central_failure(failure.status, failure.code))
        .map_err(session_failure)?;
        Ok(
            json!({"state":"AUTHENTICATED","user":me["user"],"session":me["session"],"capabilities":me["platformCapabilities"]}),
        )
    }
}
fn csrf(key: &str, id: &str) -> String {
    hash(&format!("web-csrf:{key}:{id}"))
}
// Anonymous reads issue an origin-bound CSRF proof instead of reserving a row.
const BOOTSTRAP_CSRF_WINDOW_MS: i64 = 86_400_000;
fn bootstrap_csrf(a: &Auth, key: &str, window: i64) -> String {
    let scope = browser_cookie_hash(a, &format!("bootstrap:{}:{window}", a.origin));
    format!("bootstrap.{}", csrf(key, &scope))
}

fn anonymous_response(a: &Auth, key: &str) -> Result<Response> {
    let mut response = json_response(
        json!({"data":{"state":"ANONYMOUS"},"requestId":a.request_id}),
        200,
    )?;
    response.headers_mut().set(
        "X-CSRF-Token",
        &bootstrap_csrf(a, key, now() / BOOTSTRAP_CSRF_WINDOW_MS),
    )?;
    Ok(response)
}

pub(crate) fn matches(path: &str) -> bool {
    path == "/api/account" || path.starts_with("/api/account/") || path == "/account/callback"
}

pub(crate) async fn route(
    a: &mut Auth,
    path: &str,
    method: Method,
) -> Result<ResponseWithErrorCode> {
    ensure(
        a.header("Authorization").is_empty() && a.header("X-Auth-Initiator-Proof").is_empty(),
        400,
        "INVALID_REQUEST",
    )?;
    let raw_method = a.http()?.inner().method();
    let upstream = upstream::Target::parse(path, || raw_method.clone())?;
    let request_url = a.http()?.url()?;
    if path != "/account/callback"
        && (path == "/api/account/session"
            || path.starts_with("/api/account/auth/")
            || path == "/api/account/reauthentications"
            || path.starts_with("/api/account/password/")
            || path.starts_with("/api/account/login-methods/"))
    {
        ensure(request_url.query().is_none(), 400, "INVALID_REQUEST")?;
    }
    if path == "/api/account/login-sessions" {
        ensure(
            a.http()?.inner().method() == "GET",
            405,
            "METHOD_NOT_ALLOWED",
        )?;
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
    if path == "/api/account/auth/capabilities" {
        ensure(
            a.http()?.inner().method() == "GET",
            405,
            "METHOD_NOT_ALLOWED",
        )?;
        let client_id = setting(a, "AUTH_WEB_CLIENT_ID")?;
        shape("LoginCapabilitiesQuery", &json!({"clientId":client_id}))?;
        // The browser origin was checked above. The registration is chosen by the BFF.
        let registration = login_sessions::registered_client(a, &client_id)
            .await
            .map_err(|failure| central_failure(failure.status, failure.code))?;
        let result = login_capabilities::describe(a, &registration)
            .map_err(|failure| central_failure(failure.status, failure.code))?;
        let response = json_response(json!({"data":result,"requestId":a.request_id}), 200)?;
        return Ok((response, None));
    }
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
        .filter_map(|v| v.split_once('='))
        .filter(|(name, _)| *name == browser_cookie_name(a))
        .map(|(_, value)| value.to_owned())
        .collect();
    ensure(values.len() <= 1, 401, "INVALID_CREDENTIALS")?;
    let mut cookie = values.first().cloned().unwrap_or_default();
    let has_cookie = token(&cookie);
    let session_read = path == "/api/account/session" && method == Method::Get;
    if !has_cookie && session_read {
        return Ok((anonymous_response(a, &key)?, None));
    }
    let initial_write = method == Method::Post
        && matches!(
            path,
            "/api/account/auth/transactions"
                | "/api/account/auth/login/password"
                | "/api/account/auth/verification-codes"
        );
    ensure(has_cookie || initial_write, 401, "LOGIN_REQUIRED")?;
    let mut id = browser_cookie_hash(a, &cookie);
    if path == "/api/account/auth/login/code" && method == Method::Post {
        let body = write_input(a, &csrf(&key, &id), method, false, false).await?;
        shape("LoginCodeRequest", &body)?;
        let handle = text(&body, "verificationId");
        let row = a.s.one(
            "SELECT t.payload,t.revision,
             EXISTS(SELECT 1 FROM auth_web_session w WHERE w.id_hash=t.browser_hash AND w.expires_at>?) signed_in
             FROM auth_browser_transaction t WHERE t.browser_hash=? AND t.handle=? AND t.expires_at>?",
            vec![now().into(), id.clone().into(), handle.clone().into(), now().into()],
        ).await?;
        ensure(!row.is_null(), 403, "FORBIDDEN")?;
        ensure(number(&row, "signed_in") == 0, 409, "VERSION_CONFLICT")?;
        let proof = decode(&key, &format!("{id}:{handle}"), &text(&row, "payload")).await?;
        let authenticated_cookie = secret();
        let browser_id = browser_cookie_hash(a, &authenticated_cookie);
        let result = crate::auth::login_commands::browser_code(
            a, &setting(a,"AUTH_WEB_CLIENT_ID")?, &body, &text(&proof,"proof"), async |tokens| {
                let mut writes = new_browser_session(a, &key, &browser_id, Some(&id), tokens).await?;
                writes.push(a.s.guard(
                    "EXISTS(SELECT 1 FROM auth_browser_transaction WHERE browser_hash=? AND handle=? AND revision=? AND expires_at>?)",
                    vec![id.clone().into(), handle.clone().into(), row["revision"].clone(), now().into()],
                )?);
                writes.push(a.s.statement("DELETE FROM auth_browser_transaction WHERE browser_hash=? AND handle=?",
                    vec![id.clone().into(),handle.clone().into()])?);
                Ok(writes)
            },
        ).await.map_err(|failure| {
            if failure.code == "ALREADY_EXISTS" { version_conflict() } else { central_failure(failure.status, failure.code) }
        });
        return browser_response(
            a,
            path,
            &key,
            &browser_id,
            Some(&authenticated_cookie),
            result.map(BrowserPayload::Account),
        );
    }
    let row = if has_cookie {
        load_session(a, &id).await?
    } else {
        Value::Null
    };
    let incoming_csrf = a.header("X-CSRF-Token");
    let expected_csrf = if initial_write && incoming_csrf.starts_with("bootstrap.") {
        ensure(row.is_null(), 409, "VERSION_CONFLICT")?;
        let window = now() / BOOTSTRAP_CSRF_WINDOW_MS;
        ensure(
            incoming_csrf == bootstrap_csrf(a, &key, window)
                || incoming_csrf == bootstrap_csrf(a, &key, window - 1),
            403,
            "FORBIDDEN",
        )?;
        incoming_csrf
    } else {
        ensure(has_cookie, 403, "FORBIDDEN")?;
        csrf(&key, &id)
    };
    let logout = path == "/api/account/logout" && method == Method::Post;
    let mut body = write_input(
        a,
        &expected_csrf,
        method.clone(),
        logout,
        upstream.is_some(),
    )
    .await?;
    if !has_cookie {
        cookie = secret();
        id = browser_cookie_hash(a, &cookie);
    }
    let revision = (!row.is_null()).then(|| number(&row, "revision"));
    let tokens = if revision.is_some() {
        decode(&key, &id, &text(&row, "payload")).await?
    } else {
        Value::Null
    };
    let mut session = WebSession {
        a,
        id: id.clone(),
        revision,
        key: key.clone(),
        data: json!({"tokens":tokens,"transactions":{}}),
    };
    if path == "/api/account/auth/login/password" && method == Method::Post {
        ensure(revision.is_none(), 409, "VERSION_CONFLICT")?;
        let authenticated_cookie = secret();
        let browser_id = browser_cookie_hash(a, &authenticated_cookie);
        let result = crate::auth::login_commands::browser_password(
            a,
            &session.client()?,
            &body,
            async |tokens| {
                new_browser_session(
                    a,
                    &key,
                    &browser_id,
                    has_cookie.then_some(id.as_str()),
                    tokens,
                )
                .await
            },
        )
        .await
        .map_err(|failure| {
            if failure.code == "ALREADY_EXISTS" {
                version_conflict()
            } else {
                central_failure(failure.status, failure.code)
            }
        });
        return browser_response(
            a,
            path,
            &key,
            &browser_id,
            Some(&authenticated_cookie),
            result.map(BrowserPayload::Account),
        );
    }
    let mut browser_id = id.clone();
    let mut set_cookie = !has_cookie;
    let auth_operation = path == "/api/account/reauthentications"
        || path.starts_with("/api/account/auth/")
        || path.starts_with("/api/account/password/")
        || path.starts_with("/api/account/login-methods/")
        || path == "/account/callback";
    let mut result = if session_read {
        session.view().await.map(BrowserPayload::Account)
    } else if logout {
        session.logout(&body).await.map(BrowserPayload::Account)
    } else if auth_operation {
        let (transactions, previous) = BrowserTransactions::load(a, &id, &key, path, &body).await?;
        session.data["transactions"] = previous.clone();
        let reply = super::web_auth::route(&mut session, path, method, &mut body).await;
        let promote = reply.is_ok() && revision.is_none() && !session.data["tokens"].is_null();
        if promote {
            cookie = secret();
            browser_id = browser_cookie_hash(a, &cookie);
            set_cookie = true;
        }
        let mut writes = transactions
            .writes(
                a,
                &id,
                &browser_id,
                &key,
                &previous,
                &session.data["transactions"],
            )
            .await?;
        if promote {
            writes.extend(
                new_browser_session(a, &key, &browser_id, Some(&id), &session.data["tokens"])
                    .await?,
            );
        } else if !writes.is_empty()
            && let Some(bindings) = session.fence_bindings()
        {
            writes.insert(0, a.s.guard(CURRENT_BROWSER_SESSION, bindings)?);
        }
        if !writes.is_empty() {
            a.s.batch(writes, "VERSION_CONFLICT")
                .await
                .map_err(|failure| {
                    if failure.code == "ALREADY_EXISTS" {
                        version_conflict()
                    } else {
                        failure
                    }
                })?;
        }
        reply.map(BrowserPayload::Account)
    } else {
        match session.fresh().await {
            Ok(()) => match &upstream {
                Some(target) => call_upstream(target, &session, body.as_str()).await,
                None => management(&session, path, method, body)
                    .await
                    .map(BrowserPayload::Account),
            },
            Err(failure) => Err(failure),
        }
    };
    if should_clear(&result) {
        let cleared = session.clear_rejected_tokens().await?;
        if session_read {
            ensure(cleared, 409, "VERSION_CONFLICT")?;
            result = Ok(BrowserPayload::Account(json!({"state":"EXPIRED"})));
        }
    }
    browser_response(
        a,
        path,
        &key,
        &browser_id,
        set_cookie.then_some(cookie.as_str()),
        result,
    )
}

async fn new_browser_session(
    a: &Auth,
    key: &str,
    browser_id: &str,
    previous: Option<&str>,
    tokens: &Value,
) -> Result<Vec<worker::D1PreparedStatement>> {
    let expires = now() + SESSION_MAX_AGE_MS;
    let payload = seal_tokens(key, browser_id, tokens).await?;
    let mut writes = Vec::new();
    if let Some(old) = previous {
        writes.push(a.s.statement(
            "INSERT INTO auth_one_use(token_hash,purpose,binding_hash,payload,expires_at)
             VALUES (?,'BROWSER_PROMOTION',?,'{}',?)",
            vec![
                hash(&format!("browser-promotion:{old}")).into(),
                old.into(),
                expires.into(),
            ],
        )?);
    }
    writes.push(a.s.statement(
        "INSERT INTO auth_web_session(id_hash,payload,expires_at) VALUES (?,?,?)",
        vec![browser_id.into(), payload.into(), expires.into()],
    )?);
    Ok(writes)
}

async fn call_upstream(
    target: &upstream::Target<'_>,
    session: &WebSession<'_>,
    body: Option<&str>,
) -> Result<BrowserPayload> {
    let access = session.data["tokens"]["accessToken"]
        .as_str()
        .unwrap_or_default();
    target
        .call(session.a, access, body)
        .await
        .map(BrowserPayload::Upstream)
}

async fn write_input(
    a: &mut Auth,
    expected_csrf: &str,
    method: Method,
    logout: bool,
    upstream: bool,
) -> Result<Value> {
    if method == Method::Get {
        return Ok(if upstream { Value::Null } else { json!({}) });
    }
    ensure(
        a.header("Origin") == a.origin && a.header("X-CSRF-Token") == expected_csrf,
        403,
        "FORBIDDEN",
    )?;
    if upstream {
        // The same-origin proxy carries the original JSON text in a Value::String.
        return Ok(upstream::Target::body(a)
            .await?
            .map_or(Value::Null, Value::String));
    }
    ensure(is_json_content_type(a), 400, "INVALID_REQUEST")?;
    let body = serde_json::from_str(&bounded(a.http_mut()?, 220000).await?)?;
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
    result: Result<BrowserPayload>,
) -> Result<ResponseWithErrorCode> {
    let mut response = if path == "/account/callback" {
        let (message, status) = match &result {
            Ok(BrowserPayload::Account(value)) if value["status"] == "CONSUMED" => (
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
        match result? {
            BrowserPayload::Account(data) => {
                json_response(json!({"data":data,"requestId":a.request_id}), 200)?
            }
            BrowserPayload::Upstream(reply) if reply.status >= 400 => {
                let code = reply.error_code().map(|code| code.to_owned().into());
                return Ok((reply.response()?, code));
            }
            BrowserPayload::Upstream(reply) => reply.response()?,
        }
    };
    response
        .headers_mut()
        .set("X-CSRF-Token", &csrf(key, browser_id))?;
    if let Some(cookie) = cookie {
        response.headers_mut().append(
            "Set-Cookie",
            &format!(
                "{}={cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
                browser_cookie_name(a),
                SESSION_MAX_AGE_MS / 1000,
                if a.origin.starts_with("https:") {
                    "; Secure"
                } else {
                    ""
                }
            ),
        )?;
    }
    Ok((response, None))
}
fn is_product_route(path: &str, method: &Method) -> bool {
    PRODUCT_ROUTES
        .iter()
        .any(|(declared, template)| declared == method && matches_route_template(path, template))
}

fn product_target(path: &str, query: Option<&str>) -> String {
    let suffix = path.strip_prefix("/api/account").expect("prefix");
    let mut target = match suffix {
        "/me" => "/api/v1/users/me".to_owned(),
        path => format!("/api/v1{path}"),
    };
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
                "/api/v1/sessions/current/activity",
                method,
                Some(body),
                None,
                None,
            )
            .await;
    }
    // Only declared noncredential product operations are forwarded. No user-selected URL or headers.
    let url = s.a.http()?.url()?;
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
                "/api/v1/users/me/profile",
                method,
                Some(body),
                None,
                Some(&s.a.header("Idempotency-Key")),
            )
            .await;
    }
    if path == "/api/account/login-sessions" && method == Method::Get {
        return login_sessions::web_login_sessions(
            s.a,
            s.data["tokens"]["accessToken"].as_str().unwrap_or(""),
        )
        .await
        .map_err(|failure| central_failure(failure.status, failure.code))
        .map_err(session_failure);
    }
    if path == "/api/account/login-methods" && method == Method::Get {
        return s
            .call("/api/v1/users/me/login-methods", method, None, None, None)
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
            ("/api/account/me", "/api/v1/users/me"),
            ("/api/account/me?", "/api/v1/users/me?"),
            (
                "/api/account/tenants/%2F/members?x=%2F&x=+",
                "/api/v1/tenants/%2F/members?x=%2F&x=+",
            ),
        ] {
            let url = Url::parse(&format!("{origin}{request}")).expect("request URL");
            assert_eq!(product_target(url.path(), url.query()), target);
        }
    }
}
