//! Trusted deployment policy controls new self-service tenants, never existing membership.
use crate::http::*;
use worker::Env;

pub fn parse(value: Option<&str>) -> Result<&'static str> {
    match value {
        None | Some("SELF_SERVICE") => Ok("SELF_SERVICE"),
        Some("PLATFORM_ONLY") => Ok("PLATFORM_ONLY"),
        _ => Err(Failure {
            status: 503,
            code: "UNIFIED_CONFIGURATION_INVALID",
        }),
    }
}

pub fn policy(env: &Env) -> Result<&'static str> {
    let value = env
        .var("TENANT_CREATION_POLICY")
        .ok()
        .map(|v| v.to_string());
    parse(value.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2u_09_creation_defaults_to_self_service_and_rejects_unknown_policy() {
        assert_eq!(parse(None).unwrap(), "SELF_SERVICE");
        assert_eq!(parse(Some("SELF_SERVICE")).unwrap(), "SELF_SERVICE");
        assert_eq!(parse(Some("PLATFORM_ONLY")).unwrap(), "PLATFORM_ONLY");
        for value in ["", "self_service", "OPEN", " PLATFORM_ONLY"] {
            assert!(parse(Some(value)).is_err());
        }
    }
}
