pub(crate) mod management;

pub(crate) use management::route;

pub(crate) fn matches(path: &str) -> bool {
    path == "/api/v2/users/me"
        || path.starts_with("/api/v2/users/me/")
        || path == "/api/v2/auth/password-reset/complete"
}
