use crate::{
    account, audit, auth, billing,
    core::{http::*, identity::Auth, store::WebSessionAccess},
    platform, tenants, web,
};
use worker::{Env, Method, Request, Response, Url};

enum CallMode {
    External,
    Internal {
        access: WebSessionAccess,
        client_ip: String,
    },
}

pub async fn handle(req: Request, env: Env) -> worker::Result<Response> {
    let id = web::http::request_id(&req);
    let (response, _) = handle_inner(req, env, CallMode::External, id).await?;
    Ok(response)
}

pub(crate) async fn handle_internal(
    req: Request,
    env: Env,
    access: WebSessionAccess,
    client_ip: String,
    request_id: String,
) -> worker::Result<(Response, Option<i64>)> {
    Box::pin(handle_inner(
        req,
        env,
        CallMode::Internal { access, client_ip },
        request_id,
    ))
    .await
}

async fn handle_inner(
    req: Request,
    env: Env,
    mode: CallMode,
    id: String,
) -> worker::Result<(Response, Option<i64>)> {
    let method = req.method();
    let log = RequestLog {
        started: now(),
        env: log_env(&env),
        id: &id,
        route: web::http::log_route(&req.path()),
        // The SDK maps unknown methods to GET. Keep the actual outcome label bounded.
        method: if method == Method::Get && req.inner().method() != "GET" {
            "OTHER"
        } else {
            method.as_ref()
        },
    };
    let external = matches!(mode, CallMode::External);
    let url = req.url();
    let https = url.as_ref().is_ok_and(|url| url.scheme() == "https");
    let result = match url {
        Ok(url) => handle_response(req, &env, url, mode, &log).await,
        Err(error) => Err(error),
    };
    let (response, retry_after_at, error_code) = match result {
        Ok(outcome) => outcome,
        Err(error) if external => {
            let failure = Failure::from(error);
            log_failure(log.env, &id, log.route, "respond", &failure, log.started);
            let code = failure.code;
            let response = with_security_headers(error_response(failure, &id)?, &id, https)?;
            (response, None, Some(code))
        }
        Err(error) => return Err(error),
    };
    if external {
        log.finish(response.status_code(), error_code);
    }
    Ok((response, retry_after_at))
}

async fn handle_response(
    req: Request,
    env: &Env,
    url: Url,
    mode: CallMode,
    log: &RequestLog<'_>,
) -> worker::Result<(Response, Option<i64>, Option<&'static str>)> {
    let id = log.id;
    let path = url.path();
    let https = url.scheme() == "https";
    if path == "/internal/v1" || path.starts_with("/internal/v1/") {
        let failure = Failure {
            status: 404,
            code: "NOT_FOUND",
        };
        let response = with_security_headers(error_response(failure, id)?, id, https)?;
        return Ok((response, None, Some("NOT_FOUND")));
    }
    if req.method() == Method::Get && path == "/api/v2/health" {
        let response = with_security_headers(web::readiness::health_response(id)?, id, https)?;
        return Ok((response, None, None));
    }
    let (external, access, client_ip) = match mode {
        CallMode::External => (true, None, None),
        CallMode::Internal { access, client_ip } => (false, Some(access), Some(client_ip)),
    };
    let is_billing = web::billing::matches(path);
    let mut a = match Auth::new(req, env, log, client_ip) {
        Ok(a) => a,
        Err(e) => {
            log_failure(log.env, id, log.route, "initialize", &e, log.started);
            let code = e.code;
            let response = web::http::render_error(e, id, is_billing, None)?;
            let response = with_security_headers(response, id, https)?;
            return Ok((response, None, Some(code)));
        }
    };
    a.s.web_session_access = access;
    let result = dispatch(&mut a, env, url).await;
    // BFF requests pass the deadline through to the public response.
    let retry_after_at = a.retry_after_at.get();
    let status = result
        .as_ref()
        .map_or_else(|e| e.status, Response::status_code);
    let retry_after = web::http::retry_after(external, status, retry_after_at);
    let (response, error_code) = match result {
        Ok(response) => (response, None),
        Err(e) => {
            let phase = if external { "dispatch" } else { "internal" };
            log_failure(log.env, id, log.route, phase, &e, log.started);
            let code = e.code;
            let rate_limit = retry_after.map(|seconds| (&a.request, seconds));
            (
                web::http::render_error(e, id, is_billing, rate_limit)?,
                Some(code),
            )
        }
    };
    let response = web::http::finalize_response(response, &a, id, external, status, retry_after)?;
    Ok((response, retry_after_at, error_code))
}

async fn dispatch(a: &mut Auth, env: &Env, url: Url) -> Result<Response> {
    let path = url.path();
    let method = a.request.method();

    if auth::sync_read_proof::matches(path) {
        return auth::sync_read_proof::route(a, path, method).await;
    }
    if auth::management_handoff::matches(path) {
        return auth::management_handoff::route(a, path, method).await;
    }
    if web::web_session::matches(path) {
        return web::web_session::route(a, path, method).await;
    }
    if path == "/api/v2/readiness" && method == Method::Get {
        return web::readiness::check(a, env).await;
    }
    if path == "/api/v2" || path.starts_with("/api/v2/") {
        return dispatch_v2(a, path, method).await;
    }
    web::assets::serve(a, env, url, method).await
}

async fn dispatch_v2(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    if platform::matches(path) {
        platform::route(a, path, method).await
    } else if audit::matches(path) {
        audit::route(a, path, method).await
    } else if billing::matches(path) {
        billing::route(a, path, method).await
    } else if tenants::matches(path) {
        tenants::route(a, path, method).await
    } else if account::matches(path) {
        account::route(a, path, method).await
    } else {
        auth::route(a, path, method).await
    }
}
