use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

pub type Result<T> = std::result::Result<T, Failure>;
#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub code: &'static str,
}
impl Failure {
    pub(crate) fn unavailable() -> Self {
        Self {
            status: 503,
            code: "AUTH_UNAVAILABLE",
        }
    }
    pub(crate) fn invalid_request() -> Self {
        Self {
            status: 400,
            code: "INVALID_REQUEST",
        }
    }
}
impl From<worker::Error> for Failure {
    fn from(_: worker::Error) -> Self {
        Self::unavailable()
    }
}
impl From<serde_json::Error> for Failure {
    fn from(_: serde_json::Error) -> Self {
        Self::invalid_request()
    }
}
pub(crate) fn matches_route_template(path: &str, template: &str) -> bool {
    let mut segments = path.split('/');
    template.split('/').all(|part| {
        segments
            .next()
            .is_some_and(|value| part.starts_with('{') || part == value)
    }) && segments.next().is_none()
}

pub(crate) fn log_env(env: &worker::Env) -> &'static str {
    env.var("MOLIS_ENVIRONMENT")
        .ok()
        .map(|value| match value.to_string().as_str() {
            "prod" => "prod",
            "test" => "test",
            "dev" => "dev",
            _ => "unknown",
        })
        .unwrap_or("unknown")
}

pub(crate) fn log_event<const N: usize>(
    event: &'static str,
    env: &'static str,
    request_id: &str,
    fields: [(&'static str, Value); N],
    error: bool,
) {
    let envelope = [
        ("schema", json!(1)),
        ("service", json!("molis-auth")),
        ("env", json!(env)),
        ("event", json!(event)),
        ("request_id", json!(request_id)),
    ];
    let message = Value::Object(
        fields
            .into_iter()
            .chain(envelope)
            .map(|(name, value)| (name.into(), value))
            .collect(),
    );
    if error {
        worker::console_error!("{message}");
    } else {
        worker::console_log!("{message}");
    }
}

pub(crate) fn log_failure(
    env: &'static str,
    request_id: &str,
    route: &'static str,
    phase: &'static str,
    failure: &Failure,
    started: i64,
) {
    if failure.status < 500 {
        return;
    }
    log_event(
        "auth.request.failure",
        env,
        request_id,
        [
            ("route", json!(route)),
            ("phase", json!(phase)),
            ("code", json!(failure.code)),
            ("status", json!(failure.status)),
            ("duration_ms", json!((now() - started).max(0))),
        ],
        true,
    );
}

pub(crate) struct RequestLog<'a> {
    pub env: &'static str,
    pub id: &'a str,
    pub route: &'static str,
    pub method: &'a str,
    pub started: i64,
}

impl RequestLog<'_> {
    pub fn finish(&self, status: u16, error_code: Option<&'static str>) {
        if matches!(self.route, "/api/v1/health" | "/auth-ui/{asset}")
            && (200..400).contains(&status)
        {
            return;
        }
        let error_code = error_code.unwrap_or(if status < 400 { "none" } else { "http_error" });
        log_event(
            "auth.http.request",
            self.env,
            self.id,
            [
                ("method", json!(self.method)),
                ("route", json!(self.route)),
                ("status", json!(status)),
                ("error_code", json!(error_code)),
                ("duration_ms", json!((now() - self.started).max(0))),
            ],
            status >= 500,
        );
    }
}

pub fn ensure(condition: bool, status: u16, code: &'static str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(Failure { status, code })
    }
}
pub(crate) fn shape(name: &str, value: &Value) -> Result<()> {
    ensure(
        crate::core::contracts::unified_contracts::validate_named(name, value).is_ok(),
        400,
        "INVALID_REQUEST",
    )
}
pub fn fields(b: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    ensure(
        b.as_object().is_some_and(|o| {
            required.iter().all(|k| o.contains_key(*k))
                && o.keys()
                    .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
        }),
        400,
        "INVALID_REQUEST",
    )
}
pub fn string(v: &Value, max: usize) -> Result<&str> {
    let s = v.as_str().ok_or(Failure {
        status: 400,
        code: "INVALID_REQUEST",
    })?;
    ensure(s.encode_utf16().count() <= max, 400, "INVALID_REQUEST")?;
    Ok(s)
}
pub fn text(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_owned()
}
pub fn number(v: &Value, k: &str) -> i64 {
    v[k].as_i64().unwrap_or_default()
}
pub fn parsed(v: &Value, k: &str) -> Result<Value> {
    Ok(serde_json::from_str(string(&v[k], 200_000)?)?)
}
pub(crate) fn stored_json<T: serde::de::DeserializeOwned>(v: &Value, k: &str) -> Result<T> {
    let serialized = v[k].as_str().ok_or_else(Failure::unavailable)?;
    serde_json::from_str(serialized).map_err(|_| Failure::unavailable())
}
pub fn contains(v: &Value, needle: &Value) -> bool {
    v.as_array().is_some_and(|a| a.contains(needle))
}
pub fn token(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

pub(crate) fn internal_request_id(request: &worker::Request) -> String {
    request
        .headers()
        .get("X-Request-Id")
        .ok()
        .flatten()
        .filter(|id| valid_id(id))
        .unwrap_or_else(crate::core::security::uuid)
}
pub fn email(v: &Value) -> Result<String> {
    #[allow(
        clippy::unwrap_used,
        reason = "fixed pattern covered by canonical_email"
    )]
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$").unwrap()
    });
    let s = string(v, 320)?.trim().to_lowercase();
    ensure(
        s.len() <= 254
            && RE.is_match(&s)
            && s.find('@').is_some_and(|i| i <= 64)
            && s.split('@')
                .nth(1)
                .is_some_and(|d| d.split('.').all(|l| l.len() <= 63)),
        400,
        "INVALID_EMAIL",
    )?;
    Ok(s)
}
pub fn now() -> i64 {
    js_sys::Date::now() as i64
}
pub fn iso(v: &Value) -> Value {
    if v.is_null() {
        Value::Null
    } else {
        js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(
            v.as_f64().unwrap_or_default(),
        ))
        .to_iso_string()
        .as_string()
        .unwrap_or_default()
        .into()
    }
}
pub fn name(v: &Value) -> Result<String> {
    let s = string(v, 240)?.trim();
    ensure(
        !s.is_empty() && s.chars().count() <= 120 && !s.chars().any(|c| c.is_control()),
        400,
        "INVALID_DISPLAY_NAME",
    )?;
    Ok(s.to_owned())
}
pub fn form(body: &str) -> Result<Value> {
    let mut value = json!({});
    for (key, item) in url::form_urlencoded::parse(body.as_bytes()) {
        ensure(value.get(key.as_ref()).is_none(), 400, "INVALID_REQUEST")?;
        value[key.as_ref()] = json!(item);
    }
    Ok(value)
}
pub fn cookie(header: &str, key: &str) -> String {
    let prefix = format!("{key}=");
    let found: Vec<_> = header
        .split(';')
        .map(str::trim)
        .filter_map(|s| s.strip_prefix(&prefix))
        .collect();
    if found.len() == 1 {
        found[0].to_owned()
    } else {
        String::new()
    }
}
pub fn cookie_header(origin: &str, key: &str, value: &str, age: i64) -> String {
    format!(
        "{key}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={age}{}",
        if origin.starts_with("https:") {
            "; Secure"
        } else {
            ""
        }
    )
}
pub fn json_response(value: Value, status: u16) -> worker::Result<worker::Response> {
    let mut r = worker::Response::from_json(&value)?.with_status(status);
    r.headers_mut().set("Cache-Control", "no-store")?;
    Ok(r)
}
pub fn error_response(e: Failure, id: &str) -> worker::Result<worker::Response> {
    json_response(json!({"error":{"code":e.code},"requestId":id}), e.status)
}

pub(crate) fn with_security_headers(
    mut response: worker::Response,
    id: &str,
    https: bool,
) -> worker::Result<worker::Response> {
    for (k, v) in [
        ("X-Request-ID", id),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
        ("X-Frame-Options", "DENY"),
        (
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ] {
        if (k == "Content-Security-Policy" || k == "Referrer-Policy")
            && response.headers().get(k)?.is_some()
        {
            continue;
        }
        response.headers_mut().set(k, v)?;
    }
    if https {
        response
            .headers_mut()
            .set("Strict-Transport-Security", "max-age=31536000")?;
    }
    Ok(response)
}

pub(crate) async fn bounded(request: &mut worker::Request, max: usize) -> Result<String> {
    use futures_util::StreamExt;
    let mut stream = request.stream()?;
    let mut bytes = Vec::new();
    while let Some(part) = stream.next().await {
        let part = part?;
        ensure(bytes.len() + part.len() <= max, 413, "INVALID_REQUEST")?;
        bytes.extend(part);
    }
    String::from_utf8(bytes).map_err(|_| Failure {
        status: 400,
        code: "INVALID_REQUEST",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tokens_are_strict() {
        assert!(token(&"a".repeat(43)));
        assert!(!token(&"a".repeat(42)));
        assert!(!token(&"/".repeat(43)));
    }
    #[test]
    fn reject_unknown_fields() {
        assert!(fields(&json!({"email":"x","admin":true}), &["email"], &[]).is_err());
    }
    #[test]
    fn canonical_email() {
        assert_eq!(
            email(&json!(" Test@Example.com ")).unwrap(),
            "test@example.com"
        );
        assert!(email(&json!("admin")).is_err());
    }
    #[test]
    fn duplicate_cookie_rejected() {
        assert_eq!(cookie("a=1; a=2", "a"), "");
        assert_eq!(cookie("b=0; a=1", "a"), "1");
    }
    #[test]
    fn forms_preserve_fragments_and_reject_duplicate_keys() {
        assert_eq!(
            form("code=a#b&state=c+d").unwrap(),
            json!({"code":"a#b","state":"c d"})
        );
        assert!(form("code=a&%63ode=b").is_err());
    }
}
