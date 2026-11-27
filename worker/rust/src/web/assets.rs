//! HTML and static assets for the browser console.
use crate::core::{http::*, identity::Auth};
use serde_json::Value;
use worker::{Env, Method, Request, Response, Url};

pub(crate) async fn serve(a: &Auth, env: &Env, url: Url, method: Method) -> Result<Response> {
    let path = url.path();
    ensure(
        !path.starts_with("/api/")
            && !path.starts_with("/oauth2/")
            && !path.starts_with("/.well-known/"),
        404,
        "NOT_FOUND",
    )?;
    ensure(
        // The SDK maps unrecognized HTTP methods to GET.
        matches!(a.request.inner().method().as_str(), "GET" | "HEAD"),
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
    let asset = path.strip_prefix("/auth-ui/assets/");
    if page {
        target.set_path("/index.html");
    } else if asset.is_none() {
        target.set_path(&path[8..]);
    }
    target.set_query(None);
    let mut r = env
        .assets("ASSETS")?
        .fetch_request(Request::new(target.as_str(), method.clone())?)
        .await?;
    let content_type = r.headers().get("Content-Type")?.unwrap_or_default();
    let media_type = content_type.split(';').next().unwrap_or_default().trim();
    // An assets binding configured with SPA fallback can return HTML for a missing asset.
    ensure(
        asset.is_none() || !media_type.eq_ignore_ascii_case("text/html"),
        404,
        "NOT_FOUND",
    )?;
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
    let mut r = if page && method == Method::Get && r.status_code() == 200 {
        let config = a.unified_config.as_deref().unwrap_or(&Value::Null);
        let channels = if crate::delivery::supports_invitation_notifications(
            &config["kind"],
            &config["deliveryMode"],
        ) {
            "EMAIL PHONE"
        } else {
            "EMAIL"
        };
        let mut metadata =
            format!("<meta name=\"molis-tenant-invite-channels\" content=\"{channels}\">");
        if !label.is_empty() {
            metadata.push_str(&format!(
                "<meta name=\"molis-environment\" content=\"{label}\">"
            ));
        }
        let body = r
            .text()
            .await?
            .replacen("</head>", &format!("{metadata}</head>"), 1);
        headers.delete("Content-Length")?;
        headers.delete("Content-Encoding")?;
        headers.delete("ETag")?;
        Response::from_html(body)?.with_headers(headers)
    } else {
        r.with_headers(headers)
    };
    if page || (asset.is_some() && r.status_code() >= 400) {
        r.headers_mut().set("Cache-Control", "no-store")?;
    } else if r.status_code() == 200 && asset.is_some_and(|name| hashed_web_asset(name, media_type))
    {
        r.headers_mut()
            .set("Cache-Control", "public, max-age=31536000, immutable")?;
    }
    Ok(r)
}
fn hashed_web_asset(name: &str, media_type: &str) -> bool {
    let Some((base, extension)) = name.rsplit_once('.') else {
        return false;
    };
    // Only Vite's generated output from web/vite.config.ts is published under auth-ui/assets/.
    let Some((prefix, hash)) = base.split_at_checked(base.len().saturating_sub(8)) else {
        return false;
    };
    if !prefix.ends_with('-')
        || prefix.len() == 1
        || prefix.contains('/')
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return false;
    }
    match extension {
        "js" => media_type == "text/javascript" || media_type == "application/javascript",
        "css" => media_type == "text/css",
        "png" => media_type == "image/png",
        _ => false,
    }
}
