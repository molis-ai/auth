//! User-facing Work Billing routes for the Auth web session.
use crate::{http::*, identity::Auth, web::web_session::WebSession};
use serde_json::{Map, Value, json};
use wasm_bindgen::prelude::*;
use worker::{Response, web_sys};

const PREFIX: &str = "/api/account/billing";

#[wasm_bindgen(module = "/src/runtime/billing-transport.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = billingFetch)]
    async fn billing_fetch(
        env: &JsValue,
        input: &JsValue,
    ) -> std::result::Result<web_sys::Response, JsValue>;
}

pub(crate) fn matches(path: &str) -> bool {
    path.strip_prefix(PREFIX)
        .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with('/'))
}

#[derive(Clone, Copy)]
enum Operation {
    Read,
    Page,
    Create,
    OrderAction,
    Entitlement,
}

pub(super) struct Route<'a> {
    suffix: &'a str,
    method: &'static str,
    operation: Operation,
}

impl<'a> Route<'a> {
    pub(super) fn parse(path: &'a str, method: &str) -> Result<Self> {
        use Operation::*;
        let suffix = path.strip_prefix(PREFIX).unwrap_or_default();
        let parts: Vec<_> = suffix.split('/').collect();
        let (required, operation) = match parts.as_slice() {
            ["", "catalog", "plans"] | ["", "subscriptions"] | ["", "credits", "balance"] => {
                ("GET", Read)
            }
            ["", "orders"] if method == "POST" => ("POST", Create),
            ["", "orders"] | ["", "credits", "ledger"] => ("GET", Page),
            ["", "orders", id] if order_id(id) => ("GET", Read),
            ["", "orders", id, "mock-pay" | "refund"] if order_id(id) => ("POST", OrderAction),
            ["", "entitlements", "check"] => ("POST", Entitlement),
            _ => {
                return Err(Failure {
                    status: 404,
                    code: "NOT_FOUND",
                });
            }
        };
        ensure(method == required, 405, "METHOD_NOT_ALLOWED")?;
        Ok(Self {
            suffix,
            method: required,
            operation,
        })
    }

    pub(super) fn status(&self) -> u16 {
        if matches!(self.operation, Operation::Create) {
            201
        } else {
            200
        }
    }

    pub(super) async fn body(&self, a: &mut Auth) -> Result<Value> {
        let body = if a.request.inner().body().is_some() {
            crate::app::bounded(a, 4096).await?
        } else {
            String::new()
        };
        if !matches!(self.operation, Operation::Create) && body.is_empty() {
            return Ok(Value::Null);
        }
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/json"),
            400,
            "INVALID_REQUEST",
        )?;
        let value: Value = serde_json::from_str(&body)?;
        let object = value.as_object().ok_or_else(Failure::invalid_request)?;
        let valid = match self.operation {
            Operation::Create => object
                .keys()
                .all(|key| matches!(key.as_str(), "planId" | "interval" | "billingTimeZone")),
            _ => object.is_empty(),
        };
        ensure(valid, 400, "INVALID_REQUEST")?;
        Ok(value)
    }

    fn query(&self, a: &Auth) -> Result<Map<String, Value>> {
        let mut query = Map::new();
        for (key, value) in a.request.url()?.query_pairs() {
            let allowed = match key.as_ref() {
                "product" => value == "WORK",
                "ownerKind" => matches!(value.as_ref(), "USER" | "TENANT"),
                "ownerId" => valid_id(&value),
                "limit" | "cursor" => matches!(self.operation, Operation::Page),
                _ => false,
            };
            ensure(
                allowed && !query.contains_key(key.as_ref()),
                400,
                "INVALID_REQUEST",
            )?;
            query.insert(key.into_owned(), Value::String(value.into_owned()));
        }
        ensure(
            query.get("ownerKind").and_then(Value::as_str) != Some("TENANT")
                || query.contains_key("ownerId"),
            400,
            "INVALID_REQUEST",
        )?;
        Ok(query)
    }

    pub(super) async fn call(&self, session: &WebSession<'_>, body: Value) -> Result<Value> {
        let a = session.a;
        let query = self.query(a)?;
        let key = a.header("Idempotency-Key");
        let key_required = matches!(self.operation, Operation::Create | Operation::OrderAction);
        ensure(
            valid_id(&key) || (!key_required && key.is_empty()),
            400,
            "INVALID_REQUEST",
        )?;
        let access = session.data["tokens"]["accessToken"]
            .as_str()
            .unwrap_or_default();
        ensure(token(access), 401, "SESSION_EXPIRED")?;
        // Billing verifies the current central session and subject before executing the operation.
        let mut input = json!({
            "path": format!("/api/v1{}", self.suffix),
            "method": self.method,
            "query": query,
            "requestId": a.request_id,
            "accessToken": access,
        });
        if !body.is_null() {
            input["body"] = body;
        }
        if !key.is_empty() {
            input["idempotencyKey"] = key.into();
        }
        let input = js_sys::JSON::parse(&input.to_string()).map_err(|_| unavailable())?;
        let mut response = Response::from(
            billing_fetch(a.env.as_ref(), &input)
                .await
                .map_err(|_| unavailable())?,
        );
        let status = response.status_code();
        let mut reply: Value = response.json().await.map_err(|_| unavailable())?;
        if status == self.status() && reply["data"].is_object() && reply.get("error").is_none() {
            return Ok(reply["data"].take());
        }
        Err(upstream_error(
            status,
            reply["error"]["code"].as_str().unwrap_or_default(),
        ))
    }
}

fn order_id(id: &str) -> bool {
    valid_id(id) && !matches!(id, "." | "..")
}

fn unavailable() -> Failure {
    Failure {
        status: 503,
        code: "BILLING_UNAVAILABLE",
    }
}

fn upstream_error(status: u16, code: &str) -> Failure {
    let code = match (status, code) {
        (400, "INVALID_REQUEST") => "INVALID_REQUEST",
        (400, "INVALID_TIMEZONE") => "INVALID_TIMEZONE",
        (401, "UNAUTHENTICATED") => "UNAUTHENTICATED",
        (401, "SESSION_EXPIRED") => "SESSION_EXPIRED",
        (402, "INSUFFICIENT_CREDITS") => "INSUFFICIENT_CREDITS",
        (403, "FORBIDDEN") => "FORBIDDEN",
        (403, "TENANT_DISABLED") => "TENANT_DISABLED",
        (404, "NOT_FOUND") => "NOT_FOUND",
        (409, "ORDER_EXPIRED") => "ORDER_EXPIRED",
        (409, "RENEWAL_ALREADY_PURCHASED") => "RENEWAL_ALREADY_PURCHASED",
        (409, "ORDER_NOT_REFUNDABLE") => "ORDER_NOT_REFUNDABLE",
        (409, "PLAN_DISCONTINUED") => "PLAN_DISCONTINUED",
        (409, "IDEMPOTENCY_CONFLICT") => "IDEMPOTENCY_CONFLICT",
        (409, "VERSION_CONFLICT") => "VERSION_CONFLICT",
        (503, "AUTH_UNAVAILABLE") => "AUTH_UNAVAILABLE",
        _ => return unavailable(),
    };
    Failure { status, code }
}

pub(crate) fn error_response(mut failure: Failure, id: &str) -> worker::Result<Response> {
    let message = match failure.code {
        "LOGIN_REQUIRED" | "INVALID_CREDENTIALS" | "UNAUTHENTICATED" => {
            failure.code = "UNAUTHENTICATED";
            "Authentication required"
        }
        "UNIFIED_CONFIGURATION_INVALID" => {
            failure.code = "AUTH_UNAVAILABLE";
            "Identity service unavailable"
        }
        "INVALID_REQUEST" => "Invalid request",
        "INVALID_TIMEZONE" => "Invalid billing time zone",
        "SESSION_EXPIRED" => "Session expired",
        "INSUFFICIENT_CREDITS" => "Insufficient credits",
        "FORBIDDEN" => "Access denied",
        "TENANT_DISABLED" => "Tenant disabled",
        "NOT_FOUND" => "Resource not found",
        "METHOD_NOT_ALLOWED" => "Method not allowed",
        "ORDER_EXPIRED" => "Order expired",
        "RENEWAL_ALREADY_PURCHASED" => "Renewal already purchased",
        "ORDER_NOT_REFUNDABLE" => "Order is not refundable",
        "PLAN_DISCONTINUED" => "Plan discontinued",
        "IDEMPOTENCY_CONFLICT" => "Idempotency key already used",
        "VERSION_CONFLICT" => "Concurrent update",
        "AUTH_UNAVAILABLE" => "Identity service unavailable",
        "BILLING_UNAVAILABLE" => "Billing service unavailable",
        _ => "Request failed",
    };
    json_response(
        json!({"error":{"code":failure.code,"message":message},"requestId":id}),
        failure.status,
    )
}
