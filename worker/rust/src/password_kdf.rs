//! Private, stateless password computation. No public route exposes this class.
//! Native Web Crypto rejects 600k PBKDF2 on production Workers; RustCrypto keeps
//! the exact credential algorithm inside a Durable Object's separate CPU budget.
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use worker::*;

const ITERATIONS: u32 = 600_000;
const SALT_BYTES: usize = 16;
const KEY_BYTES: usize = 32;
const MAX_BODY_BYTES: usize = 4096;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Derivation {
    password: String,
    salt: String,
}

fn compute(input: &Derivation) -> Option<Vec<u8>> {
    // Parameters are fixed by the credential format, never supplied by callers.
    if input.password.len() > 512 || input.salt.len() != SALT_BYTES * 2 {
        return None;
    }
    let salt = hex::decode(&input.salt).ok()?;
    let mut output = vec![0; KEY_BYTES];
    pbkdf2_hmac::<Sha256>(input.password.as_bytes(), &salt, ITERATIONS, &mut output);
    Some(output)
}

#[durable_object]
pub struct PasswordKdf {}

impl DurableObject for PasswordKdf {
    fn new(_state: State, _env: Env) -> Self {
        Self {}
    }

    async fn fetch(&self, mut request: Request) -> Result<Response> {
        if request.method() != Method::Post || request.path() != "/derive" {
            return Response::error("Not found", 404);
        }
        let bytes = request.bytes().await?;
        if bytes.len() > MAX_BODY_BYTES {
            return Response::error("Invalid request", 400);
        }
        let Ok(input) = serde_json::from_slice::<Derivation>(&bytes) else {
            return Response::error("Invalid request", 400);
        };
        let Some(output) = compute(&input) else {
            return Response::error("Invalid request", 400);
        };
        let mut response = Response::from_bytes(output)?;
        response.headers_mut().set("Cache-Control", "no-store")?;
        Ok(response)
    }
}

pub async fn remote_derive(password: &str, salt: &[u8], env: &Env) -> Result<Vec<u8>> {
    let result = async {
        let namespace = env.durable_object("PASSWORD_KDF")?;
        // A new stateless instance per computation avoids serializing all logins
        // behind one object. No password, salt or derived key is persisted.
        let stub = namespace.unique_id()?.get_stub()?;
        let body = serde_json::to_string(&Derivation {
            password: password.to_owned(),
            salt: hex::encode(salt),
        })?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post).with_body(Some(body.into()));
        let request = Request::new_with_init("https://password-kdf.internal/derive", &init)?;
        // No retry or local fallback: an unavailable KDF must fail closed.
        let mut response = stub.fetch_with_request(request).await?;
        if response.status_code() != 200 {
            return Err(Error::RustError("AUTH_PASSWORD_KDF_UNAVAILABLE".into()));
        }
        let bytes = response.bytes().await?;
        if bytes.len() != KEY_BYTES {
            return Err(Error::RustError(
                "AUTH_PASSWORD_KDF_INVALID_RESPONSE".into(),
            ));
        }
        Ok(bytes)
    }
    .await;
    if result.is_err() {
        console_error!("AUTH_PASSWORD_KDF_UNAVAILABLE");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_jdk_record_is_unchanged() {
        let input = Derivation {
            password: "migration-test-密码-é".into(),
            salt: "000102030405060708090a0b0c0d0e0f".into(),
        };
        assert_eq!(
            hex::encode(compute(&input).unwrap()),
            "08acf49901aaf21cdef94f9532bb327863e74f577a312f971f4e7098044612fe"
        );
    }
    #[test]
    fn parameters_are_fixed_and_inputs_bounded() {
        for (password, salt) in [
            ("a".repeat(513), "00".repeat(16)),
            ("password".into(), "00".repeat(15)),
            ("password".into(), "zz".repeat(16)),
        ] {
            assert!(compute(&Derivation { password, salt }).is_none());
        }
        assert!(
            serde_json::from_str::<Derivation>(r#"{"password":"x","salt":"00","iterations":1}"#)
                .is_err()
        );
    }
}
