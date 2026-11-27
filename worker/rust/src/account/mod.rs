pub(crate) mod management;

pub(crate) use management::route;

pub(crate) fn matches(path: &str) -> bool {
    path == "/api/v1/users/me"
        || path.starts_with("/api/v1/users/me/")
        || path == "/api/v1/auth/password-reset/complete"
}
