pub(crate) mod external_login;
pub(crate) mod external_profile;
pub(crate) mod github_login;
pub(crate) mod google_login;
pub(crate) mod login_capabilities;
pub(crate) mod login_commands;
pub(crate) mod login_sessions;
pub(crate) mod management_access;
pub(crate) mod management_handoff;
pub(crate) mod registration;
pub(crate) mod sensitive_transactions;
pub(crate) mod sync_read_proof;
pub(crate) mod test_admission;

use crate::core::{http::Result, identity::Auth};
use worker::{Method, Response};

pub(crate) async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Response> {
    if path.starts_with("/api/v2/auth/external/") {
        return external_login::browser(a, path, method).await;
    }
    #[cfg(feature = "mock-provider")]
    if path.starts_with("/api/v2/auth/mock/") {
        return external_login::browser(a, path, method).await;
    }
    if path == "/api/v2/auth/capabilities" {
        return login_capabilities::route(a, method).await;
    }
    if matches!(
        path,
        "/api/v2/auth/login/password"
            | "/api/v2/auth/login/code"
            | "/api/v2/auth/verification-codes"
    ) {
        return login_commands::route(a, path, method).await;
    }
    if path == "/api/v2/auth/transactions" || path.starts_with("/api/v2/auth/transactions/") {
        return registration::route(a, path, method).await;
    }
    login_sessions::route(a, path, method).await
}
