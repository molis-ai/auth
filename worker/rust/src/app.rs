use crate::{http::*, identity::Auth, security::uuid};
use serde_json::json;
use worker::{Env, Method, Request, Response};

pub async fn handle(req: Request, env: Env) -> worker::Result<Response> {
    handle_inner(req, env, None).await
}
pub(crate) async fn handle_internal(
    req: Request,
    env: Env,
    owner: (String, i64),
) -> worker::Result<Response> {
    Box::pin(handle_inner(req, env, Some(owner))).await
}
async fn handle_inner(
    req: Request,
    env: Env,
    owner: Option<(String, i64)>,
) -> worker::Result<Response> {
    let id = uuid();
    let mut a = match Auth::new(req, &env, id.clone()) {
        Ok(a) => a,
        Err(e) => return error_response(e, &id),
    };
    a.s.web_owner = owner;
    let result = dispatch(&mut a, &env).await;
    let mut response = match result {
        Ok(r) => r,
        Err(e) => {
            if e.status >= 500 {
                worker::console_error!("AUTH_SERVER_FAILURE request_id={} code={}", id, e.code);
            }
            if e.status == 429 && a.request.url()?.path().starts_with("/api/v2/") {
                json_response(
                    json!({"error":{"code":e.code,"retryAfterSeconds":60},"requestId":id}),
                    429,
                )?
            } else {
                error_response(e, &id)?
            }
        }
    };
    if response.status_code() < 400 {
        for c in &a.cookies {
            response.headers_mut().append("Set-Cookie", c)?;
        }
    }
    if response.status_code() == 429 {
        response.headers_mut().set("Retry-After", "60")?;
    }
    for (k, v) in [
        ("X-Request-ID", id.as_str()),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
        ("X-Frame-Options", "DENY"),
        (
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ] {
        if (k == "Content-Security-Policy" || k == "Referrer-Policy")
            && response.headers().get(k)?.is_some()
        {
            continue;
        }
        response.headers_mut().set(k, v)?;
    }
    if a.origin.starts_with("https:") {
        response
            .headers_mut()
            .set("Strict-Transport-Security", "max-age=31536000")?;
    }
    Ok(response)
}
async fn dispatch(a: &mut Auth, env: &Env) -> Result<Response> {
    let url = a.request.url()?;
    let path = url.path();
    let method = a.request.method();

    if path == "/api/account" || path.starts_with("/api/account/") || path == "/account/callback" {
        return crate::web_session::route(a, path, method).await;
    }
    // Every account entry uses the same current protocol.
    if path == "/api/v2/health" && method == Method::Get {
        a.s.all("SELECT 1 FROM auth_user LIMIT 1", vec![]).await?;
        return Ok(json_response(
            json!({"data":{"status":"UP","runtime":"cloudflare","backend":"rust"},"requestId":a.request_id}),
            200,
        )?);
    }
    if path == "/api/v2" || path.starts_with("/api/v2/") {
        if crate::platform_management::matches(path) {
            return crate::platform_management::route(a, path, method).await;
        }
        if path == "/api/v2/entitlements/check" {
            return crate::entitlements::route(a, method).await;
        }
        if crate::billing::matches(path) {
            return crate::billing::route(a, path, method).await;
        }
        if [
            "/api/v2/tenant-creation-policy",
            "/api/v2/tenants",
            "/api/v2/platform/tenants",
            "/api/v2/invitations",
            "/api/v2/ownership-transfers",
        ]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
        {
            return crate::tenants::route(a, path, method).await;
        }
        if path == "/api/v2/users/me"
            || path.starts_with("/api/v2/users/me/")
            || path == "/api/v2/auth/password-reset/complete"
        {
            return crate::account_management::route(a, path, method).await;
        }
        if path.starts_with("/api/v2/auth/external/") || path.starts_with("/api/v2/auth/mock/") {
            return crate::external_login::browser(a, path, method).await;
        }
        if path == "/api/v2/auth/transactions" || path.starts_with("/api/v2/auth/transactions/") {
            return crate::registration::route(a, path, method).await;
        }
        return crate::login_sessions::route(a, path, method).await;
    }
    ensure(
        !path.starts_with("/api/")
            && !path.starts_with("/oauth2/")
            && !path.starts_with("/.well-known/"),
        404,
        "NOT_FOUND",
    )?;
    ensure(
        method == Method::Get || method == Method::Head,
        405,
        "METHOD_NOT_ALLOWED",
    )?;
    let pages = ["/", "/login", "/console"];
    let page = pages.contains(&path);
    ensure(page || path.starts_with("/auth-ui/"), 404, "NOT_FOUND")?;
    let mut target = url.clone();
    target.set_path(if page { "/index.html" } else { &path[8..] });
    target.set_query(None);
    let r = env
        .assets("ASSETS")?
        .fetch_request(Request::new(target.as_str(), method)?)
        .await?;
    // Asset responses have immutable headers; copy them before adding our security policy.
    let headers = worker::Headers::new();
    for (key, value) in r.headers().entries() {
        headers.set(&key, &value)?;
    }
    let mut r = r.with_headers(headers);
    if page {
        r.headers_mut().set("Cache-Control", "no-store")?;
    }
    Ok(r)
}
pub(crate) async fn bounded(a: &mut Auth, max: usize) -> Result<String> {
    use futures_util::StreamExt;
    let mut stream = a.request.stream()?;
    let mut bytes = Vec::new();
    while let Some(part) = stream.next().await {
        let part = part?;
        ensure(bytes.len() + part.len() <= max, 413, "INVALID_REQUEST")?;
        bytes.extend(part);
    }
    String::from_utf8(bytes).map_err(|_| Failure {
        status: 400,
        code: "INVALID_REQUEST",
    })
}
