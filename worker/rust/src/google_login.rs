//! Google OIDC adapter. Provider identity is issuer + sub, never email.
use crate::{http::*, identity::Auth, security::challenge};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use worker::Url;

pub(crate) const ISSUER: &str = "https://accounts.google.com";
#[wasm_bindgen(module = "/src/runtime/federation.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = authFetchJson)]
    async fn fetch_json(url: &str, form: &str) -> std::result::Result<String, JsValue>;
    #[wasm_bindgen(catch, js_name = authVerify)]
    async fn verify(jwk: &str, input: &str, signature: &str) -> std::result::Result<bool, JsValue>;
}
fn unavailable() -> Failure {
    Failure {
        status: 503,
        code: "UPSTREAM_UNAVAILABLE",
    }
}
fn invalid() -> Failure {
    Failure {
        status: 401,
        code: "INVALID_CREDENTIALS",
    }
}
fn decode(s: &str) -> Result<Value> {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(s).map_err(|_| invalid())?)
        .map_err(|_| invalid())
}
pub(crate) struct Google {
    id: String,
    secret: String,
    redirect: String,
}
impl Google {
    pub(crate) fn configured(a: &Auth) -> Result<Self> {
        let url = Url::parse(&a.origin).map_err(|_| unavailable())?;
        ensure(
            url.scheme() == "https"
                || (url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))),
            503,
            "UPSTREAM_UNAVAILABLE",
        )?;
        let id = a
            .env
            .var("UNIFIED_GOOGLE_CLIENT_ID")
            .map_err(|_| unavailable())?
            .to_string();
        let secret = a
            .env
            .secret("UNIFIED_GOOGLE_CLIENT_SECRET")
            .map_err(|_| unavailable())?
            .to_string();
        ensure(
            id.ends_with(".apps.googleusercontent.com") && !secret.is_empty() && secret != "222",
            503,
            "UPSTREAM_UNAVAILABLE",
        )?;
        Ok(Self {
            id,
            secret,
            redirect: format!("{}/api/v2/auth/external/google/callback", a.origin),
        })
    }
    pub(crate) fn authorize_url(&self, state: &str, verifier: &str, nonce: &str) -> Result<Url> {
        let mut url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
            .map_err(|_| unavailable())?;
        url.query_pairs_mut()
            .append_pair("client_id", &self.id)
            .append_pair("redirect_uri", &self.redirect)
            .append_pair("response_type", "code")
            .append_pair("scope", "openid email profile")
            .append_pair("state", state)
            .append_pair("nonce", nonce)
            .append_pair("code_challenge", &challenge(verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("prompt", "select_account");
        Ok(url)
    }
    pub(crate) async fn exchange(&self, code: &str, verifier: &str, nonce: &str) -> Result<Value> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", &self.id)
            .append_pair("client_secret", &self.secret)
            .append_pair("grant_type", "authorization_code")
            .append_pair("code", code)
            .append_pair("redirect_uri", &self.redirect)
            .append_pair("code_verifier", verifier)
            .finish();
        let raw = fetch_json("https://oauth2.googleapis.com/token", &body)
            .await
            .map_err(|_| unavailable())?;
        let token: Value = serde_json::from_str(&raw).map_err(|_| unavailable())?;
        let jwt = token["id_token"]
            .as_str()
            .filter(|v| v.len() <= 16384)
            .ok_or_else(invalid)?;
        let parts: Vec<_> = jwt.split('.').collect();
        ensure(parts.len() == 3, 401, "INVALID_CREDENTIALS")?;
        let header = decode(parts[0])?;
        let kid = header["kid"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(invalid)?;
        ensure(header["alg"] == "RS256", 401, "INVALID_CREDENTIALS")?;
        let raw = fetch_json("https://www.googleapis.com/oauth2/v3/certs", "")
            .await
            .map_err(|_| unavailable())?;
        let keys: Value = serde_json::from_str(&raw).map_err(|_| unavailable())?;
        let key = keys["keys"]
            .as_array()
            .ok_or_else(unavailable)?
            .iter()
            .find(|k| {
                k["kid"] == kid && k["kty"] == "RSA" && k["alg"] == "RS256" && k["use"] == "sig"
            })
            .ok_or_else(invalid)?;
        ensure(
            verify(
                &key.to_string(),
                &format!("{}.{}", parts[0], parts[1]),
                parts[2],
            )
            .await
            .map_err(|_| invalid())?,
            401,
            "INVALID_CREDENTIALS",
        )?;
        let claims = decode(parts[1])?;
        validate_claims(&claims, &self.id, nonce, now() / 1000)?;
        let name = claims["name"]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty() && !v.chars().any(char::is_control))
            .map(|v| v.chars().take(80).collect::<String>());
        let email = if claims["email_verified"] == true {
            crate::http::email(&claims["email"]).ok()
        } else {
            None
        };
        let picture = claims["picture"]
            .as_str()
            .filter(|v| v.len() <= 2048)
            .and_then(|v| {
                let u = Url::parse(v).ok()?;
                let host = u.host_str()?;
                (u.scheme() == "https"
                    && (host == "googleusercontent.com"
                        || host.ends_with(".googleusercontent.com"))
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.port().is_none()
                    && u.fragment().is_none())
                .then(|| u.to_string())
            });
        Ok(
            json!({"issuer":ISSUER,"subject":claims["sub"],"profile":{"name":name,"email":email,"avatar":picture}}),
        )
    }
}
fn validate_claims(v: &Value, id: &str, nonce: &str, time: i64) -> Result<()> {
    let subject = v["sub"].as_str().unwrap_or_default();
    ensure(
        matches!(
            v["iss"].as_str(),
            Some("https://accounts.google.com" | "accounts.google.com")
        ) && v["aud"] == id
            && (v.get("azp").is_none() || v["azp"] == id)
            && v["nonce"] == nonce
            && !nonce.is_empty()
            && v["exp"].as_i64().is_some_and(|n| n > time)
            && v["iat"].as_i64().is_some_and(|n| n <= time + 60)
            && !subject.is_empty()
            && subject.len() <= 255
            && subject.is_ascii(),
        401,
        "INVALID_CREDENTIALS",
    )
}
