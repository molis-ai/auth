//! Build-time checks shared with the contract validator tests.
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashSet};

const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn supported(profile: &Value, category: &str, value: &str) -> bool {
    profile
        .get(category)
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|item| item.as_str() == Some(value)))
}

fn object(value: &Value) -> Result<&Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| "contract: expected schema object".into())
}
fn definition<'a>(document: &'a Value, name: &str) -> Result<&'a Value, String> {
    document
        .get("$defs")
        .and_then(|v| v.get(name))
        .ok_or_else(|| format!("contract: unknown schema {name}"))
}
fn compile_schema<'a>(
    document: &'a Value,
    schema: &'a Value,
    profile: &Value,
    patterns: &mut BTreeSet<&'a str>,
) -> Result<(), String> {
    let map = object(schema)?;
    for key in map.keys() {
        if !supported(profile, "keywords", key) {
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
    if let Some(kind) = map.get("type")
        && ![
            "object", "array", "string", "integer", "number", "boolean", "null",
        ]
        .contains(&kind.as_str().unwrap_or(""))
    {
        return Err("contract: unsupported type".into());
    }
    if let Some(format) = map.get("format")
        && !supported(profile, "formats", format.as_str().unwrap_or(""))
    {
        return Err("contract: unsupported format".into());
    }
    if let Some(pattern) = map.get("pattern") {
        let text = pattern.as_str().ok_or("contract: pattern must be string")?;
        if !supported(profile, "patterns", text) {
            return Err("contract: unsupported regular expression".into());
        }
        if patterns.insert(text) {
            Regex::new(text).map_err(|_| "contract: invalid regular expression")?;
        }
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
                compile_schema(document, child, profile, patterns)?;
            }
        }
    }
    for key in ["items", "propertyNames", "not"] {
        if let Some(child) = map.get(key) {
            compile_schema(document, child, profile, patterns)?;
        }
    }
    if let Some(child) = map.get("additionalProperties")
        && !child.is_boolean()
    {
        compile_schema(document, child, profile, patterns)?;
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
                compile_schema(document, child, profile, patterns)?;
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
pub fn compile_document<'a>(
    document: &'a Value,
    profile: &Value,
) -> Result<BTreeSet<&'a str>, String> {
    let definitions = document
        .get("$defs")
        .and_then(Value::as_object)
        .ok_or("contract: missing $defs")?;
    let mut patterns = BTreeSet::new();
    compile_schema(document, document, profile, &mut patterns)?;
    for (name, schema) in definitions {
        check_cycles(document, schema, &mut HashSet::from([name.clone()]))?;
    }
    Ok(patterns)
}
