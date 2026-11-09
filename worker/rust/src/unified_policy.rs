//! Foundation boundary for the unified account protocol. No v2 login is issued here.
use crate::http::*;
use serde_json::Value;
use worker::{Env, Url};

pub fn validate_configuration(value: &Value, auth_origin: &str) -> Result<()> {
    let invalid = || Failure {
        status: 503,
        code: "UNIFIED_CONFIGURATION_INVALID",
    };
    crate::unified_contracts::validate_named("EnvironmentConfig", value).map_err(|_| invalid())?;
    let origin = text(value, "authOrigin");
    let url = Url::parse(&origin).map_err(|_| invalid())?;
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

pub fn validate_environment(env: &Env, auth_origin: &str) -> Result<()> {
    // Credentials still require an explicit registered environment; absence never enables mock.
    if let Ok(raw) = env.var("UNIFIED_ACCOUNT_CONFIG") {
        let value = serde_json::from_str(&raw.to_string()).map_err(|_| Failure {
            status: 503,
            code: "UNIFIED_CONFIGURATION_INVALID",
        })?;
        validate_configuration(&value, auth_origin)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
