//! Same-origin mounts for authenticated upstream requests.
use crate::core::{http::*, identity::Auth};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use worker::{Response, web_sys};

#[wasm_bindgen(module = "/src/runtime/internal-transport.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = upstreamFetch)]
    async fn upstream_fetch(
        env: &JsValue,
        input: &JsValue,
    ) -> std::result::Result<web_sys::Response, JsValue>;
}

pub(crate) struct Mount {
    prefix: &'static str,
    service: &'static str,
    pub(crate) log_route: &'static str,
    unavailable: &'static str,
    unavailable_message: &'static str,
}

const MOUNTS: &[Mount] = &[Mount {
    prefix: "/api/account/billing",
    service: "BILLING",
    log_route: "/api/account/billing/*",
    unavailable: "BILLING_UNAVAILABLE",
    unavailable_message: "Billing service unavailable",
}];

impl Mount {
    fn suffix<'a>(&self, path: &'a str) -> Option<&'a str> {
        path.strip_prefix(self.prefix)
            .filter(|suffix| suffix.is_empty() || suffix.starts_with('/'))
    }

    fn unavailable(&self) -> Failure {
        Failure {
            status: 503,
            code: self.unavailable,
        }
    }

    pub(crate) fn error_response(
        &self,
        mut failure: Failure,
        id: &str,
    ) -> worker::Result<Response> {
        let message = match failure.code {
            "LOGIN_REQUIRED" | "INVALID_CREDENTIALS" | "UNAUTHENTICATED" => {
                failure.code = "UNAUTHENTICATED";
                "Authentication required"
            }
            "UNIFIED_CONFIGURATION_INVALID" => {
                failure.code = "AUTH_UNAVAILABLE";
                "Identity service unavailable"
            }
            "AUTH_UNAVAILABLE" => "Identity service unavailable",
            "INVALID_REQUEST" => "Invalid request",
            "SESSION_EXPIRED" => "Session expired",
            "FORBIDDEN" => "Access denied",
            "NOT_FOUND" => "Resource not found",
            "METHOD_NOT_ALLOWED" => "Method not allowed",
            "VERSION_CONFLICT" => "Concurrent update",
            code if code == self.unavailable => self.unavailable_message,
            _ => "Request failed",
        };
        json_response(
            json!({"error":{"code":failure.code,"message":message},"requestId":id}),
            failure.status,
        )
    }
}

pub(crate) fn mount(path: &str) -> Option<&'static Mount> {
    MOUNTS.iter().find(|mount| mount.suffix(path).is_some())
}

pub(super) struct Target<'a> {
    mount: &'static Mount,
    suffix: &'a str,
    method: String,
}

impl<'a> Target<'a> {
    pub(super) fn parse(path: &'a str, method: impl FnOnce() -> String) -> Result<Option<Self>> {
        let Some((mount, suffix)) = MOUNTS.iter().find_map(|m| m.suffix(path).map(|s| (m, s)))
        else {
            return Ok(None);
        };
        ensure(
            suffix.len() > 1
                && !suffix.contains("//")
                && suffix
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"/-._~".contains(&c))
                && !suffix.split('/').any(|part| matches!(part, "." | "..")),
            404,
            "NOT_FOUND",
        )?;
        let method = method();
        ensure(
            matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE"),
            405,
            "METHOD_NOT_ALLOWED",
        )?;
        Ok(Some(Self {
            mount,
            suffix,
            method,
        }))
    }

    pub(super) async fn body(a: &mut Auth) -> Result<Option<String>> {
        if a.http()?.inner().body().is_none() {
            return Ok(None);
        }
        let body = bounded(a.http_mut()?, 16 * 1024).await?;
        if body.is_empty() {
            return Ok(None);
        }
        ensure(is_json_content_type(a), 400, "INVALID_REQUEST")?;
        // Keep the original JSON, including duplicate keys, for the upstream parser.
        serde_json::from_str::<Value>(&body)?;
        Ok(Some(body))
    }

    pub(super) async fn call(&self, a: &Auth, access: &str, body: Option<&str>) -> Result<Reply> {
        let started = now();
        let result = self.call_inner(a, access, body).await;
        let (status, error_code) = match &result {
            Ok(reply) => (reply.status, reply.error_code().unwrap_or("none")),
            Err(failure) => (failure.status, failure.code),
        };
        log_event(
            "auth.upstream.request",
            log_env(&a.env),
            &a.request_id,
            [
                ("upstream", json!("molis-billing")),
                ("route", json!(billing_route(self.suffix))),
                ("method", json!(self.method)),
                ("status", json!(status)),
                ("error_code", json!(error_code)),
                (
                    "outcome",
                    json!(if status < 400 { "success" } else { "failed" }),
                ),
                ("duration_ms", json!((now() - started).max(0))),
            ],
            status >= 500,
        );
        result
    }

    async fn call_inner(&self, a: &Auth, access: &str, body: Option<&str>) -> Result<Reply> {
        let key = a.http()?.headers().get("Idempotency-Key")?;
        ensure(key.as_deref().is_none_or(valid_id), 400, "INVALID_REQUEST")?;
        ensure(token(access), 401, "SESSION_EXPIRED")?;
        let mut input = json!({
            "service": self.mount.service, "path": format!("/api/v1{}", self.suffix),
            "method": self.method, "requestId": a.request_id, "accessToken": access,
        });
        if let Some(query) = a.http()?.url()?.query() {
            input["query"] = json!(query);
        }
        if let Some(body) = body {
            input["body"] = json!(body);
            input["contentType"] = json!(a.header("Content-Type"));
        }
        if let Some(key) = key {
            input["idempotencyKey"] = json!(key);
        }
        let unavailable = || self.mount.unavailable();
        let input = js_sys::JSON::parse(&input.to_string()).map_err(|_| unavailable())?;
        let mut response = Response::from(
            upstream_fetch(a.env.as_ref(), &input)
                .await
                .map_err(|_| unavailable())?,
        );
        let status = response.status_code();
        let stream = response.stream().map_err(|_| unavailable())?;
        let raw = bounded_stream(stream, 256 * 1024)
            .await
            .map_err(|_| unavailable())?;
        let mut data: Value = serde_json::from_str(&raw).map_err(|_| unavailable())?;
        let shared = a
            .env
            .secret("MOLIS_INTERNAL_SECRET")
            .ok()
            .map(|s| s.to_string());
        let contains_credentials = |value: &str| {
            value.contains(access)
                || shared
                    .as_deref()
                    .is_some_and(|secret| !secret.is_empty() && value.contains(secret))
        };
        let envelope = match status {
            200..=299 if data["data"].is_object() && data.get("error").is_none() => {
                let data = data["data"].take();
                ensure(
                    !contains_credentials(&data.to_string()),
                    503,
                    self.mount.unavailable,
                )?;
                json!({"data":data,"requestId":a.request_id})
            }
            400..=599 if data.get("data").is_none() => {
                let code = data["error"]["code"]
                    .as_str()
                    .filter(|code| valid_code(code) && !contains_credentials(code))
                    .ok_or_else(unavailable)?;
                if status == 503 && code == "UPSTREAM_UNAVAILABLE" {
                    return Err(unavailable());
                }
                let message: String = data["error"]["message"]
                    .as_str()
                    .filter(|message| {
                        !contains_credentials(message) && !message.contains("Bearer ")
                    })
                    .unwrap_or_default()
                    .chars()
                    .filter(|c| !c.is_control() && !matches!(c, '<' | '>'))
                    .take(256)
                    .collect();
                let message = message.trim();
                json!({"error":{"code":code,"message":if message.is_empty() { "Request failed" } else { message }},"requestId":a.request_id})
            }
            _ => return Err(unavailable()),
        };
        Ok(Reply { status, envelope })
    }
}

fn billing_route(suffix: &str) -> &'static str {
    const ROLES: &[(&str, &str)] = &[
        ("/catalog/plans", "/api/v1/catalog/plans"),
        ("/subscriptions", "/api/v1/subscriptions"),
        ("/orders", "/api/v1/orders"),
        ("/orders/{id}", "/api/v1/orders/{id}"),
        ("/orders/{id}/mock-pay", "/api/v1/orders/{id}/mock-pay"),
        ("/orders/{id}/refund", "/api/v1/orders/{id}/refund"),
        ("/credits/balance", "/api/v1/credits/balance"),
        ("/credits/ledger", "/api/v1/credits/ledger"),
        ("/entitlements/check", "/api/v1/entitlements/check"),
    ];
    ROLES
        .iter()
        .find_map(|(pattern, route)| matches_route_template(suffix, pattern).then_some(*route))
        .unwrap_or("unmatched")
}

fn valid_code(code: &str) -> bool {
    (2..=64).contains(&code.len())
        && code.as_bytes()[0].is_ascii_uppercase()
        && code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

pub(super) struct Reply {
    pub(super) status: u16,
    envelope: Value,
}
impl Reply {
    pub(super) fn error_code(&self) -> Option<&str> {
        self.envelope["error"]["code"].as_str()
    }

    pub(super) fn response(self) -> Result<Response> {
        Ok(json_response(self.envelope, self.status)?)
    }
}
