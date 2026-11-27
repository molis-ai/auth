//! Route the central Auth endpoints from the public and browser entry points.

use crate::{
    account, audit, auth,
    core::{
        http::{Result, json_response},
        identity::Auth,
    },
    platform, team,
};
use serde_json::{Value, json};
use worker::{Method, Response};

pub(crate) async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    if auth::external_route(path) {
        return auth::external_login::browser(a, path, method).await;
    }
    let result = execute(a, path, method).await?;
    Ok(json_response(
        json!({"data":result,"requestId":a.request_id}),
        200,
    )?)
}

pub(crate) async fn execute(a: &mut Auth, path: &str, method: Method) -> Result<Value> {
    if platform::matches(path) {
        platform::route(a, path, method).await
    } else if audit::matches(path) {
        audit::route(a, path, method).await
    } else if team::matches(path) {
        team::route(a, path, method).await
    } else if account::matches(path) {
        account::route(a, path, method).await
    } else {
        auth::route(a, path, method).await
    }
}
