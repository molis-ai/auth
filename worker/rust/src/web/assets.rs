//! Dynamic HTML entry points for the browser console.
use crate::core::{http::*, identity::Auth};
use serde_json::Value;
use worker::{Env, Method, Request, Response, Url};

pub(crate) async fn serve(a: &Auth, env: &Env, url: Url, method: Method) -> Result<Response> {
    let path = url.path();
    ensure(
        matches!(path, "/" | "/login" | "/console"),
        404,
        "NOT_FOUND",
    )?;
    ensure(
        // The SDK maps unrecognized HTTP methods to GET.
        matches!(a.http()?.inner().method().as_str(), "GET" | "HEAD"),
        405,
        "METHOD_NOT_ALLOWED",
    )?;
    // Documents use the configured origin before cookies or login forms are created.
    // API writes retain their strict Origin and CSRF checks.
    if url.origin().ascii_serialization() != a.origin {
        let mut canonical = Request::new(&a.origin, Method::Get)?.url()?;
        canonical.set_path(path);
        canonical.set_query(url.query());
        let mut response = Response::empty()?.with_status(302);
        response.headers_mut().set("Location", canonical.as_str())?;
        response.headers_mut().set("Cache-Control", "no-store")?;
        return Ok(response);
    }
    let mut target = url.clone();
    // This file lives under a Worker-first route so the raw HTML cannot be fetched publicly.
    target.set_path("/account/index.html");
    target.set_query(None);
    let mut r = env
        .assets("ASSETS")?
        .fetch_request(Request::new(target.as_str(), method.clone())?)
        .await?;
    // Asset responses have immutable headers; copy them before adding our security policy.
    let headers = worker::Headers::new();
    for (key, value) in r.headers().entries() {
        if !key.eq_ignore_ascii_case("CF-Cache-Status") {
            headers.set(&key, &value)?;
        }
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
    let mut r = if method == Method::Get && r.status_code() == 200 {
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
    r.headers_mut().set("Cache-Control", "no-store")?;
    Ok(r)
}
