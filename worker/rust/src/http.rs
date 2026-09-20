use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

pub type Result<T> = std::result::Result<T, Failure>;
#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub code: &'static str,
}
impl From<worker::Error> for Failure {
    fn from(_: worker::Error) -> Self {
        Self {
            status: 503,
            code: "AUTH_UNAVAILABLE",
        }
    }
}
impl From<serde_json::Error> for Failure {
    fn from(_: serde_json::Error) -> Self {
        Self {
            status: 400,
            code: "INVALID_REQUEST",
        }
    }
}
pub fn ensure(condition: bool, status: u16, code: &'static str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(Failure { status, code })
    }
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
pub fn contains(v: &Value, needle: &Value) -> bool {
    v.as_array().is_some_and(|a| a.contains(needle))
}
pub fn token(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub fn email(v: &Value) -> Result<String> {
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
pub fn query(url: &worker::Url, key: &str, default: &str) -> String {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .unwrap_or(default.into())
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
pub fn root_cookie(origin: &str) -> &'static str {
    if origin.starts_with("https:") {
        "__Host-auth_session"
    } else {
        "auth_session_dev"
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
