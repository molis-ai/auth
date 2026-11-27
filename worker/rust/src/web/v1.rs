//! Route typed Auth operations and decode public JSON requests at the HTTP boundary.
use crate::{
    account, audit, auth,
    core::{http::*, identity::Auth},
    platform, team,
};
use serde_json::{Value, json};
use worker::{Method, Response};

pub(super) struct CallInput<'a> {
    pub path: &'a str,
    pub method: Method,
    pub body: Value,
}

const WRITE_ROUTES: &[(Method, &str)] =
    include!(concat!(env!("OUT_DIR"), "/central_json_routes.rs"));

pub(crate) async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    if auth::external_route(path) {
        return auth::external_login::browser(a, path, method).await;
    }
    let body = if WRITE_ROUTES
        .iter()
        .any(|(verb, route)| *verb == method && matches_route_template(path, route))
    {
        let status = if platform::matches(path) || team::matches(path) {
            400
        } else {
            415
        };
        ensure(is_json_content_type(a), status, "INVALID_REQUEST")?;
        let limit = if path == "/api/v1/users/me/profile" {
            200_000
        } else {
            16_384
        };
        serde_json::from_str(&bounded(a.http_mut()?, limit).await?)?
    } else {
        json!({})
    };
    let result = execute(a, CallInput { path, method, body }).await?;
    Ok(json_response(
        json!({"data":result,"requestId":a.request_id}),
        200,
    )?)
}

pub(super) async fn execute(a: &Auth, input: CallInput<'_>) -> Result<Value> {
    let CallInput { path, method, body } = input;
    if platform::matches(path) {
        platform::route(a, path, method, body).await
    } else if audit::matches(path) {
        audit::route(a, path, method).await
    } else if team::matches(path) {
        team::route(a, path, method, body).await
    } else if account::matches(path) {
        account::route(a, path, method, body).await
    } else {
        auth::route(a, path, method, body).await
    }
}
