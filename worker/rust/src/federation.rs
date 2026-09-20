//! OAuth/OIDC business rules are Rust. Native Web Crypto performs AES-GCM and RSA.
use crate::{
    http::*,
    identity::Auth,
    security::{challenge, hash, secret, uuid},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use worker::{Method, Response, Url};

#[wasm_bindgen(module = "/src/runtime/federation.js")]
extern "C" {
    #[wasm_bindgen(catch,js_name=authSeal)]
    async fn seal(key: &str, value: &str) -> std::result::Result<String, JsValue>;
    #[wasm_bindgen(catch,js_name=authOpen)]
    async fn open(key: &str, value: &str) -> std::result::Result<String, JsValue>;
    #[wasm_bindgen(catch,js_name=authVerify)]
    async fn verify(key: &str, input: &str, signature: &str) -> std::result::Result<bool, JsValue>;
    #[wasm_bindgen(catch,js_name=authFetchJson)]
    async fn fetch_json(url: &str, form: &str) -> std::result::Result<String, JsValue>;
}
fn unavailable(_: JsValue) -> Failure {
    Failure {
        status: 503,
        code: "PROVIDER_UNAVAILABLE",
    }
}
fn setting(a: &Auth, key: &str) -> String {
    a.env
        .secret(key)
        .map(|v| v.to_string())
        .or_else(|_| a.env.var(key).map(|v| v.to_string()))
        .unwrap_or_default()
}
pub fn providers(a: &Auth) -> Vec<&'static str> {
    if !a.origin.starts_with("https:") || setting(a, "PROVIDER_STATE_KEY").is_empty() {
        return vec![];
    }
    ["google", "apple"]
        .into_iter()
        .filter(|p| {
            let prefix = p.to_uppercase();
            !setting(a, &format!("{prefix}_CLIENT_ID")).is_empty()
                && !setting(a, &format!("{prefix}_CLIENT_SECRET")).is_empty()
        })
        .collect()
}
struct Settings {
    google: bool,
    client: String,
    secret: String,
    authorization: &'static str,
    token: &'static str,
    keys: &'static str,
    callback: String,
}
fn settings(a: &Auth, provider: &str) -> Result<Settings> {
    ensure(
        providers(a).contains(&provider),
        409,
        "PROVIDER_NOT_ENABLED",
    )?;
    let google = provider == "google";
    let prefix = provider.to_uppercase();
    Ok(Settings {
        google,
        client: setting(a, &format!("{prefix}_CLIENT_ID")),
        secret: setting(a, &format!("{prefix}_CLIENT_SECRET")),
        authorization: if google {
            "https://accounts.google.com/o/oauth2/v2/auth"
        } else {
            "https://appleid.apple.com/auth/authorize"
        },
        token: if google {
            "https://oauth2.googleapis.com/token"
        } else {
            "https://appleid.apple.com/auth/token"
        },
        keys: if google {
            "https://www.googleapis.com/oauth2/v3/certs"
        } else {
            "https://appleid.apple.com/auth/keys"
        },
        callback: format!("{}/oauth2/callback/{provider}", a.origin),
    })
}
fn binding(state: &str, value: &str, ttl: i32) -> String {
    format!(
        "__Host-auth_provider_{state}={value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age={ttl}"
    )
}
pub async fn start(a: &mut Auth, provider: &str, bind: bool) -> Result<Value> {
    a.auth_origin()?;
    let cfg = settings(a, provider)?;
    let (t, ctx, transaction) = a.transaction().await?;
    ensure(t["status"] == "READY", 400, "INVALID_TRANSACTION")?;
    a.rate_ip("provider-start", 20).await?;
    let target = if bind {
        let p = a.principal(None).await?;
        let root = a.root(&text(&p, "authenticationId")).await?;
        ensure(
            now() - number(&root, "created_at") < 900000 && p["clientId"] == ctx["clientId"],
            401,
            "FULL_LOGIN_REQUIRED",
        )?;
        json!({"user":p["userId"],"grant":p["sessionId"],"root":p["authenticationId"]})
    } else {
        Value::Null
    };
    let state = secret();
    let nonce = secret();
    let browser = secret();
    let verifier = secret();
    let encrypted = seal(
        &setting(a, "PROVIDER_STATE_KEY"),
        &json!({"transaction":transaction,"nonce":nonce,"verifier":verifier,"target":target})
            .to_string(),
    )
    .await
    .map_err(unavailable)?;
    a.s.run("INSERT INTO auth_one_use(token_hash,purpose,binding_hash,payload,expires_at) VALUES (?,'PROVIDER',?,?,?)",vec![hash(&state).into(),hash(&format!("{provider}:{browser}")).into(),json!(encrypted).to_string().into(),(now()+300000).into()]).await?;
    let mut url = Url::parse(cfg.authorization).unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", cfg.client.as_str()),
        ("response_type", "code"),
        ("redirect_uri", cfg.callback.as_str()),
        (
            "scope",
            if cfg.google {
                "openid email profile"
            } else {
                "openid email"
            },
        ),
        (
            "response_mode",
            if cfg.google { "query" } else { "form_post" },
        ),
        ("state", state.as_str()),
        ("nonce", nonce.as_str()),
    ]);
    if cfg.google {
        url.query_pairs_mut().extend_pairs([
            ("access_type", "online"),
            ("code_challenge", challenge(&verifier).as_str()),
            ("code_challenge_method", "S256"),
        ]);
    }
    a.cookies.push(binding(&state, &browser, 300));
    Ok(json!({"authorizationUrl":url.as_str()}))
}
fn decode_json(s: &str) -> Result<Value> {
    let bytes = URL_SAFE_NO_PAD.decode(s).map_err(|_| Failure {
        status: 400,
        code: "PROVIDER_REJECTED",
    })?;
    serde_json::from_slice(&bytes).map_err(|_| Failure {
        status: 400,
        code: "PROVIDER_REJECTED",
    })
}
async fn claims(cfg: &Settings, encoded: &str, nonce: &str) -> Result<Value> {
    let parts: Vec<_> = encoded.split('.').collect();
    ensure(parts.len() == 3, 400, "PROVIDER_REJECTED")?;
    let header = decode_json(parts[0])?;
    let payload = decode_json(parts[1])?;
    ensure(
        header["alg"] == "RS256"
            && header.get("crit").is_none()
            && header.get("b64").is_none_or(|v| v == true),
        400,
        "PROVIDER_REJECTED",
    )?;
    let keys: Value = serde_json::from_str(&fetch_json(cfg.keys, "").await.map_err(unavailable)?)?;
    let candidates: Vec<_> = keys["keys"]
        .as_array()
        .ok_or(Failure {
            status: 400,
            code: "PROVIDER_REJECTED",
        })?
        .iter()
        .filter(|k| {
            k["kty"] == "RSA"
                && (header.get("kid").is_none() || k["kid"] == header["kid"])
                && k.get("use").is_none_or(|u| u == "sig")
                && k.get("alg").is_none_or(|a| a == "RS256")
                && k.get("key_ops")
                    .is_none_or(|a| contains(a, &json!("verify")))
        })
        .collect();
    ensure(candidates.len() == 1, 400, "PROVIDER_REJECTED")?;
    ensure(
        verify(
            &candidates[0].to_string(),
            &format!("{}.{}", parts[0], parts[1]),
            parts[2],
        )
        .await
        .map_err(unavailable)?,
        400,
        "PROVIDER_REJECTED",
    )?;
    validate_claims(cfg.google, &cfg.client, &payload, nonce, now() / 1000)?;
    Ok(payload)
}
fn validate_claims(google: bool, client: &str, p: &Value, nonce: &str, n: i64) -> Result<()> {
    let issuer = text(p, "iss");
    let valid_issuer = if google {
        ["https://accounts.google.com", "accounts.google.com"].contains(&issuer.as_str())
    } else {
        issuer == "https://appleid.apple.com"
    };
    ensure(
        valid_issuer
            && (p["aud"] == client || contains(&p["aud"], &json!(client)))
            && p["nonce"] == nonce
            && p["sub"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 255)
            && p["exp"].is_i64()
            && number(p, "exp") > n
            && p["iat"].is_i64()
            && number(p, "iat") <= n
            && n - number(p, "iat") <= 600
            && p.get("nbf")
                .is_none_or(|v| v.as_i64().is_some_and(|t| t <= n))
            && p.get("azp").is_none_or(|v| v == client),
        400,
        "PROVIDER_REJECTED",
    )
}
pub async fn callback(a: &mut Auth, provider: &str) -> Result<Response> {
    let cfg = settings(a, provider)?;
    ensure(
        a.request.method()
            == if cfg.google {
                Method::Get
            } else {
                Method::Post
            },
        405,
        "INVALID_REQUEST",
    )?;
    let b = if cfg.google {
        form(a.request.url()?.query().unwrap_or_default())?
    } else {
        ensure(
            a.header("Content-Type").split(';').next() == Some("application/x-www-form-urlencoded"),
            415,
            "INVALID_REQUEST",
        )?;
        form(&crate::app::bounded(a, 16384).await?)?
    };
    let state = text(&b, "state");
    let browser = cookie(
        &a.header("Cookie"),
        &format!("__Host-auth_provider_{state}"),
    );
    ensure(token(&state) && token(&browser), 400, "INVALID_TRANSACTION")?;
    let row=a.s.one("DELETE FROM auth_one_use WHERE token_hash=? AND purpose='PROVIDER' AND binding_hash=? AND expires_at>? RETURNING payload",vec![hash(&state).into(),hash(&format!("{provider}:{browser}")).into(),now().into()]).await?;
    ensure(!row.is_null(), 400, "INVALID_TRANSACTION")?;
    let sealed = parsed(&row, "payload")?;
    let sealed = string(&sealed, 8192)?;
    a.cookies.push(binding(&state, "", 0));
    let result = finish(a, provider, &cfg, &b, sealed).await;
    let location = match result {
        Ok(transaction) => format!("{}/complete#transaction={transaction}", a.origin),
        Err(e) => format!("{}/login#provider-error={}", a.origin, e.code),
    };
    let mut response = Response::empty()?.with_status(303);
    response.headers_mut().set("Location", &location)?;
    Ok(response)
}
async fn finish(
    a: &Auth,
    provider: &str,
    cfg: &Settings,
    b: &Value,
    sealed: &str,
) -> Result<String> {
    ensure(b.get("error").is_none(), 400, "PROVIDER_DENIED")?;
    let data: Value = serde_json::from_str(
        &open(&setting(a, "PROVIDER_STATE_KEY"), sealed)
            .await
            .map_err(|e| {
                worker::console_error!("PROVIDER_STATE_DECRYPT_FAILED");
                unavailable(e)
            })?,
    )?;
    let digest = hash(&text(&data, "transaction"));
    let n = now();
    let t =
        a.s.one(
            "SELECT status,expires_at FROM auth_transaction WHERE token_hash=?",
            vec![digest.clone().into()],
        )
        .await?;
    ensure(
        t["status"] == "READY" && number(&t, "expires_at") > n,
        400,
        "INVALID_TRANSACTION",
    )?;
    let code = string(&b["code"], 4096)?;
    ensure(!code.is_empty(), 400, "INVALID_REQUEST")?;
    let mut form = Url::parse("https://form.invalid").unwrap();
    form.query_pairs_mut().extend_pairs([
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", cfg.client.as_str()),
        ("client_secret", cfg.secret.as_str()),
        ("redirect_uri", cfg.callback.as_str()),
    ]);
    if cfg.google {
        form.query_pairs_mut()
            .append_pair("code_verifier", &text(&data, "verifier"));
    }
    let tokens: Value = serde_json::from_str(
        &fetch_json(cfg.token, form.query().unwrap())
            .await
            .map_err(unavailable)?,
    )?;
    let encoded = string(&tokens["id_token"], 20000)?;
    let payload = claims(cfg, encoded, &text(&data, "nonce")).await?;
    let issuer = if cfg.google {
        "https://accounts.google.com"
    } else {
        "https://appleid.apple.com"
    };
    let identity =
        a.s.one(
            "SELECT user_id FROM auth_external_identity WHERE issuer=? AND subject=?",
            vec![issuer.into(), payload["sub"].clone()],
        )
        .await?;
    let mut user = text(&identity, "user_id");
    let target = &data["target"];
    let mut writes=vec![a.s.guard("EXISTS(SELECT 1 FROM auth_transaction WHERE token_hash=? AND status='READY' AND expires_at>?)",vec![digest.clone().into(),n.into()])?];
    if !target.is_null() {
        ensure(
            user.is_empty() || target["user"] == user,
            409,
            "IDENTITY_ALREADY_LINKED",
        )?;
        user = text(target, "user");
        writes.push(a.s.guard("EXISTS(SELECT 1 FROM auth_grant g JOIN auth_authentication a ON a.id=g.authentication_id JOIN auth_user u ON u.id=a.user_id WHERE g.id=? AND g.revoked_at IS NULL AND a.id=? AND a.user_id=? AND a.revoked_at IS NULL AND a.created_at>? AND u.status='ACTIVE')",vec![target["grant"].clone(),target["root"].clone(),user.clone().into(),(n-900000).into()])?);
    } else if user.is_empty() {
        ensure(
            payload["email_verified"] == true || payload["email_verified"] == "true",
            409,
            "PROVIDER_EMAIL_REQUIRED",
        )?;
        let address = email(&payload["email"])?;
        ensure(
            a.s.one(
                "SELECT id FROM auth_user_email WHERE canonical_email=?",
                vec![address.clone().into()],
            )
            .await?
            .is_null(),
            409,
            "ACCOUNT_LINK_REQUIRED",
        )?;
        user = uuid();
        let space = uuid();
        writes.extend([
            a.s.statement("INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,?,'ACTIVE',?,?)",vec![user.clone().into(),address.split('@').next().unwrap().into(),n.into(),n.into()])?,
            a.s.statement("INSERT INTO auth_user_email VALUES (?,?,?,?,?)",vec![uuid().into(),user.clone().into(),address.into(),n.into(),n.into()])?,
            a.s.statement("INSERT INTO auth_space(id,name,space_type,status,personal_user_id,created_at,updated_at) VALUES (?,'个人空间','PERSONAL','ACTIVE',?,?,?)",vec![space.clone().into(),user.clone().into(),n.into(),n.into()])?,
            a.s.statement("INSERT INTO auth_membership VALUES (?,?,'OWNER',?)",vec![space.into(),user.clone().into(),n.into()])?
        ]);
    }
    ensure(!user.is_empty(), 400, "PROVIDER_REJECTED")?;
    if identity.is_null() {
        writes.push(a.s.statement(
            "INSERT INTO auth_external_identity VALUES (?,?,?,?,?,?)",
            vec![
                uuid().into(),
                user.clone().into(),
                provider.to_uppercase().into(),
                issuer.into(),
                payload["sub"].clone(),
                n.into(),
            ],
        )?);
    }
    let root = uuid();
    writes.extend([a.s.guard("EXISTS(SELECT 1 FROM auth_user WHERE id=? AND status='ACTIVE')",vec![user.clone().into()])?,a.s.statement("INSERT INTO auth_authentication(id,user_id,created_at,activity_at) VALUES (?,?,?,?)",vec![root.clone().into(),user.clone().into(),n.into(),n.into()])?,a.s.statement("UPDATE auth_transaction SET status='AUTHENTICATED',authentication_id=? WHERE token_hash=?",vec![root.into(),digest.into()])?,a.s.audit(if target.is_null(){"account.external.login"}else{"account.external.bind"},user.into(),&a.request_id,Value::Null,Value::Null,Value::Null,false)?]);
    a.s.batch(writes, "INVALID_TRANSACTION").await?;
    Ok(text(&data, "transaction"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oidc_claims_are_bound_to_client_nonce_and_time() {
        let p = json!({"iss":"https://accounts.google.com","aud":"client","sub":"user","nonce":"n","iat":1000,"exp":2000});
        assert!(validate_claims(true, "client", &p, "n", 1200).is_ok());
        assert!(validate_claims(true, "other", &p, "n", 1200).is_err());
        assert!(validate_claims(true, "client", &p, "bad", 1200).is_err());
        assert!(validate_claims(true, "client", &p, "n", 2001).is_err());
        assert!(validate_claims(true, "client", &p, "n", 1601).is_err());
    }
}
