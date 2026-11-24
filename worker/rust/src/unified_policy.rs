//! Foundation boundary for the unified account protocol. No v2 login is issued here.
use crate::http::*;
use serde_json::Value;
use std::sync::{Arc, Mutex, OnceLock};
use worker::{Env, Url};

pub(crate) fn default_integer(name: &str) -> i64 {
    static POLICY: OnceLock<Value> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/unified-account/policy.json"
        ))
        .expect("bundled policy")
    })["defaults"][name]
        .as_i64()
        .expect("integer policy default")
}

pub(crate) fn invalid_configuration() -> Failure {
    Failure {
        status: 503,
        code: "UNIFIED_CONFIGURATION_INVALID",
    }
}

fn validate_configuration(value: &Value, auth_origin: &str) -> Result<()> {
    crate::unified_contracts::validate_named("EnvironmentConfig", value)
        .map_err(|_| invalid_configuration())?;
    let origin = text(value, "authOrigin");
    let url = Url::parse(&origin).map_err(|_| invalid_configuration())?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(host)) => host == "localhost" || host.ends_with(".localhost"),
        None => false,
    };
    ensure(
        origin == auth_origin
            && url.origin().ascii_serialization() == origin
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && (url.scheme() == "https" || (url.scheme() == "http" && local))
            && (value["kind"] != "LOCAL" || local)
            && (value["kind"] != "PRODUCTION"
                || (!loopback
                    && value["deliveryMode"] == "LIVE"
                    && value["providerMode"] == "LIVE")),
        503,
        "UNIFIED_CONFIGURATION_INVALID",
    )
}

struct EnvironmentConfig {
    raw: String,
    origin: String,
    value: Arc<Value>,
}

fn cached_configuration(
    cache: &Mutex<Option<EnvironmentConfig>>,
    raw: String,
    auth_origin: &str,
) -> Result<Arc<Value>> {
    let mut current = cache.lock().map_err(|_| invalid_configuration())?;
    if let Some(entry) = current.as_ref()
        && entry.raw == raw
        && entry.origin == auth_origin
    {
        return Ok(Arc::clone(&entry.value));
    }
    let value = serde_json::from_str(&raw).map_err(|_| invalid_configuration())?;
    validate_configuration(&value, auth_origin)?;
    let value = Arc::new(value);
    *current = Some(EnvironmentConfig {
        raw,
        origin: auth_origin.to_owned(),
        value: Arc::clone(&value),
    });
    Ok(value)
}

pub(crate) fn environment_configuration(
    env: &Env,
    auth_origin: &str,
) -> Result<Option<Arc<Value>>> {
    static CONFIGURATION: Mutex<Option<EnvironmentConfig>> = Mutex::new(None);
    // Credentials still require an explicit registered environment; absence never enables mock.
    env.var("UNIFIED_ACCOUNT_CONFIG")
        .ok()
        .map(|raw| cached_configuration(&CONFIGURATION, raw.to_string(), auth_origin))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn environment_cache_matches_raw_binding_and_canonical_origin() {
        let cache = Mutex::new(None);
        let origin = "http://127.0.0.1:8787";
        let mut config = json!({"environmentId":"unified-local","kind":"LOCAL",
            "authOrigin":origin,"deliveryMode":"MOCK","providerMode":"MOCK"});
        let raw = config.to_string();
        let first = cached_configuration(&cache, raw.clone(), origin).unwrap();
        let hit = cached_configuration(&cache, raw.clone(), origin).unwrap();
        assert!(Arc::ptr_eq(&first, &hit));
        let wrong_origin =
            cached_configuration(&cache, raw, "https://auth.example.test").unwrap_err();
        assert_eq!(wrong_origin.code, "UNIFIED_CONFIGURATION_INVALID");
        let malformed = cached_configuration(&cache, "{".to_owned(), origin).unwrap_err();
        assert_eq!(malformed.code, "UNIFIED_CONFIGURATION_INVALID");
        let reformatted = cached_configuration(&cache, format!(" {config}"), origin).unwrap();
        assert!(!Arc::ptr_eq(&first, &reformatted));
        assert_eq!(*first, *reformatted);
        config["environmentId"] = json!("unified-local-rebound");
        let updated = cached_configuration(&cache, config.to_string(), origin).unwrap();
        assert_eq!(updated["environmentId"], "unified-local-rebound");
    }

    #[test]
    fn mock_is_explicit_and_production_cannot_use_it() {
        let mut config = json!({"environmentId":"unified-local","kind":"LOCAL",
            "authOrigin":"http://127.0.0.1:8787","deliveryMode":"MOCK","providerMode":"MOCK"});
        assert!(validate_configuration(&config, "http://127.0.0.1:8787").is_ok());
        config["kind"] = json!("PRODUCTION");
        config["authOrigin"] = json!("https://auth.example.test");
        assert!(validate_configuration(&config, "https://auth.example.test").is_err());
        config["deliveryMode"] = json!("LIVE");
        assert!(validate_configuration(&config, "https://auth.example.test").is_err());
        config["providerMode"] = json!("LIVE");
        assert!(validate_configuration(&config, "https://auth.example.test").is_ok());
        assert!(validate_configuration(&config, "https://other.example.test").is_err());
        for origin in [
            "https://user@auth.example.test",
            "https://auth.example.test/path",
            "https://auth.example.test?x=1",
            "https://auth.example.test#x",
            "http://auth.example.test",
            "https://localhost",
            "https://127.0.0.2",
            "https://app.localhost",
        ] {
            config["authOrigin"] = json!(origin);
            assert!(validate_configuration(&config, origin).is_err(), "{origin}");
        }
        config["authOrigin"] = json!("https://auth.example.test");
        config["kind"] = json!("unknown");
        assert!(validate_configuration(&config, "https://auth.example.test").is_err());
    }
}
