//! Private identity assertions for the Work billing service.
use crate::{
    app::{bounded, with_security_headers},
    auth::login_sessions::{self, ACCESS_USER_ID, bearer},
    http::*,
    identity::Auth,
    tenants::{ACTIVE_MEMBER, ALL_ROLES, Context, TENANTS, require_member},
    web::web_session::setting,
};
use serde::Deserialize;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use worker::{Env, Request, Response, web_sys};

const INTROSPECT: &str = "/internal/v1/sessions/introspect";
const VERIFY: &str = "/internal/v1/subjects/verify";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Introspect {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Verify {
    product: Product,
    owner: Owner,
}

#[derive(Deserialize)]
enum Product {
    #[serde(rename = "WORK")]
    Work,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "UPPERCASE", deny_unknown_fields)]
enum Owner {
    User { id: Option<String> },
    Tenant { id: String },
}

// worker-build places free Wasm functions on the default Worker prototype.
// Keep the bridge on a module class that the runtime adapter does not re-export.
#[wasm_bindgen]
pub struct AuthBillingIdentity;

#[wasm_bindgen]
impl AuthBillingIdentity {
    pub async fn authorize(
        request: web_sys::Request,
        env: Env,
    ) -> std::result::Result<web_sys::Response, JsValue> {
        respond(request.into(), &env)
            .await
            .map(Response::into)
            .map_err(|_| JsValue::from_str("Auth bridge unavailable"))
    }
}

async fn respond(request: Request, env: &Env) -> worker::Result<Response> {
    let id = billing_request_id(&request);
    let path = match request.path().as_str() {
        INTROSPECT => INTROSPECT,
        VERIFY => VERIFY,
        _ => {
            return error_response(
                Failure {
                    status: 404,
                    code: "NOT_FOUND",
                },
                &id,
            );
        }
    };
    let log = RequestLog {
        started: now(),
        env: log_env(env),
        id: &id,
        route: path,
        method: "POST",
    };
    let https = request.url()?.scheme() == "https";
    let result = match Auth::new(request, env, &log, None) {
        Ok(mut auth) => authorize(&mut auth, path).await,
        Err(_) => Err(Failure::unavailable()),
    };
    let code = result.as_ref().err().map(|error| error.code);
    let response = match result {
        Ok(data) => json_response(json!({ "data": data }), 200)?,
        Err(error) => {
            log_failure(log.env, &id, path, "authorize", &error, log.started);
            let message = match error.code {
                "UNAUTHENTICATED" => "A valid authorization header is required",
                "SESSION_EXPIRED" => "The session is no longer valid",
                "TENANT_DISABLED" => "The tenant is disabled",
                "FORBIDDEN" => "The subject is not authorized",
                "NOT_FOUND" => "The subject was not found",
                "INVALID_REQUEST" => "The request is invalid",
                "METHOD_NOT_ALLOWED" => "The method is not allowed",
                _ => "Auth is unavailable",
            };
            json_response(
                json!({ "error": { "code": error.code, "message": message } }),
                error.status,
            )?
        }
    };
    log.finish(response.status_code(), code);
    with_security_headers(response, &id, https)
}

async fn authorize(a: &mut Auth, path: &str) -> Result<Value> {
    let web_client = setting(a, "AUTH_WEB_CLIENT_ID").map_err(|_| Failure::unavailable())?;
    ensure(a.unified_config.is_some(), 503, "AUTH_UNAVAILABLE")?;
    let authorization = a.header("Authorization");
    let raw = bearer(&authorization);
    ensure(token(raw), 401, "UNAUTHENTICATED")?;
    ensure(
        a.request.inner().method() == "POST",
        405,
        "METHOD_NOT_ALLOWED",
    )?;
    let body = bounded(a, 2048).await?;
    ensure(body.trim_start().starts_with('{'), 400, "INVALID_REQUEST")?;
    let owner = if path == VERIFY {
        let Verify {
            product: Product::Work,
            owner,
        } = serde_json::from_str(&body)?;
        let id = match &owner {
            Owner::User { id } => id.as_deref(),
            Owner::Tenant { id } => Some(id.as_str()),
        };
        ensure(id.is_none_or(valid_id), 400, "INVALID_REQUEST")?;
        Some(owner)
    } else {
        let Introspect {} = serde_json::from_str(&body)?;
        None
    };
    let (digest, credential) = login_sessions::active_lookup(a, raw)?;
    let mut ctx = Context::new();
    let row = if let Some(Owner::Tenant { id }) = &owner {
        // All three facts come from the same D1 read transaction. The
        // credential below must succeed before the other results are used.
        let snapshot = a.s.batch_read(vec![
            credential,
            a.s.statement(&format!("{TENANTS} WHERE t.space_id=?"), vec![id.clone().into()])?,
            a.s.statement(
                &format!("SELECT role FROM auth_tenant_membership WHERE user_id={ACCESS_USER_ID} AND {ACTIVE_MEMBER}"),
                vec![digest.clone().into(), id.clone().into()],
            )?,
        ]).await?;
        let [credential, tenant, member] =
            <[_; 3]>::try_from(snapshot).map_err(|_| Failure::unavailable())?;
        ctx.tenant = tenant.into_iter().next().unwrap_or_default();
        ctx.member = member.into_iter().next().unwrap_or_default();
        credential.into_iter().next().unwrap_or_default()
    } else {
        a.s.first(credential).await?
    };
    let (session, client) =
        login_sessions::active_result(a, row, digest, &a.origin).map_err(|error| {
            match error.status {
                401 => Failure {
                    status: 401,
                    code: "SESSION_EXPIRED",
                },
                403 => Failure {
                    status: 403,
                    code: "FORBIDDEN",
                },
                _ => Failure::unavailable(),
            }
        })?;
    ensure(
        session["client_id"] == web_client && client["client_type"] == "WEB",
        403,
        "FORBIDDEN",
    )?;
    let user = session["user_id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or_else(Failure::unavailable)?;
    match owner {
        None => Ok(json!({ "userId": user })),
        Some(Owner::User { id }) => {
            ensure(id.is_none_or(|id| id == user), 403, "FORBIDDEN")?;
            Ok(
                json!({ "userId": user, "product": "WORK", "owner": { "kind": "USER", "id": user }, "role": "SELF" }),
            )
        }
        Some(Owner::Tenant { id }) => {
            require_member(&ctx, ALL_ROLES)?;
            Ok(
                json!({ "userId": user, "product": "WORK", "owner": { "kind": "TENANT", "id": id }, "role": ctx.member["role"] }),
            )
        }
    }
}
