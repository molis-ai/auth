//! Public HTTP response policy and request log labels.
use super::upstream::{self, Mount};
use crate::core::{
    http::*,
    identity::{Auth, DEFAULT_RETRY_AFTER, retry_after_seconds},
    security::uuid,
};
use serde_json::json;
use worker::{Request, Response};

pub(crate) fn request_id(request: &Request) -> String {
    if upstream::mount(&request.path()).is_some() {
        internal_request_id(request)
    } else {
        uuid()
    }
}

// Normalize concrete URLs (containing IDs or asset hashes) into bounded route templates
// for structured request logs and metrics without pulling in a full web router framework.
pub(crate) fn log_route(path: &str) -> &'static str {
    static ROUTES: &[&str] = include!(concat!(env!("OUT_DIR"), "/log_routes.rs"));
    if let Some(mount) = upstream::mount(path) {
        return mount.log_route;
    }
    match path {
        "/api/v1/health" => "/api/v1/health",
        "/api/v1/readiness" => "/api/v1/readiness",
        "/api/v1/auth/sync-read-proof" => "/api/v1/auth/sync-read-proof",
        "/.well-known/molis-sync-jwks.json" => "/.well-known/molis-sync-jwks.json",
        "/account/handoff/start" => "/account/handoff/start",
        "/account/handoff/finish" => "/account/handoff/finish",
        "/api/account/login-sessions" => "/api/account/login-sessions",
        "/account/callback" => "/account/callback",
        "/" | "/login" | "/console" => "/",
        _ if path.starts_with("/auth-ui/") => "/auth-ui/{asset}",
        _ => ROUTES
            .iter()
            .copied()
            .find(|template| matches_route_template(path, template))
            .unwrap_or("unmatched"),
    }
}

pub(crate) fn retry_after(status: u16, retry_after_at: Option<i64>) -> Option<u64> {
    (status == 429).then(|| {
        retry_after_at
            .map(|expires_at| retry_after_seconds(expires_at, now()))
            .unwrap_or(DEFAULT_RETRY_AFTER)
    })
}

pub(crate) fn render_error(
    error: Failure,
    id: &str,
    upstream: Option<&Mount>,
    rate_limit: Option<(&Request, u64)>,
) -> worker::Result<Response> {
    if let Some((_, seconds)) = rate_limit.filter(|(request, _)| {
        let path = request.path();
        path.starts_with("/api/v1/") || path.starts_with("/api/account/")
    }) {
        json_response(
            json!({"error":{"code":error.code,"retryAfterSeconds":seconds},"requestId":id}),
            429,
        )
    } else if let Some(mount) = upstream {
        mount.error_response(error, id)
    } else {
        error_response(error, id)
    }
}

pub(crate) fn finalize_response(
    mut response: Response,
    a: &Auth,
    id: &str,
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
    }
    with_security_headers(response, id, a.origin.starts_with("https:"))
}
