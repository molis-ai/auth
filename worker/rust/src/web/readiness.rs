//! Worker probes. Readiness checks the dependencies of the account console.
use crate::core::{http::*, identity::Auth};
use serde_json::json;
use worker::{Env, Response};

pub(crate) fn health_response(id: &str) -> worker::Result<Response> {
    json_response(
        json!({"data":{"status":"UP","runtime":"cloudflare","backend":"rust"},"requestId":id}),
        200,
    )
}

pub(crate) async fn check(a: &Auth, env: &Env) -> Result<Response> {
    ensure(env.var("MOLIS_LOCAL_GENERATION").is_ok(), 404, "NOT_FOUND")?;
    for query in include_str!("../core/schema-readiness.sql")
        .split(';')
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
    {
        a.s.all(query, vec![]).await?;
    }
    if env.var("MOLIS_ENVIRONMENT").is_ok() {
        let client = crate::web::web_session::setting(a, "AUTH_WEB_CLIENT_ID")?;
        let registration = crate::auth::login_sessions::registered_client(a, &client).await?;
        ensure(
            contains(
                &parsed(&registration, "redirects")?,
                &json!(format!("{}/account/callback", a.origin)),
            ) && contains(&parsed(&registration, "allowed_origins")?, &json!(a.origin)),
            503,
            "UNIFIED_CONFIGURATION_INVALID",
        )?;
        crate::auth::test_admission::Admission::load(a)?;
        ensure(
            crate::auth::login_capabilities::available(a, &registration).len() == 5
                && token(&crate::web::web_session::setting(
                    a,
                    "AUTH_WEB_SESSION_KEY",
                )?),
            503,
            "UNIFIED_CONFIGURATION_INVALID",
        )?;
    }
    Ok(health_response(&a.request_id)?)
}
