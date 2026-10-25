use crate::{http::*, identity::Auth, security::uuid};
use serde_json::{Value, json};
use worker::{Env, Method, Request, Response};

pub async fn handle(req: Request, env: Env) -> worker::Result<Response> {
    let id = uuid();
    let mut a = match Auth::new(req, &env, id.clone()) {
        Ok(a) => a,
        Err(e) => return error_response(e, &id),
    };
    let mut cors = false;
    let result = dispatch(&mut a, &env, &mut cors).await;
    let mut response = match result {
        Ok(r) => r,
        Err(e) => {
            if e.status >= 500 {
                worker::console_error!("AUTH_SERVER_FAILURE request_id={} code={}", id, e.code);
            }
            error_response(e, &id)?
        }
    };
    if response.status_code() < 400 {
        for c in &a.cookies {
            response.headers_mut().append("Set-Cookie", c)?;
        }
    }
    if cors {
        response
            .headers_mut()
            .set("Access-Control-Allow-Origin", &a.header("Origin"))?;
        response.headers_mut().set("Vary", "Origin")?;
        if a.header("Origin") == a.origin {
            response
                .headers_mut()
                .set("Access-Control-Allow-Credentials", "true")?;
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
        response.headers_mut().set(k, v)?;
    }
    if a.origin.starts_with("https:") {
        response
            .headers_mut()
            .set("Strict-Transport-Security", "max-age=31536000")?;
    }
    Ok(response)
}
async fn dispatch(a: &mut Auth, env: &Env, cors: &mut bool) -> Result<Response> {
    let url = a.request.url()?;
    let path = url.path();
    let method = a.request.method();
    let origin = a.header("Origin");
    if !origin.is_empty() && path != "/oauth2/callback/apple" {
        *cors = origin == a.origin;
        if !*cors {
            let rows=a.s.all("SELECT c.redirects FROM auth_client c JOIN auth_application a ON a.id=c.application_id WHERE c.status='ACTIVE' AND a.status='ACTIVE' AND c.client_type='WEB'",vec![]).await?;
            for row in rows {
                if parsed(&row, "redirects")?.as_array().is_some_and(|rs| {
                    rs.iter().any(|r| {
                        worker::Url::parse(r.as_str().unwrap_or_default())
                            .is_ok_and(|u| u.origin().ascii_serialization() == origin)
                    })
                }) {
                    *cors = true;
                    break;
                }
            }
        }
        ensure(*cors, 403, "ORIGIN_NOT_ALLOWED")?;
    }
    if method == Method::Options {
        ensure(
            *cors
                && ["GET", "POST", "PUT"]
                    .contains(&a.header("Access-Control-Request-Method").as_str())
                && a.header("Access-Control-Request-Headers")
                    .to_lowercase()
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .all(|s| ["authorization", "content-type", "x-auth-transaction"].contains(&s)),
            403,
            "ORIGIN_NOT_ALLOWED",
        )?;
        let mut r = Response::empty()?.with_status(204);
        for (k, v) in [
            ("Access-Control-Allow-Methods", "GET, POST, PUT"),
            (
                "Access-Control-Allow-Headers",
                "Authorization, Content-Type, X-Auth-Transaction",
            ),
            ("Access-Control-Max-Age", "600"),
        ] {
            r.headers_mut().set(k, v)?;
        }
        return Ok(r);
    }
    if path == "/api/v1/health" && method == Method::Get {
        a.s.all("SELECT 1 FROM auth_user LIMIT 1", vec![]).await?;
        return Ok(json_response(
            json!({"data":{"status":"UP","runtime":"cloudflare","backend":"rust","migrationComplete":false},"requestId":a.request_id}),
            200,
        )?);
    }
    if path == "/api/v1/auth/ui-configuration" && method == Method::Get {
        let c=a.s.one("SELECT c.redirects,c.scopes FROM auth_client c JOIN auth_application a ON a.id=c.application_id WHERE c.client_id='molis-auth-console' AND c.client_type='WEB' AND c.status='ACTIVE' AND a.status='ACTIVE'",vec![]).await?;
        let configured = !c.is_null()
            && contains(
                &parsed(&c, "redirects")?,
                &json!(format!("{}/console/callback", a.origin)),
            )
            && ["account", "profile"]
                .iter()
                .all(|s| parsed(&c, "scopes").is_ok_and(|p| contains(&p, &json!(s))));
        return Ok(json_response(
            json!({"data":{"mailboxEnabled":false,"authOrigin":a.origin,"providers":crate::federation::providers(a),"console":{"enabled":configured,"clientId":if configured{json!("molis-auth-console")}else{Value::Null},"redirectUri":if configured{json!(format!("{}/console/callback",a.origin))}else{Value::Null}}},"requestId":a.request_id}),
            200,
        )?);
    }
    if path == "/oauth2/callback/google" || path == "/oauth2/callback/apple" {
        return crate::federation::callback(a, path.rsplit('/').next().unwrap()).await;
    }
    if path == "/oauth2/token" && method == Method::Post {
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/x-www-form-urlencoded"),
            415,
            "INVALID_REQUEST",
        )?;
        let body = bounded(a, 4096).await?;
        let b = form(&body)?;
        return Ok(json_response(a.token(&b).await?, 200)?);
    }
    if path.starts_with("/api/")
        || path.starts_with("/oauth2/")
        || path.starts_with("/.well-known/")
    {
        let b = if method == Method::Post || method == Method::Put {
            ensure(
                a.header("Content-Type").split(';').next() == Some("application/json"),
                415,
                "INVALID_REQUEST",
            )?;
            let b: Value = serde_json::from_str(&bounded(a, 200000).await?)?;
            ensure(b.is_object(), 400, "INVALID_REQUEST")?;
            b
        } else {
            json!({})
        };
        let data = api(a, path, method, &b).await?;
        return Ok(json_response(
            json!({"data":data,"requestId":a.request_id}),
            200,
        )?);
    }
    ensure(
        method == Method::Get || method == Method::Head,
        405,
        "METHOD_NOT_ALLOWED",
    )?;
    let pages = [
        "/",
        "/login",
        "/provider",
        "/provider-mailbox",
        "/register",
        "/forgot-password",
        "/complete",
        "/verify-email",
        "/console",
        "/console/callback",
    ];
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
async fn api(a: &mut Auth, path: &str, method: Method, b: &Value) -> Result<Value> {
    if let Some(op) = path.strip_prefix("/api/v1/authorization/") {
        if method == Method::Post
            && ["check", "activity", "allowed-actions", "spaces"].contains(&op)
        {
            return crate::authorization::authorize(a, op, b).await;
        }
    }
    if path == "/api/v1/auth/transactions" && method == Method::Post {
        return a.begin(b).await;
    }
    if path.starts_with("/api/v1/auth/transactions/") {
        match (path.rsplit('/').next().unwrap(), method) {
            ("context", Method::Get) => {
                let (t, c, _) = a.transaction().await?;
                return Ok(json!({"context":c,"status":t["status"]}));
            }
            ("password", Method::Post) => return a.login(b, false).await,
            ("signup", Method::Post) => return a.login(b, true).await,
            ("restore", Method::Post) => {
                fields(b, &[], &[])?;
                return a.restore().await;
            }
            ("confirmation", Method::Post) => {
                fields(b, &[], &[])?;
                return a.confirmation().await;
            }
            ("complete", Method::Post) => return a.complete(b, false).await,
            ("cancel", Method::Post) => return a.complete(b, true).await,
            _ => {
                return Err(Failure {
                    status: 409,
                    code: "EMAIL_FLOW_UNAVAILABLE",
                });
            }
        }
    }
    if let Some(tail) = path.strip_prefix("/api/v1/auth/providers/") {
        let parts: Vec<_> = tail.split('/').collect();
        if parts.len() == 2
            && ["google", "apple"].contains(&parts[0])
            && ["start", "bind"].contains(&parts[1])
            && method == Method::Post
        {
            fields(b, &[], &[])?;
            return crate::federation::start(a, parts[0], parts[1] == "bind").await;
        }
        return Err(Failure {
            status: 409,
            code: "PROVIDER_UNAVAILABLE",
        });
    }
    if path.starts_with("/api/v1/auth/") {
        return Err(Failure {
            status: 409,
            code: "EMAIL_FLOW_UNAVAILABLE",
        });
    }
    let p = a.principal(None).await?;
    ensure(
        contains(&p["scopes"], &json!("account")),
        403,
        "INVALID_SCOPE",
    )?;
    let relative = path.strip_prefix("/api/v1").unwrap_or(path);
    if relative.starts_with("/platform/") {
        return crate::platform::Platform::new(a, &p)?
            .route(relative, method, b)
            .await;
    }
    if relative == "/spaces"
        || relative.starts_with("/spaces/")
        || relative == "/invitations"
        || relative.starts_with("/invitations/")
    {
        return crate::teams::Teams::new(a, &p)
            .route(relative, method, b)
            .await;
    }
    crate::account::route(a, &p, relative, method, b).await
}
