//! Public HTTP response policy and request log labels.
use super::billing;
use crate::core::{
    http::*,
    identity::{Auth, DEFAULT_RETRY_AFTER, retry_after_seconds},
    security::uuid,
};
use serde_json::json;
use worker::{Request, Response};

pub(crate) fn request_id(request: &Request) -> String {
    if billing::matches(&request.path()) {
        billing_request_id(request)
    } else {
        uuid()
    }
}

pub(crate) fn log_route(path: &str) -> &'static str {
    static ROUTES: &[&str] = include!(concat!(env!("OUT_DIR"), "/log_routes.rs"));
    match path {
        "/api/v2/health" => "/api/v2/health",
        "/api/v2/readiness" => "/api/v2/readiness",
        "/api/v2/auth/sync-read-proof" => "/api/v2/auth/sync-read-proof",
        "/.well-known/molis-sync-jwks.json" => "/.well-known/molis-sync-jwks.json",
        "/account/handoff/start" => "/account/handoff/start",
        "/account/handoff/finish" => "/account/handoff/finish",
        "/api/account/login-sessions" => "/api/account/login-sessions",
        "/account/callback" => "/account/callback",
        _ if billing::matches(path) => "/api/account/billing/*",
        "/" | "/login" | "/console" => "/",
        _ if path.starts_with("/auth-ui/") => "/auth-ui/{asset}",
        _ => ROUTES
            .iter()
            .copied()
            .find(|template| matches_route_template(path, template))
            .unwrap_or("unmatched"),
    }
}

pub(crate) fn retry_after(external: bool, status: u16, retry_after_at: Option<i64>) -> Option<u64> {
    (external && status == 429).then(|| {
        retry_after_at
            .map(|expires_at| retry_after_seconds(expires_at, now()))
            .unwrap_or(DEFAULT_RETRY_AFTER)
    })
}

pub(crate) fn render_error(
    error: Failure,
    id: &str,
    is_billing: bool,
    rate_limit: Option<(&Request, u64)>,
) -> worker::Result<Response> {
    if let Some((_, seconds)) = rate_limit.filter(|(request, _)| {
        let path = request.path();
        path.starts_with("/api/v2/") || path.starts_with("/api/account/")
    }) {
        json_response(
            json!({"error":{"code":error.code,"retryAfterSeconds":seconds},"requestId":id}),
            429,
        )
    } else if is_billing {
        billing::error_response(error, id)
    } else {
        error_response(error, id)
    }
}

pub(crate) fn finalize_response(
    mut response: Response,
    a: &Auth,
    id: &str,
    external: bool,
    status: u16,
    retry_after: Option<u64>,
) -> worker::Result<Response> {
    if response.status_code() < 400 {
        for c in &a.cookies {
            response.headers_mut().append("Set-Cookie", c)?;
        }
    }
    if let Some(retry_after) = retry_after {
        response
            .headers_mut()
            .set("Retry-After", &retry_after.to_string())?;
    } else if external && status == 409 && a.retry_browser_read {
        response.headers_mut().set("Retry-After", "0")?;
    }
    with_security_headers(response, id, a.origin.starts_with("https:"))
}
