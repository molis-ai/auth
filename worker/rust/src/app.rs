use crate::{
    auth,
    core::{http::*, identity::Auth},
    web,
};
use worker::{Env, Method, Request, Response, Url};

pub async fn handle(req: Request, env: Env) -> worker::Result<Response> {
    let id = web::http::request_id(&req);
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
    let url = req.url();
    let https = url.as_ref().is_ok_and(|url| url.scheme() == "https");
    let result = match url {
        Ok(url) => handle_response(req, &env, url, &log).await,
        Err(error) => Err(error),
    };
    let (response, error_code) = match result {
        Ok(outcome) => outcome,
        Err(error) => {
            let failure = Failure::from(error);
            log_failure(log.env, &id, log.route, "respond", &failure, log.started);
            let code = failure.code;
            let response = with_security_headers(error_response(failure, &id)?, &id, https)?;
            (response, Some(code.into()))
        }
    };
    log.finish(response.status_code(), error_code.as_deref());
    Ok(response)
}

async fn handle_response(
    req: Request,
    env: &Env,
    url: Url,
    log: &RequestLog<'_>,
) -> worker::Result<ResponseWithErrorCode> {
    let id = log.id;
    let path = url.path();
    let https = url.scheme() == "https";
    // `/internal/v1/*` belongs to the private Billing service binding (`AuthInternal` in
    // `runtime/entrypoint.js`), not the public fetch entrypoint. Reject it with 404 before
    // initializing `Auth` or touching D1 so public callers can never reach bridge routes.
    if path == "/internal/v1" || path.starts_with("/internal/v1/") {
        let failure = Failure {
            status: 404,
            code: "NOT_FOUND",
        };
        let response = with_security_headers(error_response(failure, id)?, id, https)?;
        return Ok((response, Some("NOT_FOUND".into())));
    }
    if req.inner().method() == "GET" && path == "/api/v1/health" {
        let response = with_security_headers(web::readiness::health_response(id)?, id, https)?;
        return Ok((response, None));
    }
    if path == web::telemetry::PATH {
        let (response, code) = match web::telemetry::ingest(req, env, &url, log).await {
            Ok(response) => (response, None),
            Err(failure) => {
                let code = failure.code;
                (error_response(failure, id)?, Some(code.into()))
            }
        };
        return Ok((with_security_headers(response, id, https)?, code));
    }
    let upstream = web::upstream::mount(path);
    let mut a = match Auth::new(req, env, log, None) {
        Ok(a) => a,
        Err(e) => {
            log_failure(log.env, id, log.route, "initialize", &e, log.started);
            let code = e.code;
            let response = web::http::render_error(e, id, upstream, None)?;
            let response = with_security_headers(response, id, https)?;
            return Ok((response, Some(code.into())));
        }
    };
    let result = dispatch(&mut a, env, url).await;
    let status = result
        .as_ref()
        .map_or_else(|e| e.status, |(response, _)| response.status_code());
    let retry_after = web::http::retry_after(status, a.retry_after_at.get());
    let (response, error_code) = match result {
        Ok(outcome) => outcome,
        Err(e) => {
            log_failure(log.env, id, log.route, "dispatch", &e, log.started);
            let code = e.code;
            let request = a
                .http()
                .map_err(|_| worker::Error::RustError("HTTP request missing".into()))?;
            let rate_limit = retry_after.map(|seconds| (request, seconds));
            (
                web::http::render_error(e, id, upstream, rate_limit)?,
                Some(code.into()),
            )
        }
    };
    let response = web::http::finalize_response(response, &a, id, retry_after)?;
    Ok((response, error_code))
}

async fn dispatch(a: &mut Auth, env: &Env, url: Url) -> Result<ResponseWithErrorCode> {
    let path = url.path();
    let method = a.http()?.method();
    if method == Method::Get
        && a.http()?.inner().method() != "GET"
        && (path == "/api/v1"
            || path.starts_with("/api/v1/")
            || auth::sync_read_proof::matches(path)
            || auth::management_handoff::matches(path))
    {
        return Err(Failure {
            status: 405,
            code: "METHOD_NOT_ALLOWED",
        });
    }

    let response = if auth::sync_read_proof::matches(path) {
        auth::sync_read_proof::route(a, path, method).await
    } else if auth::management_handoff::matches(path) {
        auth::management_handoff::route(a, path, method).await
    } else if web::web_session::matches(path) {
        return web::web_session::route(a, path, method).await;
    } else if path == "/api/v1/readiness" && method == Method::Get {
        web::readiness::check(a, env).await
    } else if path == "/api/v1" || path.starts_with("/api/v1/") {
        web::v1::route(a, path, method).await
    } else {
        web::assets::serve(a, env, url, method).await
    }?;
    Ok((response, None))
}
