//! AUTH-01 structural contracts. Authority, freshness and atomic state transitions remain domain checks.
//! Keep this restricted JSON Schema evaluator in parity with contracts/unified-account/validate.ts.
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{LazyLock, OnceLock};

const DOCUMENT: &str = include_str!("../../../../../contracts/unified-account/schemas.json");
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn definition<'a>(document: &'a Value, name: &str) -> Result<&'a Value, String> {
    document
        .get("$defs")
        .and_then(|v| v.get(name))
        .ok_or_else(|| format!("contract: unknown schema {name}"))
}
const PATTERNS: &[&str] = include!(concat!(env!("OUT_DIR"), "/contract_patterns.rs"));

#[cfg(test)]
static PATTERN_COMPILATIONS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

fn patterns() -> &'static HashMap<&'static str, Regex> {
    static REGEXES: OnceLock<HashMap<&'static str, Regex>> = OnceLock::new();
    REGEXES.get_or_init(|| {
        PATTERNS
            .iter()
            .map(|&pattern| {
                #[cfg(test)]
                PATTERN_COMPILATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                (pattern, Regex::new(pattern).expect("build-checked pattern"))
            })
            .collect()
    })
}

fn format_matches(format: &str, value: &str) -> bool {
    static DATE_TIME: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{3})?Z$",
        )
        .expect("date-time pattern")
    });
    static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$")
            .expect("email pattern")
    });
    static ENCODED_PATH_SEPARATOR_OR_CONTROL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"%(2[fF]|5[cC]|[01][0-9a-fA-F]|7[fF])").expect("local-path pattern")
    });
    match format {
        "date-time" => {
            let Some(captures) = DATE_TIME.captures(value) else {
                return false;
            };
            let n = |i| {
                captures
                    .get(i)
                    .and_then(|m| m.as_str().parse::<u32>().ok())
                    .unwrap_or(0)
            };
            let (year, month, day) = (n(1), n(2), n(3));
            let leap =
                year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
            let days = match month {
                1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
                4 | 6 | 9 | 11 => 30,
                2 if leap => 29,
                2 => 28,
                _ => 0,
            };
            day >= 1 && day <= days && n(4) < 24 && n(5) < 60 && n(6) < 60
        }
        "email" => {
            value.bytes().all(|b| (33..=126).contains(&b))
                && EMAIL.is_match(value)
                && !value.starts_with('.')
                && !value.contains("..")
                && !value.contains(".@")
        }
        "local-path" => {
            value.starts_with('/')
                && !value.starts_with("//")
                && !value
                    .chars()
                    .any(|c| c == '\\' || c <= ' ' || c == '\u{7f}')
                && !ENCODED_PATH_SEPARATOR_OR_CONTROL.is_match(value)
        }
        "http-url" | "http-origin" => {
            if !(value.starts_with("https://") || value.starts_with("http://"))
                || value.contains('*')
                || value
                    .bytes()
                    .any(|b| !(33..=126).contains(&b) || b == b'\\')
            {
                return false;
            }
            let Ok(parsed) = url::Url::parse(value) else {
                return false;
            };
            if !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.host_str().is_none()
            {
                return false;
            }
            format != "http-origin" || value == parsed.origin().ascii_serialization()
        }
        _ => false,
    }
}
fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| json_equal(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|other| json_equal(v, other)))
        }
        _ => left == right,
    }
}
fn matches(document: &Value, schema: &Value, value: &Value) -> bool {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str)
        && !definition(document, reference.trim_start_matches("#/$defs/"))
            .is_ok_and(|s| matches(document, s, value))
    {
        return false;
    }
    if schema.get("const").is_some_and(|v| !json_equal(v, value)) {
        return false;
    }
    if schema
        .get("enum")
        .and_then(Value::as_array)
        .is_some_and(|v| !v.iter().any(|item| json_equal(item, value)))
    {
        return false;
    }
    for key in ["oneOf", "anyOf", "allOf"] {
        if let Some(variants) = schema.get(key).and_then(Value::as_array) {
            let count = variants
                .iter()
                .filter(|s| matches(document, s, value))
                .count();
            if (key == "oneOf" && count != 1)
                || (key == "anyOf" && count == 0)
                || (key == "allOf" && count != variants.len())
            {
                return false;
            }
        }
    }
    if schema
        .get("not")
        .is_some_and(|s| matches(document, s, value))
    {
        return false;
    }
    if let Some(kind) = schema.get("type").and_then(Value::as_str) {
        let valid = match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            "number" => value.as_f64().is_some_and(|n| n.is_finite()),
            "integer" => value
                .as_f64()
                .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= SAFE_INTEGER),
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    let bound =
        |key: &str, default: f64| schema.get(key).and_then(Value::as_f64).unwrap_or(default);
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as f64;
        if length < bound("minLength", 0.0) || length > bound("maxLength", f64::INFINITY) {
            return false;
        }
        if schema
            .get("pattern")
            .and_then(Value::as_str)
            .is_some_and(|p| !patterns().get(p).is_some_and(|r| r.is_match(text)))
        {
            return false;
        }
        if schema
            .get("format")
            .and_then(Value::as_str)
            .is_some_and(|f| !format_matches(f, text))
        {
            return false;
        }
    }
    if let Some(number) = value.as_f64()
        && (number < bound("minimum", f64::NEG_INFINITY)
            || number > bound("maximum", f64::INFINITY))
    {
        return false;
    }
    if let Some(items) = value.as_array() {
        if (items.len() as f64) < bound("minItems", 0.0)
            || (items.len() as f64) > bound("maxItems", f64::INFINITY)
        {
            return false;
        }
        if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
            for (index, item) in items.iter().enumerate() {
                if items[..index]
                    .iter()
                    .any(|previous| json_equal(previous, item))
                {
                    return false;
                }
            }
        }
        if let Some(item_schema) = schema.get("items")
            && !items.iter().all(|v| matches(document, item_schema, v))
        {
            return false;
        }
    }
    if let Some(values) = value.as_object() {
        if (values.len() as f64) < bound("minProperties", 0.0)
            || (values.len() as f64) > bound("maxProperties", f64::INFINITY)
        {
            return false;
        }
        if schema
            .get("required")
            .and_then(Value::as_array)
            .is_some_and(|required| {
                required
                    .iter()
                    .any(|key| !values.contains_key(key.as_str().unwrap_or("")))
            })
        {
            return false;
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        for (key, child) in values {
            if schema
                .get("propertyNames")
                .is_some_and(|s| !matches(document, s, &Value::String(key.clone())))
            {
                return false;
            }
            if let Some(property) = properties.and_then(|p| p.get(key)) {
                if !matches(document, property, child) {
                    return false;
                }
            } else if let Some(additional) = schema.get("additionalProperties")
                && (additional == &Value::Bool(false)
                    || (additional.is_object() && !matches(document, additional, child)))
            {
                return false;
            }
        }
    }
    true
}

/// Validate a named DTO using the bundled, checked contract; errors never contain input values.
pub fn validate_named(name: &str, value: &Value) -> Result<(), String> {
    static PARSED: OnceLock<Result<Value, String>> = OnceLock::new();
    let document = PARSED
        .get_or_init(|| {
            serde_json::from_str(DOCUMENT).map_err(|_| "contract: invalid bundled JSON".into())
        })
        .as_ref()
        .map_err(Clone::clone)?;
    let schema = definition(document, name)?;
    if matches(document, schema, value) {
        Ok(())
    } else {
        Err(format!("contract: value does not match {name}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::contracts::contract_structure::compile_document;
    use serde_json::json;
    use std::sync::atomic::Ordering;

    const PROFILE: &str =
        include_str!("../../../../../contracts/unified-account/validator-profile.json");

    #[test]
    fn unified_contract_shared_positive_and_negative_fixtures() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../../contracts/unified-account/fixtures.json"
        ))
        .unwrap();
        for fixture in fixtures["fixtures"].as_array().unwrap() {
            let actual =
                validate_named(fixture["schema"].as_str().unwrap(), &fixture["value"]).is_ok();
            assert_eq!(
                actual,
                fixture["valid"].as_bool().unwrap(),
                "fixture {}",
                fixture["name"]
            );
        }
    }

    #[test]
    fn unified_contract_refuses_unknown_schema_keywords_and_cycles() {
        let profile = serde_json::from_str(PROFILE).unwrap();
        for schema in [
            json!({"type":"string","unknown":true}),
            json!({"format":"uuid"}),
            json!({"pattern":"(?=x)x"}),
            json!({"$ref":"https://external.invalid/schema"}),
            json!({"$ref":"#/$defs/Example"}),
            json!({"$ref":"#/$defs/Missing"}),
            json!({"required":["x","x"]}),
            json!({"minLength":-1}),
        ] {
            assert!(compile_document(&json!({"$defs":{"Example":schema}}), &profile).is_err());
        }
        assert!(validate_named("NotAContract", &Value::Null).is_err());
    }

    #[test]
    fn repeated_named_validation_reuses_all_six_patterns() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../../contracts/unified-account/fixtures.json"
        ))
        .unwrap();
        let fixture = fixtures["fixtures"]
            .as_array()
            .unwrap()
            .iter()
            .find(|fixture| fixture["schema"] == "TokenRequest" && fixture["valid"] == true)
            .unwrap();
        for _ in 0..10 {
            validate_named("TokenRequest", &fixture["value"]).unwrap();
            assert_eq!(PATTERN_COMPILATIONS.load(Ordering::Relaxed), 6);
        }
    }

    #[test]
    fn unified_contract_numeric_equality_matches_javascript_json() {
        let doc = json!({"$defs":{}});
        let integer = json!(1);
        let float: Value = serde_json::from_str("1.0").unwrap();
        assert!(matches(&doc, &json!({"const":1}), &float));
        assert!(matches(&doc, &json!({"enum":[1]}), &float));
        assert!(!matches(
            &doc,
            &json!({"type":"array","uniqueItems":true}),
            &json!([integer, float])
        ));
        assert!(json_equal(
            &json!({"a":1,"b":[2]}),
            &json!({"b":[2.0],"a":1.0})
        ));
    }
}
