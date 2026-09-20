use crate::{
    http::*,
    identity::{ALIVE, Auth},
    security::*,
};
use serde_json::{Value, json};

impl Auth {
    pub async fn token(&self, b: &Value) -> Result<Value> {
        if b["grant_type"] == "client_credentials" {
            return self.service_token(b).await;
        }
        ensure(
            self.header("Authorization").is_empty() && b.get("client_secret").is_none(),
            400,
            "INVALID_CLIENT",
        )?;
        let c = self.client(&text(b, "client_id")).await?;
        self.check_origin(&c)?;
        self.rate_ip("token-ip", 120).await?;
        let n = now();
        let access = secret();
        let refresh = secret();
        let mut writes = vec![];
        let (grant, scopes, root_id);
        if b["grant_type"] == "authorization_code" {
            let code = text(b, "code");
            let verifier = text(b, "code_verifier");
            ensure(
                token(&code)
                    && (43..=128).contains(&verifier.len())
                    && verifier
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._~-".contains(&c)),
                400,
                "INVALID_GRANT",
            )?;
            let digest = hash(&code);
            let row = self
                .s
                .one(
                    "SELECT * FROM auth_code WHERE token_hash=?",
                    vec![digest.clone().into()],
                )
                .await?;
            ensure(
                !row.is_null()
                    && row["client_id"] == c["client_id"]
                    && row["redirect_uri"] == b["redirect_uri"]
                    && contains(&parsed(&c, "redirects")?, &row["redirect_uri"])
                    && number(&row, "expires_at") > n
                    && row["used_at"].is_null()
                    && row["challenge"] == challenge(&verifier),
                400,
                "INVALID_GRANT",
            )?;
            grant = uuid();
            scopes = text(&row, "scopes");
            root_id = text(&row, "authentication_id");
            writes.extend([
                self.s.guard("EXISTS(SELECT 1 FROM auth_code WHERE token_hash=? AND used_at IS NULL AND expires_at>?)",vec![digest.clone().into(),n.into()])?,
                self.s.statement("UPDATE auth_code SET used_at=? WHERE token_hash=?",vec![n.into(),digest.into()])?,
                self.s.statement("INSERT INTO auth_grant(id,authentication_id,client_id,scopes,created_at) VALUES (?,?,?,?,?)",vec![grant.clone().into(),root_id.clone().into(),c["client_id"].clone(),scopes.clone().into(),n.into()])?
            ]);
        } else if b["grant_type"] == "refresh_token" {
            let value = text(b, "refresh_token");
            ensure(token(&value), 400, "INVALID_GRANT")?;
            let digest = hash(&value);
            let row=self.s.one("SELECT r.*,g.authentication_id,g.client_id,g.scopes,g.revoked_at FROM auth_refresh_token r JOIN auth_grant g ON g.id=r.grant_id WHERE r.token_hash=?",vec![digest.clone().into()]).await?;
            ensure(
                !row.is_null()
                    && row["client_id"] == c["client_id"]
                    && number(&row, "expires_at") > n
                    && row["revoked_at"].is_null(),
                400,
                "INVALID_GRANT",
            )?;
            if !row["used_at"].is_null() {
                self.s
                    .run(
                        "UPDATE auth_grant SET revoked_at=? WHERE id=?",
                        vec![n.into(), row["grant_id"].clone()],
                    )
                    .await?;
                return Err(Failure {
                    status: 400,
                    code: "INVALID_GRANT",
                });
            }
            grant = text(&row, "grant_id");
            scopes = text(&row, "scopes");
            root_id = text(&row, "authentication_id");
            writes.extend([
                self.s.guard("EXISTS(SELECT 1 FROM auth_refresh_token r JOIN auth_grant g ON g.id=r.grant_id WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>? AND g.revoked_at IS NULL)",vec![digest.clone().into(),n.into()])?,
                self.s.statement("UPDATE auth_refresh_token SET used_at=? WHERE token_hash=?",vec![n.into(),digest.into()])?
            ]);
        } else {
            return Err(Failure {
                status: 400,
                code: "UNSUPPORTED_GRANT_TYPE",
            });
        }
        let a = self.root(&root_id).await?;
        let expires =
            (number(&a, "created_at") + 7776000000).min(number(&a, "activity_at") + 2592000000);
        let scope_values: Value = serde_json::from_str(&scopes)?;
        let allowed = parsed(&c, "scopes")?;
        ensure(
            scope_values
                .as_array()
                .is_some_and(|s| s.iter().all(|v| contains(&allowed, v))),
            400,
            "INVALID_SCOPE",
        )?;
        writes.extend([
            self.s.guard(&format!("EXISTS(SELECT 1 FROM auth_authentication a JOIN auth_user u ON u.id=a.user_id WHERE a.id=? AND {ALIVE})"),vec![root_id.into(),n.into(),n.into()])?,
            self.s.guard("EXISTS(SELECT 1 FROM auth_client c JOIN auth_application a ON a.id=c.application_id WHERE c.client_id=? AND c.version=? AND c.status='ACTIVE' AND a.status='ACTIVE')",vec![c["client_id"].clone(),c["version"].clone()])?,
            self.s.statement("INSERT INTO auth_access_token VALUES (?,?,?)",vec![hash(&access).into(),grant.clone().into(),(n+900000).min(expires).into()])?,
            self.s.statement("INSERT INTO auth_refresh_token VALUES (?,?,?,NULL)",vec![hash(&refresh).into(),grant.clone().into(),expires.into()])?
        ]);
        if let Err(e) = self.s.batch(writes, "INVALID_GRANT").await {
            if b["grant_type"] == "refresh_token" && e.status == 409 {
                self.s
                    .run(
                        "UPDATE auth_grant SET revoked_at=? WHERE id=?",
                        vec![n.into(), grant.into()],
                    )
                    .await?;
            }
            return Err(e);
        }
        Ok(
            json!({"access_token":access,"refresh_token":refresh,"token_type":"Bearer","expires_in":((n+900000).min(expires)-n)/1000,"scope":scope_values.as_array().unwrap().iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")}),
        )
    }
    async fn service_token(&self, b: &Value) -> Result<Value> {
        ensure(self.header("Origin").is_empty(), 400, "INVALID_CLIENT")?;
        fields(b, &["grant_type"], &["scope"])?;
        ensure(
            b.get("scope").is_none() || b["scope"] == "authorization",
            400,
            "INVALID_SCOPE",
        )?;
        self.rate_ip("service-ip", 60).await?;
        let basic = self.header("Authorization");
        ensure(
            basic.len() <= 506
                && basic
                    .get(..6)
                    .is_some_and(|s| s.eq_ignore_ascii_case("Basic ")),
            401,
            "INVALID_CLIENT",
        )?;
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&basic[6..])
            .map_err(|_| Failure {
                status: 401,
                code: "INVALID_CLIENT",
            })?;
        let decoded = String::from_utf8(bytes).map_err(|_| Failure {
            status: 401,
            code: "INVALID_CLIENT",
        })?;
        let (client, credential) = decoded.split_once(':').ok_or(Failure {
            status: 401,
            code: "INVALID_CLIENT",
        })?;
        let decode = |s: &str| -> Result<String> {
            js_sys::decode_uri_component(s)
                .map(String::from)
                .map_err(|_| Failure {
                    status: 401,
                    code: "INVALID_CLIENT",
                })
        };
        let client = decode(client)?;
        let credential = decode(credential)?;
        ensure(!client.is_empty(), 401, "INVALID_CLIENT")?;
        self.rate("service-client", &client, 30, 60000).await?;
        let row=self.s.one("SELECT s.id,s.credential_id FROM auth_service s JOIN auth_application a ON a.id=s.application_id WHERE s.client_id=? AND s.secret_hash=? AND s.status='ACTIVE' AND a.status='ACTIVE'",vec![client.into(),hash(&credential).into()]).await?;
        ensure(!row.is_null(), 401, "INVALID_CLIENT")?;
        let access = secret();
        self.s.batch(vec![self.s.guard("EXISTS(SELECT 1 FROM auth_service WHERE id=? AND credential_id=? AND status='ACTIVE')",vec![row["id"].clone(),row["credential_id"].clone()])?,self.s.statement("INSERT INTO auth_service_token VALUES (?,?,?,?)",vec![hash(&access).into(),row["id"].clone(),row["credential_id"].clone(),(now()+300000).into()])?],"VERSION_CONFLICT").await?;
        Ok(
            json!({"access_token":access,"token_type":"Bearer","expires_in":300,"scope":"authorization"}),
        )
    }
}
