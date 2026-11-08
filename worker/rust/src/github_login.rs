use crate::{http::*, identity::Auth, security::challenge};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use worker::Url;

pub(crate) const ISSUER: &str = "https://github.com";

#[wasm_bindgen(module = "/src/runtime/federation.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = githubUser)]
    async fn github_user(body: &str) -> std::result::Result<String, JsValue>;
}

fn unavailable() -> Failure {
    Failure {
        status: 503,
        code: "UPSTREAM_UNAVAILABLE",
    }
}

pub(crate) struct Github {
    id: String,
    secret: String,
    redirect: String,
}

impl Github {
    pub(crate) const AUTHORIZATION_ISSUER: &str = "https://github.com/login/oauth";

    pub(crate) fn configured(a: &Auth) -> Result<Self> {
        ensure(a.origin.starts_with("https:"), 503, "UPSTREAM_UNAVAILABLE")?;
        let id = a
            .env
            .var("UNIFIED_GITHUB_CLIENT_ID")
            .map_err(|_| unavailable())?
            .to_string();
        let secret = a
            .env
            .secret("UNIFIED_GITHUB_CLIENT_SECRET")
            .map_err(|_| unavailable())?
            .to_string();
        ensure(
            !id.is_empty() && !secret.is_empty(),
            503,
            "UPSTREAM_UNAVAILABLE",
        )?;
        Ok(Self {
            id,
            secret,
            redirect: format!("{}/api/v2/auth/external/github/callback", a.origin),
        })
    }

    pub(crate) fn authorize_url(&self, state: &str, verifier: &str) -> Result<Url> {
        let mut url =
            Url::parse("https://github.com/login/oauth/authorize").map_err(|_| unavailable())?;
        url.query_pairs_mut()
            .append_pair("client_id", &self.id)
            .append_pair("redirect_uri", &self.redirect)
            .append_pair("state", state)
            .append_pair("code_challenge", &challenge(verifier))
            .append_pair("code_challenge_method", "S256");
        Ok(url)
    }

    pub(crate) async fn exchange(&self, code: &str, verifier: &str) -> Result<Value> {
        let body: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", &self.id)
            .append_pair("client_secret", &self.secret)
            .append_pair("code", code)
            .append_pair("redirect_uri", &self.redirect)
            .append_pair("code_verifier", verifier)
            .finish();
        let raw = github_user(&body).await.map_err(|_| unavailable())?;
        let user: Value = serde_json::from_str(&raw).map_err(|_| unavailable())?;
        let id = user["id"].as_u64().filter(|id| *id > 0).ok_or(Failure {
            status: 401,
            code: "INVALID_CREDENTIALS",
        })?;
        Ok(json!({"issuer":ISSUER,"subject":id.to_string()}))
    }
}
