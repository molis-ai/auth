//! Same-origin browser telemetry without session initialization or D1 access.
use serde_json::{Value, json};
use worker::{Env, Request, Response, Url, WorkerVersionMetadata};

use crate::core::http::{Failure, RequestLog, Result, bounded, ensure};

pub(crate) const PATH: &str = "/api/account/telemetry";
const MAX_BODY: usize = 8192;
const MAX_EVENTS: usize = 16;
const ENDPOINTS: &[&str] = &[
    "/session",
    "/auth/login/password",
    "/auth/login/code",
    "/auth/verification-codes",
    "/auth/transactions",
    "/tenants",
    "/tenant-creation-policy",
    "/login-methods",
    "/billing/catalog/plans",
    "/billing/subscriptions",
    "/billing/orders",
    "/billing/orders/{id}",
    "/billing/orders/{id}/mock-pay",
    "/billing/orders/{id}/refund",
    "/billing/credits/balance",
    "/billing/credits/ledger",
    "other",
];
const CODES: &[&str] = &[
    "AUTH_UNAVAILABLE",
    "BILLING_UNAVAILABLE",
    "INVALID_RESPONSE",
    "NETWORK_ERROR",
    "TIMEOUT",
    "RATE_LIMITED",
    "NOT_FOUND",
    "FORBIDDEN",
    "SESSION_EXPIRED",
    "UNAUTHENTICATED",
    "OTHER",
];

thread_local! {
    static BUDGET: std::cell::Cell<(i64, u32)> = const { std::cell::Cell::new((0, 0)) };
}

fn take_budget(started: i64) -> bool {
    let minute = started / 60_000;
    BUDGET.with(|budget| {
        let (previous, count) = budget.get();
        let count = if previous == minute { count } else { 0 };
        if count >= 120 {
            return false;
        }
        budget.set((minute, count + 1));
        true
    })
}

fn pick(value: &Value, key: &str, allowed: &[&str]) -> Option<Value> {
    let item = value[key].as_str()?;
    allowed.contains(&item).then(|| json!(item))
}

fn number(value: &Value, key: &str, max: f64) -> Option<Value> {
    let number = value[key].as_f64()?;
    (0.0..=max).contains(&number).then(|| json!(number))
}

type Fields = Vec<(&'static str, Value)>;

fn normalize(input: &Value) -> Option<(&'static str, Fields)> {
    let page = || pick(input, "page", &["login", "account"]);
    let view = || {
        pick(
            input,
            "view",
            &[
                "login", "account", "billing", "team", "security", "platform",
            ],
        )
    };
    let endpoint = || pick(input, "endpoint", ENDPOINTS);
    let provider = || pick(input, "provider", &["google", "github"]);
    Some(match input["kind"].as_str()? {
        "vital" => {
            let metric = pick(input, "metric", &["TTFB", "FCP", "LCP", "INP", "CLS"])?;
            let max = if metric == "CLS" { 100.0 } else { 120_000.0 };
            (
                "auth.web.vital",
                vec![
                    ("page", page()?),
                    ("metric", metric),
                    ("value", number(input, "value", max)?),
                ],
            )
        }
        "error" => (
            "auth.web.error",
            vec![
                ("view", view()?),
                (
                    "kind",
                    pick(
                        input,
                        "error_kind",
                        &["js_error", "unhandled_rejection", "vue_error", "chunk_load"],
                    )?,
                ),
                (
                    "name",
                    pick(
                        input,
                        "name",
                        &[
                            "Error",
                            "TypeError",
                            "ReferenceError",
                            "RangeError",
                            "SyntaxError",
                            "AbortError",
                            "ChunkLoadError",
                            "Other",
                        ],
                    )?,
                ),
            ],
        ),
        "oauth_popup" => (
            "auth.web.oauth_popup",
            vec![
                ("provider", provider()?),
                (
                    "outcome",
                    pick(
                        input,
                        "outcome",
                        &[
                            "started",
                            "completed",
                            "closed",
                            "blocked",
                            "retry_started",
                            "failed",
                        ],
                    )?,
                ),
            ],
        ),
        "api_issue" => {
            let status = input["status"].as_u64()?;
            if status != 0 && !(400..600).contains(&status) {
                return None;
            }
            (
                "auth.web.api_issue",
                vec![
                    ("endpoint", endpoint()?),
                    ("status", json!(status)),
                    ("error_code", pick(input, "error_code", CODES)?),
                    ("degraded", json!(input["degraded"].as_bool()?)),
                    ("duration_ms", number(input, "duration_ms", 120_000.0)?),
                ],
            )
        }
        "cache" => {
            let hits = input["hits"].as_u64()?;
            let misses = input["misses"].as_u64()?;
            if hits > 1000 || misses > 1000 || hits + misses == 0 {
                return None;
            }
            (
                "auth.web.cache",
                vec![
                    ("endpoint", endpoint()?),
                    ("hits", json!(hits)),
                    ("misses", json!(misses)),
                ],
            )
        }
        "session" => (
            "auth.web.session",
            vec![
                ("page", page()?),
                ("outcome", pick(input, "outcome", &["clean", "error"])?),
            ],
        ),
        _ => return None,
    })
}

fn is_request_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(position, byte)| {
            if matches!(position, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

pub(crate) async fn ingest(
    mut request: Request,
    env: &Env,
    url: &Url,
    log: &RequestLog<'_>,
) -> Result<Response> {
    ensure(
        request.inner().method() == "POST",
        405,
        "METHOD_NOT_ALLOWED",
    )?;
    let origin = env.var("AUTH_ORIGIN")?.to_string();
    ensure(
        origin == url.origin().ascii_serialization()
            && request.headers().get("Origin")?.as_deref() == Some(origin.as_str())
            && request.headers().get("Sec-Fetch-Site")?.as_deref() == Some("same-origin"),
        403,
        "FORBIDDEN",
    )?;
    ensure(
        url.query().is_none()
            && request.headers().get("Content-Type")?.is_some_and(|mime| {
                mime.split(';')
                    .next()
                    .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
            }),
        400,
        "INVALID_REQUEST",
    )?;
    if !take_budget(log.started) {
        return Ok(Response::empty()?.with_status(204));
    }
    let body = bounded(&mut request, MAX_BODY).await?;
    let rows: Vec<Value> = serde_json::from_str(&body)?;
    ensure(
        !rows.is_empty() && rows.len() <= MAX_EVENTS,
        400,
        "INVALID_REQUEST",
    )?;
    let events = rows
        .iter()
        .map(normalize)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(Failure::invalid_request)?;
    let release = env
        .get_binding::<WorkerVersionMetadata>("AUTH_VERSION_METADATA")
        .ok()
        .map(|metadata| metadata.id())
        .unwrap_or_else(|| "unknown".into());
    for (row, (event, fields)) in rows.iter().zip(events) {
        let parent = row["parent_request_id"]
            .as_str()
            .filter(|value| is_request_id(value));
        crate::core::http::log_event(
            event,
            log.env,
            parent.unwrap_or(log.id),
            fields.into_iter().chain([("release", json!(release))]),
            false,
        );
    }
    Ok(Response::empty()?.with_status(204))
}

#[cfg(test)]
mod tests {
    use super::normalize;
    use serde_json::json;

    #[test]
    fn browser_fields_are_allowlisted_and_sensitive_payloads_are_dropped() {
        let result = normalize(
            &json!({"kind":"error","error_kind":"js_error","name":"TypeError","view":"billing","stack":"private","env":"prod"}),
        );
        let Some((name, fields)) = result else {
            panic!("expected a valid event");
        };
        assert_eq!(name, "auth.web.error");
        assert_eq!(fields.len(), 3);
        assert!(normalize(&json!({"kind":"api_issue","endpoint":"/billing/orders/private-id","status":503,"error_code":"BILLING_UNAVAILABLE","degraded":true,"duration_ms":2})).is_none());
        assert!(
            normalize(&json!({"kind":"vital","page":"login","metric":"LCP","value":-1})).is_none()
        );
    }
}
