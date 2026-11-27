use crate::{auth::login_sessions, core::http::*, core::identity::Auth};
use serde_json::{Value, json};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;
use worker::{Method, Response};

#[wasm_bindgen(module = "/src/runtime/sync-read-proof.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = signSyncReadProof)]
    async fn sign(key: &str, payload: &str) -> std::result::Result<JsValue, JsValue>;
}

fn configuration() -> Failure {
    Failure {
        status: 503,
        code: "SYNC_SIGNING_UNAVAILABLE",
    }
}

thread_local! {
    static PUBLIC_JWKS: RefCell<Option<(String, Value)>> = const { RefCell::new(None) };
}

fn public_jwks(configured: &str) -> Result<Value> {
    PUBLIC_JWKS.with(|cache| {
        let digest = crate::core::security::hash(configured);
        let mut cache = cache.borrow_mut();
        if let Some((_, jwks)) = cache.as_ref().filter(|(stored, _)| stored == &digest) {
            return Ok(jwks.clone());
        }
        let private: Value = serde_json::from_str(configured).map_err(|_| configuration())?;
        let kid = text(&private, "kid");
        let public = text(&private, "x");
        ensure(
            private["kty"] == "OKP" && private["crv"] == "Ed25519"
            && !kid.is_empty() && kid.len() <= 80 && token(&public) && token(&text(&private, "d")),
            503,
            "SYNC_SIGNING_UNAVAILABLE",
        )?;
        let jwks = json!({"keys":[{"kty":"OKP","crv":"Ed25519","kid":kid,"x":public,"alg":"EdDSA","use":"sig"}]});
        *cache = Some((digest, jwks.clone()));
        Ok(jwks)
    })
}

pub(crate) fn matches(path: &str) -> bool {
    matches!(
        path,
        "/.well-known/molis-sync-jwks.json" | "/api/v1/auth/sync-read-proof"
    )
}

pub(crate) async fn route(a: &Auth, path: &str, method: Method) -> Result<Response> {
    ensure(method == Method::Get, 405, "METHOD_NOT_ALLOWED")?;
    let configured = a
        .env
        .secret("SYNC_READ_SIGNING_JWK")
        .map_err(|_| Failure {
            status: 404,
            code: "NOT_FOUND",
        })?
        .to_string();
    let jwks = public_jwks(&configured)?;
    if path == "/.well-known/molis-sync-jwks.json" {
        let mut response = json_response(jwks, 200)?;
        response
            .headers_mut()
            .set("Cache-Control", "public, max-age=60")?;
        return Ok(response);
    }
    let (session, client) = login_sessions::active(a).await?;
    let issued = now() / 1000;
    let expires = (issued + 30).min(number(&session, "access_expires_at") / 1000);
    ensure(expires > issued, 401, "SESSION_EXPIRED")?;
    let payload = json!({
        "iss": a.origin, "aud": client["application_id"], "sub": session["user_id"],
        "iat": issued, "exp": expires, "token_sha256": session["access_hash"],
        "scope": "molis-sync:read"
    });
    let proof = sign(&configured, &payload.to_string())
        .await
        .map_err(|_| configuration())?
        .as_string()
        .ok_or_else(configuration)?;
    Ok(json_response(json!({"data":{"proof":proof}}), 200)?)
}
