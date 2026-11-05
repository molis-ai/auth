//! AUTH-01 structural contracts. Authority, freshness and atomic state transitions remain domain checks.
//! Keep this restricted JSON Schema evaluator in parity with contracts/unified-account/validate.ts.
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::OnceLock;

const DOCUMENT: &str = include_str!("../../../contracts/unified-account/schemas.json");
const PROFILE: &str = include_str!("../../../contracts/unified-account/validator-profile.json");
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn supported(category: &str, value: &str) -> bool {
    static PROFILE_VALUE: OnceLock<Option<Value>> = OnceLock::new();
    PROFILE_VALUE
        .get_or_init(|| serde_json::from_str(PROFILE).ok())
        .as_ref()
        .and_then(|profile| profile.get(category))
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|item| item.as_str() == Some(value)))
}

fn object(value: &Value) -> Result<&Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| "contract: expected schema object".into())
}
fn regex(pattern: &str) -> Result<Regex, String> {
    Regex::new(pattern).map_err(|_| "contract: invalid regular expression".into())
}
fn definition<'a>(document: &'a Value, name: &str) -> Result<&'a Value, String> {
    document
        .get("$defs")
        .and_then(|v| v.get(name))
        .ok_or_else(|| format!("contract: unknown schema {name}"))
}
fn compile_schema(document: &Value, schema: &Value) -> Result<(), String> {
    let map = object(schema)?;
    for key in map.keys() {
        if !supported("keywords", key) {
            return Err(format!("contract: unsupported keyword {key}"));
        }
    }
    if let Some(reference) = map.get("$ref") {
        let name = reference
            .as_str()
            .and_then(|r| r.strip_prefix("#/$defs/"))
            .ok_or("contract: unsupported reference")?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("contract: unsupported reference".into());
        }
        definition(document, name)?;
    }
    if let Some(kind) = map.get("type") {
        if ![
            "object", "array", "string", "integer", "number", "boolean", "null",
        ]
        .contains(&kind.as_str().unwrap_or(""))
        {
            return Err("contract: unsupported type".into());
        }
    }
    if let Some(format) = map.get("format") {
        if !supported("formats", format.as_str().unwrap_or("")) {
            return Err("contract: unsupported format".into());
        }
    }
    if let Some(pattern) = map.get("pattern") {
        let text = pattern.as_str().ok_or("contract: pattern must be string")?;
        if !supported("patterns", text) {
            return Err("contract: unsupported regular expression".into());
        }
        regex(text)?;
    }
    for key in [
        "minProperties",
        "maxProperties",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
    ] {
        if let Some(value) = map.get(key) {
            let n = value.as_f64().ok_or("contract: invalid bound")?;
            if !(0.0..=SAFE_INTEGER).contains(&n) || n.fract() != 0.0 {
                return Err("contract: invalid bound".into());
            }
        }
    }
    for key in ["minimum", "maximum"] {
        if map.get(key).is_some_and(|v| v.as_f64().is_none()) {
            return Err("contract: invalid numeric bound".into());
        }
    }
    if let Some(required) = map.get("required") {
        let fields = required.as_array().ok_or("contract: invalid required")?;
        let mut seen = HashSet::new();
        for value in fields {
            if !seen.insert(value.as_str().ok_or("contract: invalid required")?) {
                return Err("contract: duplicate required".into());
            }
        }
    }
    if map
        .get("enum")
        .is_some_and(|v| v.as_array().is_none_or(Vec::is_empty))
    {
        return Err("contract: invalid enum".into());
    }
    if map.get("uniqueItems").is_some_and(|v| !v.is_boolean()) {
        return Err("contract: invalid uniqueItems".into());
    }
    for key in ["properties", "$defs"] {
        if let Some(children) = map.get(key) {
            for child in object(children)?.values() {
                compile_schema(document, child)?;
            }
        }
    }
    for key in ["items", "propertyNames", "not"] {
        if let Some(child) = map.get(key) {
            compile_schema(document, child)?;
        }
    }
    if let Some(child) = map.get("additionalProperties") {
        if !child.is_boolean() {
            compile_schema(document, child)?;
        }
    }
    for key in ["oneOf", "anyOf", "allOf"] {
        if let Some(children) = map.get(key) {
            let children = children
                .as_array()
                .ok_or("contract: invalid schema alternatives")?;
            if children.is_empty() {
                return Err("contract: empty schema alternatives".into());
            }
            for child in children {
                compile_schema(document, child)?;
            }
        }
    }
    Ok(())
}
fn check_cycles(
    document: &Value,
    schema: &Value,
    stack: &mut HashSet<String>,
) -> Result<(), String> {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let name = reference.trim_start_matches("#/$defs/");
        if !stack.insert(name.to_owned()) {
            return Err("contract: recursive reference".into());
        }
        check_cycles(document, definition(document, name)?, stack)?;
        stack.remove(name);
    }
    for key in ["properties", "$defs"] {
        if let Some(children) = schema.get(key).and_then(Value::as_object) {
            for child in children.values() {
                check_cycles(document, child, stack)?;
            }
        }
    }
    for key in ["items", "propertyNames", "not", "additionalProperties"] {
        if let Some(child) = schema.get(key).filter(|v| v.is_object()) {
            check_cycles(document, child, stack)?;
        }
    }
    for key in ["oneOf", "anyOf", "allOf"] {
        if let Some(children) = schema.get(key).and_then(Value::as_array) {
            for child in children {
                check_cycles(document, child, stack)?;
            }
        }
    }
    Ok(())
}
fn compile_document(document: &Value) -> Result<(), String> {
    let definitions = document
        .get("$defs")
        .and_then(Value::as_object)
        .ok_or("contract: missing $defs")?;
    compile_schema(document, document)?;
    for (name, schema) in definitions {
        check_cycles(document, schema, &mut HashSet::from([name.clone()]))?;
    }
    Ok(())
}
fn format_matches(format: &str, value: &str) -> bool {
    match format {
        "date-time" => {
            let Ok(re) = regex(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{3})?Z$") else { return false; };
            let Some(c) = re.captures(value) else { return false; };
            let n = |i| c.get(i).and_then(|m| m.as_str().parse::<u32>().ok()).unwrap_or(0);
            let (year, month, day) = (n(1), n(2), n(3));
            let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
            let days = match month { 1|3|5|7|8|10|12 => 31, 4|6|9|11 => 30, 2 if leap => 29, 2 => 28, _ => 0 };
            day >= 1 && day <= days && n(4) < 24 && n(5) < 60 && n(6) < 60
        }
        "email" => {
            value.bytes().all(|b| (33..=126).contains(&b)) && regex(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$").is_ok_and(|r| r.is_match(value))
                && !value.starts_with('.') && !value.contains("..") && !value.contains(".@")
        }
        "local-path" => value.starts_with('/') && !value.starts_with("//")
            && !value.chars().any(|c| c == '\\' || c <= ' ' || c == '\u{7f}')
            && !regex(r"(?i)%(2f|5c|0[0-9a-f]|1[0-9a-f]|7f)").is_ok_and(|r| r.is_match(value)),
        "http-url" | "http-origin" => {
            if !(value.starts_with("https://") || value.starts_with("http://")) || value.contains('*') || value.bytes().any(|b| !(33..=126).contains(&b) || b == b'\\') { return false; }
            let Ok(parsed) = url::Url::parse(value) else { return false; };
            if !parsed.username().is_empty() || parsed.password().is_some() || parsed.host_str().is_none() { return false; }
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
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        if !definition(document, reference.trim_start_matches("#/$defs/"))
            .is_ok_and(|s| matches(document, s, value))
        {
            return false;
        }
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
            .is_some_and(|p| !regex(p).is_ok_and(|r| r.is_match(text)))
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
    if let Some(number) = value.as_f64() {
        if number < bound("minimum", f64::NEG_INFINITY) || number > bound("maximum", f64::INFINITY)
        {
            return false;
        }
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
        if let Some(item_schema) = schema.get("items") {
            if !items.iter().all(|v| matches(document, item_schema, v)) {
                return false;
            }
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
            } else if let Some(additional) = schema.get("additionalProperties") {
                if additional == &Value::Bool(false)
                    || (additional.is_object() && !matches(document, additional, child))
                {
                    return false;
                }
            }
        }
    }
    true
}

/// Validate a named DTO using the bundled, checked contract; errors never contain input values.
pub fn validate_named(name: &str, value: &Value) -> Result<(), String> {
    static COMPILED: OnceLock<Result<Value, String>> = OnceLock::new();
    let document = COMPILED
        .get_or_init(|| {
            let document: Value =
                serde_json::from_str(DOCUMENT).map_err(|_| "contract: invalid bundled JSON")?;
            compile_document(&document)?;
            Ok(document)
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
    use serde_json::json;

    #[test]
    fn unified_contract_shared_positive_and_negative_fixtures() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../contracts/unified-account/fixtures.json"
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
        for schema in [
            json!({"type":"string","unknown":true}),
            json!({"format":"uuid"}),
            json!({"pattern":"(?=x)x"}),
            json!({"$ref":"https://external.invalid/schema"}),
            json!({"$ref":"#/$defs/Example"}),
            json!({"required":["x","x"]}),
        ] {
            assert!(compile_document(&json!({"$defs":{"Example":schema}})).is_err());
        }
        assert!(validate_named("NotAContract", &Value::Null).is_err());
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
