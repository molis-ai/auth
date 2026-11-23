use crate::{
    http::*,
    identity::{Auth, DEFAULT_RETRY_AFTER, retry_after_seconds},
    security::uuid,
};
use serde_json::json;
use worker::{Env, Method, Request, Response};

pub async fn handle(req: Request, env: Env) -> worker::Result<Response> {
    let (response, _) = handle_inner(req, env, None, None).await?;
    Ok(response)
}
pub(crate) async fn handle_internal(
    req: Request,
    env: Env,
    owner: (String, i64),
    client_ip: String,
) -> worker::Result<(Response, Option<i64>)> {
    Box::pin(handle_inner(req, env, Some(owner), Some(client_ip))).await
}
async fn handle_inner(
    req: Request,
    env: Env,
    owner: Option<(String, i64)>,
    client_ip: Option<String>,
) -> worker::Result<(Response, Option<i64>)> {
    let id = uuid();
    if req.method() == Method::Get {
        let url = req.url()?;
        if url.path() == "/api/v2/health" {
            let response =
                with_security_headers(health_response(&id)?, &id, url.scheme() == "https")?;
            return Ok((response, None));
        }
    }
    let mut a = match Auth::new(req, &env, id.clone(), client_ip) {
        Ok(a) => a,
        Err(e) => return Ok((error_response(e, &id)?, None)),
    };
    let external = owner.is_none();
    a.s.web_owner = owner;
    let result = dispatch(&mut a, &env).await;
    let retry_after_at = a.retry_after_at.get();
    let status = match &result {
        Ok(response) => response.status_code(),
        Err(e) => e.status,
    };
    // Internal calls carry the deadline through BFF session cleanup to the public response.
    let retry_after = (external && status == 429).then(|| {
        retry_after_at
            .map(|expires_at| retry_after_seconds(expires_at, now()))
            .unwrap_or(DEFAULT_RETRY_AFTER)
    });
    let mut response = match result {
        Ok(r) => r,
        Err(e) => {
            if e.status >= 500 {
                worker::console_error!("AUTH_SERVER_FAILURE request_id={} code={}", id, e.code);
            }
            if let Some(retry_after) = retry_after.filter(|_| {
                let path = a.request.path();
                path.starts_with("/api/v2/") || path.starts_with("/api/account/")
            }) {
                json_response(
                    json!({"error":{"code":e.code,"retryAfterSeconds":retry_after},"requestId":id}),
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
    if let Some(retry_after) = retry_after {
        response
            .headers_mut()
            .set("Retry-After", &retry_after.to_string())?;
    }
    let response = with_security_headers(response, &id, a.origin.starts_with("https:"))?;
    Ok((response, retry_after_at))
}

fn health_response(id: &str) -> worker::Result<Response> {
    json_response(
        json!({"data":{"status":"UP","runtime":"cloudflare","backend":"rust"},"requestId":id}),
        200,
    )
}

fn with_security_headers(
    mut response: Response,
    id: &str,
    https: bool,
) -> worker::Result<Response> {
    for (k, v) in [
        ("X-Request-ID", id),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
        ("X-Frame-Options", "DENY"),
        (
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ] {
        if (k == "Content-Security-Policy" || k == "Referrer-Policy")
            && response.headers().get(k)?.is_some()
        {
            continue;
        }
        response.headers_mut().set(k, v)?;
    }
    if https {
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

    if matches!(
        path,
        "/.well-known/molis-sync-jwks.json" | "/api/v2/auth/sync-read-proof"
    ) {
        return crate::sync_read_proof::route(a, path, method).await;
    }

    if path.starts_with("/api/v2/auth/management-handoffs")
        || path == "/account/handoff/start"
        || path == "/account/handoff/finish"
    {
        return crate::management_handoff::route(a, path, method).await;
    }
    if path == "/api/account" || path.starts_with("/api/account/") || path == "/account/callback" {
        return crate::web_session::route(a, path, method).await;
    }
    if path == "/api/v2/readiness" && method == Method::Get {
        ensure(env.var("MOLIS_LOCAL_GENERATION").is_ok(), 404, "NOT_FOUND")?;
        a.s.all("SELECT 1 FROM auth_user LIMIT 1", vec![]).await?;
        if env.var("MOLIS_ENVIRONMENT").is_ok() {
            a.s.all(
                "SELECT user_epoch,session_revision FROM auth_login_session LIMIT 0",
                vec![],
            )
            .await?;
            a.s.all(
                "SELECT payload,revision FROM auth_web_session LIMIT 0",
                vec![],
            )
            .await?;
            a.s.all(
                "SELECT provider_pkce_verifier_sealed FROM auth_product_transaction LIMIT 0",
                vec![],
            )
            .await?;

            let client = crate::web_session::setting(a, "AUTH_WEB_CLIENT_ID")?;
            let registration = crate::login_sessions::registered_client(a, &client).await?;
            ensure(
                contains(
                    &parsed(&registration, "redirects")?,
                    &json!(format!("{}/account/callback", a.origin)),
                ) && contains(&parsed(&registration, "allowed_origins")?, &json!(a.origin)),
                503,
                "UNIFIED_CONFIGURATION_INVALID",
            )?;
            crate::test_admission::Admission::load(a)?;
            ensure(
                crate::login_capabilities::available(a, &registration).len() == 5
                    && token(&crate::web_session::setting(a, "AUTH_WEB_SESSION_KEY")?),
                503,
                "UNIFIED_CONFIGURATION_INVALID",
            )?;
        }
        return Ok(health_response(&a.request_id)?);
    }
    // Every account entry uses the same current protocol.
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
        if path.starts_with("/api/v2/auth/external/") {
            return crate::external_login::browser(a, path, method).await;
        }
        #[cfg(feature = "mock-provider")]
        if path.starts_with("/api/v2/auth/mock/") {
            return crate::external_login::browser(a, path, method).await;
        }
        if path == "/api/v2/auth/capabilities" {
            return crate::login_capabilities::route(a, method).await;
        }
        if matches!(
            path,
            "/api/v2/auth/login/password"
                | "/api/v2/auth/login/code"
                | "/api/v2/auth/verification-codes"
        ) {
            return crate::login_commands::route(a, path, method).await;
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
    // Documents use the configured origin before cookies or login forms are created.
    // API writes retain their strict Origin and CSRF checks.
    if page && url.origin().ascii_serialization() != a.origin {
        let mut canonical = Request::new(&a.origin, Method::Get)?.url()?;
        canonical.set_path(path);
        canonical.set_query(url.query());
        let mut response = Response::empty()?.with_status(302);
        response.headers_mut().set("Location", canonical.as_str())?;
        response.headers_mut().set("Cache-Control", "no-store")?;
        return Ok(response);
    }
    let mut target = url.clone();
    target.set_path(if page { "/index.html" } else { &path[8..] });
    target.set_query(None);
    let mut r = env
        .assets("ASSETS")?
        .fetch_request(Request::new(target.as_str(), method.clone())?)
        .await?;
    // Asset responses have immutable headers; copy them before adding our security policy.
    let headers = worker::Headers::new();
    for (key, value) in r.headers().entries() {
        headers.set(&key, &value)?;
    }
    let environment = env
        .var("MOLIS_ENVIRONMENT")
        .map(|value| value.to_string())
        .unwrap_or_default();
    let label = match environment.as_str() {
        "dev" => "DEV · 本地数据",
        "test" => "TEST · 远程测试数据",
        _ => "",
    };
    let mut r = if page && method == Method::Get && !label.is_empty() && r.status_code() == 200 {
        let body = r.text().await?.replacen(
            "</head>",
            &format!("<meta name=\"molis-environment\" content=\"{label}\"></head>"),
            1,
        );
        headers.delete("Content-Length")?;
        headers.delete("Content-Encoding")?;
        headers.delete("ETag")?;
        Response::from_html(body)?.with_headers(headers)
    } else {
        r.with_headers(headers)
    };
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
