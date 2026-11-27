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
use serde_json::Value;
use worker::Method;

pub(crate) fn external_route(path: &str) -> bool {
    path.starts_with("/api/v1/auth/external/")
        || (cfg!(feature = "mock-provider") && path.starts_with("/api/v1/auth/mock/"))
}

pub(crate) async fn route(a: &mut Auth, path: &str, method: Method) -> Result<Value> {
    if path == "/api/v1/auth/capabilities" {
        return login_capabilities::route(a, method).await;
    }
    if matches!(
        path,
        "/api/v1/auth/login/password"
            | "/api/v1/auth/login/code"
            | "/api/v1/auth/verification-codes"
    ) {
        return login_commands::route(a, path, method).await;
    }
    if path == "/api/v1/auth/transactions" || path.starts_with("/api/v1/auth/transactions/") {
        return registration::route(a, path, method).await;
    }
    login_sessions::route(a, path, method).await
}
