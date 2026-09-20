use crate::{http::*, security::*, store::Store};
use serde_json::{Value, json};
use worker::{Env, Request};

pub const ALIVE: &str = "a.revoked_at IS NULL AND a.activity_at+2592000000>? AND a.created_at+7776000000>? AND u.status='ACTIVE'";
pub struct Auth {
    pub s: Store,
    pub origin: String,
    pub admins: String,
    pub request: Request,
    pub request_id: String,
    pub cookies: Vec<String>,
    pub env: Env,
}
impl Auth {
    pub fn new(request: Request, env: &Env, request_id: String) -> Result<Self> {
        Ok(Self {
            s: Store::new(env.d1("DB")?),
            origin: env.var("AUTH_ORIGIN")?.to_string(),
            admins: env
                .var("PLATFORM_ADMIN_IDS")
                .map(|v| v.to_string())
                .unwrap_or_default(),
            request,
            request_id,
            cookies: vec![],
            env: env.clone(),
        })
    }
    pub fn header(&self, key: &str) -> String {
        self.request
            .headers()
            .get(key)
            .ok()
            .flatten()
            .unwrap_or_default()
    }
    pub fn auth_origin(&self) -> Result<()> {
        ensure(
            self.header("Origin") == self.origin,
            403,
            "AUTH_ORIGIN_REQUIRED",
        )
    }
    pub async fn rate(&self, kind: &str, subject: &str, limit: i64, window: i64) -> Result<()> {
        let n = now();
        let r=self.s.one("INSERT INTO auth_rate_bucket(bucket_hash,hits,expires_at) VALUES (?,1,?) ON CONFLICT(bucket_hash) DO UPDATE SET hits=CASE WHEN auth_rate_bucket.expires_at<=? THEN 1 ELSE auth_rate_bucket.hits+1 END,expires_at=CASE WHEN auth_rate_bucket.expires_at<=? THEN excluded.expires_at ELSE auth_rate_bucket.expires_at END RETURNING hits",vec![hash(&format!("{kind}:{subject}")).into(),(n+window).into(),n.into(),n.into()]).await?;
        ensure(
            !r.is_null() && number(&r, "hits") <= limit,
            429,
            "RATE_LIMITED",
        )
    }
    pub async fn rate_ip(&self, kind: &str, limit: i64) -> Result<()> {
        let ip = self.header("CF-Connecting-IP");
        self.rate(
            kind,
            if ip.is_empty() { "local" } else { &ip },
            limit,
            60000,
        )
        .await
    }
    pub async fn client(&self, id: &str) -> Result<Value> {
        let c=self.s.one("SELECT c.*,a.status app_status FROM auth_client c JOIN auth_application a ON a.id=c.application_id WHERE c.client_id=?",vec![id.into()]).await?;
        ensure(
            c["status"] == "ACTIVE" && c["app_status"] == "ACTIVE",
            400,
            "INVALID_CLIENT",
        )?;
        Ok(c)
    }
    pub fn check_origin(&self, c: &Value) -> Result<()> {
        let origin = self.header("Origin");
        let redirects = parsed(c, "redirects")?;
        let allowed = redirects.as_array().is_some_and(|a| {
            a.iter().any(|v| {
                worker::Url::parse(v.as_str().unwrap_or_default())
                    .is_ok_and(|u| u.origin().ascii_serialization() == origin)
            })
        });
        ensure(
            origin.is_empty() || origin == self.origin || (c["client_type"] == "WEB" && allowed),
            403,
            "ORIGIN_NOT_ALLOWED",
        )
    }
    pub async fn begin(&self, b: &Value) -> Result<Value> {
        fields(
            b,
            &[
                "clientId",
                "redirectUri",
                "codeChallenge",
                "codeChallengeMethod",
                "state",
                "scopes",
            ],
            &["forceLogin"],
        )?;
        self.rate_ip("begin-ip", 60).await?;
        let c = self.client(string(&b["clientId"], 100)?).await?;
        self.check_origin(&c)?;
        let redirect = string(&b["redirectUri"], 1024)?;
        let state = string(&b["state"], 128)?;
        let pkce = string(&b["codeChallenge"], 43)?;
        ensure(
            contains(&parsed(&c, "redirects")?, &json!(redirect))
                && token(pkce)
                && b["codeChallengeMethod"] == "S256"
                && state.len() >= 22
                && state
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            400,
            "INVALID_REQUEST",
        )?;
        let allowed = parsed(&c, "scopes")?;
        ensure(
            b["scopes"].as_array().is_some_and(|s| {
                (1..=2).contains(&s.len())
                    && s.iter()
                        .all(|x| (x == "account" || x == "profile") && contains(&allowed, x))
            }),
            400,
            "INVALID_REQUEST",
        )?;
        ensure(
            b.get("forceLogin").is_none_or(Value::is_boolean),
            400,
            "INVALID_REQUEST",
        )?;
        let ctx = json!({"id":uuid(),"clientId":c["client_id"],"clientType":c["client_type"],"redirectUri":redirect,"challenge":pkce,"state":state,"scopes":b["scopes"],"forceLogin":b["forceLogin"]==true || c["client_type"]!="WEB"});
        let value = secret();
        self.s
            .run(
                "INSERT INTO auth_transaction(token_hash,context,expires_at) VALUES (?,?,?)",
                vec![
                    hash(&value).into(),
                    ctx.to_string().into(),
                    (now() + 600000).into(),
                ],
            )
            .await?;
        Ok(
            json!({"transaction":value,"loginUrl":format!("{}/login#transaction={value}",self.origin)}),
        )
    }
    pub async fn transaction(&self) -> Result<(Value, Value, String)> {
        let value = self.header("X-Auth-Transaction");
        ensure(token(&value), 400, "INVALID_TRANSACTION")?;
        let t = self
            .s
            .one(
                "SELECT * FROM auth_transaction WHERE token_hash=? AND expires_at>?",
                vec![hash(&value).into(), now().into()],
            )
            .await?;
        ensure(!t.is_null(), 400, "INVALID_TRANSACTION")?;
        let ctx = parsed(&t, "context")?;
        let c = self.client(&text(&ctx, "clientId")).await?;
        self.check_origin(&c)?;
        let scopes = parsed(&c, "scopes")?;
        ensure(
            contains(&parsed(&c, "redirects")?, &ctx["redirectUri"])
                && ctx["scopes"]
                    .as_array()
                    .is_some_and(|a| a.iter().all(|v| contains(&scopes, v))),
            400,
            "INVALID_CLIENT",
        )?;
        Ok((t, ctx, value))
    }
    pub async fn root(&self, id: &str) -> Result<Value> {
        let n = now();
        let a=self.s.one(&format!("SELECT a.* FROM auth_authentication a JOIN auth_user u ON u.id=a.user_id WHERE a.id=? AND {ALIVE}"),vec![id.into(),n.into(),n.into()]).await?;
        ensure(!a.is_null(), 401, "LOGIN_REQUIRED")?;
        Ok(a)
    }
    pub async fn login(&self, b: &Value, signup: bool) -> Result<Value> {
        fields(
            b,
            if signup {
                &["email", "password", "confirmPassword"]
            } else {
                &["email", "password"]
            },
            &[],
        )?;
        if signup {
            self.auth_origin()?;
        }
        let (t, _, value) = self.transaction().await?;
        ensure(t["status"] == "READY", 400, "INVALID_TRANSACTION")?;
        self.rate_ip("login-ip", 30).await?;
        let address = match email(&b["email"]) {
            Ok(v) => v,
            Err(e) => {
                if signup {
                    return Err(e);
                }
                "invalid-email".into()
            }
        };
        self.rate("login-email", &address, 10, 300000).await?;
        let raw = string(&b["password"], 512)?;
        let n = now();
        let root = uuid();
        let mut writes=vec![self.s.guard("EXISTS(SELECT 1 FROM auth_transaction WHERE token_hash=? AND status='READY' AND expires_at>?)",vec![t["token_hash"].clone(),n.into()])?];
        let user;
        if signup {
            ensure(
                raw == string(&b["confirmPassword"], 512)?,
                400,
                "PASSWORD_MISMATCH",
            )?;
            let encoded = encode(raw).await?;
            user = uuid();
            let space = uuid();
            writes.extend([
                self.s.statement("INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES (?,?,'ACTIVE',?,?)",vec![user.clone().into(),address.split('@').next().unwrap().into(),n.into(),n.into()])?,
                self.s.statement("INSERT INTO auth_user_email(id,user_id,canonical_email,created_at) VALUES (?,?,?,?)",vec![uuid().into(),user.clone().into(),address.into(),n.into()])?,
                self.s.statement("INSERT INTO auth_local_credential VALUES (?,?,?)",vec![user.clone().into(),encoded.into(),n.into()])?,
                self.s.statement("INSERT INTO auth_space(id,name,space_type,status,personal_user_id,created_at,updated_at) VALUES (?,'个人空间','PERSONAL','ACTIVE',?,?,?)",vec![space.clone().into(),user.clone().into(),n.into(),n.into()])?,
                self.s.statement("INSERT INTO auth_membership VALUES (?,?,'OWNER',?)",vec![space.into(),user.clone().into(),n.into()])?
            ]);
        } else {
            let candidate=self.s.one("SELECT u.id,u.status,c.password_hash FROM auth_user_email e JOIN auth_user u ON u.id=e.user_id LEFT JOIN auth_local_credential c ON c.user_id=u.id WHERE e.canonical_email=?",vec![address.into()]).await?;
            let encoded = candidate["password_hash"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or(format!("{VERSION}{}", "00".repeat(48)));
            let matched = matches(raw, &encoded).await?;
            if !matched || candidate["status"] != "ACTIVE" {
                self.s
                    .db
                    .batch(vec![self.s.audit(
                        "account.login",
                        Value::Null,
                        &self.request_id,
                        Value::Null,
                        Value::Null,
                        Value::Null,
                        true,
                    )?])
                    .await?;
                return Err(Failure {
                    status: 401,
                    code: "INVALID_CREDENTIALS",
                });
            }
            user = text(&candidate, "id");
            writes.push(self.s.guard("EXISTS(SELECT 1 FROM auth_user u JOIN auth_local_credential c ON c.user_id=u.id WHERE u.id=? AND u.status='ACTIVE' AND c.password_hash=?)",vec![user.clone().into(),encoded.into()])?);
        }
        writes.extend([
            self.s.statement("INSERT INTO auth_authentication(id,user_id,created_at,activity_at) VALUES (?,?,?,?)",vec![root.clone().into(),user.clone().into(),n.into(),n.into()])?,
            self.s.statement("UPDATE auth_transaction SET status='AUTHENTICATED',authentication_id=? WHERE token_hash=?",vec![root.into(),t["token_hash"].clone()])?,
            self.s.audit(if signup {"account.register"} else {"account.login"},user.into(),&self.request_id,Value::Null,Value::Null,Value::Null,false)?
        ]);
        self.s.batch(writes, "INVALID_TRANSACTION").await?;
        Ok(json!({"continueUrl":format!("{}/complete#transaction={value}",self.origin)}))
    }
    pub async fn restore(&self) -> Result<Value> {
        self.auth_origin()?;
        let (t, ctx, value) = self.transaction().await?;
        ensure(
            ctx["clientType"] == "WEB" && ctx["forceLogin"] == false,
            401,
            "FULL_LOGIN_REQUIRED",
        )?;
        let ck = cookie(&self.header("Cookie"), root_cookie(&self.origin));
        ensure(token(&ck), 401, "LOGIN_REQUIRED")?;
        let a = self
            .s
            .one(
                "SELECT id FROM auth_authentication WHERE cookie_hash=?",
                vec![hash(&ck).into()],
            )
            .await?;
        ensure(!a.is_null(), 401, "LOGIN_REQUIRED")?;
        self.root(&text(&a, "id")).await?;
        let changed=self.s.one("UPDATE auth_transaction SET status='AUTHENTICATED',authentication_id=? WHERE token_hash=? AND status='READY' AND expires_at>? RETURNING token_hash",vec![a["id"].clone(),t["token_hash"].clone(),now().into()]).await?;
        ensure(!changed.is_null(), 400, "INVALID_TRANSACTION")?;
        Ok(json!({"continueUrl":format!("{}/complete#transaction={value}",self.origin)}))
    }
    fn completion_cookie(&self, t: &Value) -> String {
        format!(
            "{}auth_complete_{}",
            if self.origin.starts_with("https:") {
                "__Host-"
            } else {
                ""
            },
            &text(t, "token_hash")[..24]
        )
    }
    pub async fn confirmation(&mut self) -> Result<Value> {
        self.auth_origin()?;
        let (t, _, _) = self.transaction().await?;
        ensure(
            t["status"] == "AUTHENTICATED" && t["authentication_id"].is_string(),
            400,
            "INVALID_TRANSACTION",
        )?;
        self.rate_ip("confirmation-ip", 60).await?;
        let a = self.root(&text(&t, "authentication_id")).await?;
        let proof = secret();
        let browser = secret();
        let changed=self.s.one("UPDATE auth_transaction SET proof_hash=?,browser_hash=? WHERE token_hash=? AND status='AUTHENTICATED' AND expires_at>? RETURNING token_hash",vec![hash(&proof).into(),hash(&browser).into(),t["token_hash"].clone(),now().into()]).await?;
        ensure(!changed.is_null(), 400, "INVALID_TRANSACTION")?;
        self.cookies.push(
            cookie_header(&self.origin, &self.completion_cookie(&t), &browser, 600)
                .replace("SameSite=Lax", "SameSite=Strict"),
        );
        let emails = self
            .s
            .all(
                "SELECT canonical_email FROM auth_user_email WHERE user_id=?",
                vec![a["user_id"].clone()],
            )
            .await?;
        Ok(
            json!({"confirmation":proof,"account":{"userId":a["user_id"],"emails":emails.iter().map(|x| x["canonical_email"].clone()).collect::<Vec<_>>()}}),
        )
    }
    pub async fn complete(&mut self, b: &Value, cancel: bool) -> Result<Value> {
        self.auth_origin()?;
        fields(
            b,
            &["confirmation"],
            if cancel { &[] } else { &["confirmed"] },
        )?;
        if !cancel {
            ensure(b["confirmed"] == true, 400, "LOGIN_CONFIRMATION_REQUIRED")?;
        }
        let (t, ctx, _) = self.transaction().await?;
        let proof = string(&b["confirmation"], 43)?;
        let key = self.completion_cookie(&t);
        let browser = cookie(&self.header("Cookie"), &key);
        ensure(
            t["status"] == "AUTHENTICATED"
                && token(proof)
                && token(&browser)
                && t["proof_hash"] == hash(proof)
                && t["browser_hash"] == hash(&browser),
            400,
            "INVALID_TRANSACTION",
        )?;
        let a = self.root(&text(&t, "authentication_id")).await?;
        let n = now();
        let code = secret();
        let mut writes=vec![
            self.s.guard("EXISTS(SELECT 1 FROM auth_transaction WHERE token_hash=? AND status='AUTHENTICATED' AND proof_hash=? AND browser_hash=? AND expires_at>?)",vec![t["token_hash"].clone(),t["proof_hash"].clone(),t["browser_hash"].clone(),n.into()])?,
            self.s.guard(&format!("EXISTS(SELECT 1 FROM auth_authentication a JOIN auth_user u ON u.id=a.user_id WHERE a.id=? AND {ALIVE})"),vec![a["id"].clone(),n.into(),n.into()])?,
            self.s.statement("UPDATE auth_transaction SET status='CONSUMED',proof_hash=NULL,browser_hash=NULL WHERE token_hash=?",vec![t["token_hash"].clone()])?
        ];
        if !cancel {
            writes.push(self.s.statement(
                "INSERT INTO auth_code VALUES (?,?,?,?,?,?,?,NULL)",
                vec![
                    hash(&code).into(),
                    ctx["clientId"].clone(),
                    ctx["redirectUri"].clone(),
                    ctx["challenge"].clone(),
                    ctx["scopes"].to_string().into(),
                    a["id"].clone(),
                    (n + 60000).into(),
                ],
            )?);
            if ctx["clientType"] == "WEB" {
                let restore = secret();
                writes.push(self.s.statement(
                    "UPDATE auth_authentication SET cookie_hash=? WHERE id=?",
                    vec![hash(&restore).into(), a["id"].clone()],
                )?);
                self.cookies.push(cookie_header(
                    &self.origin,
                    root_cookie(&self.origin),
                    &restore,
                    ((number(&a, "created_at") + 7776000000)
                        .min(number(&a, "activity_at") + 2592000000)
                        - n)
                        / 1000,
                ));
            }
        }
        self.s.batch(writes, "INVALID_TRANSACTION").await?;
        self.cookies.push(cookie_header(&self.origin, &key, "", 0));
        if cancel {
            Ok(json!({"cancelled":true}))
        } else {
            let redirect = text(&ctx, "redirectUri");
            Ok(
                json!({"redirectTo":format!("{redirect}{}code={code}&state={}",if redirect.contains('?'){"&"}else{"?"},text(&ctx,"state"))}),
            )
        }
    }
    pub async fn principal(&mut self, provided: Option<&str>) -> Result<Value> {
        let header = self.header("Authorization");
        let bearer = provided.unwrap_or_else(|| {
            if header
                .get(..7)
                .is_some_and(|s| s.eq_ignore_ascii_case("Bearer "))
            {
                &header[7..]
            } else {
                &header
            }
        });
        ensure(token(bearer), 401, "INVALID_TOKEN")?;
        let digest = hash(bearer);
        let n = now();
        let mut row=self.s.one(&format!("SELECT u.id userId,u.display_name displayName,u.avatar_data avatarUrl,c.application_id applicationId,c.client_id clientId,g.id sessionId,a.id authenticationId,g.scopes FROM auth_access_token t JOIN auth_grant g ON g.id=t.grant_id JOIN auth_authentication a ON a.id=g.authentication_id JOIN auth_user u ON u.id=a.user_id JOIN auth_client c ON c.client_id=g.client_id JOIN auth_application app ON app.id=c.application_id WHERE t.token_hash=? AND t.expires_at>? AND g.revoked_at IS NULL AND c.status='ACTIVE' AND app.status='ACTIVE' AND {ALIVE}"),vec![digest.clone().into(),n.into(),n.into(),n.into()]).await?;
        ensure(!row.is_null(), 401, "INVALID_TOKEN")?;
        let c = self.client(&text(&row, "clientId")).await?;
        self.check_origin(&c)?;
        let scopes = parsed(&row, "scopes")?;
        let allowed = parsed(&c, "scopes")?;
        ensure(
            scopes
                .as_array()
                .is_some_and(|a| a.iter().all(|s| contains(&allowed, s))),
            401,
            "INVALID_TOKEN",
        )?;
        self.s.authorization = Some((
            format!(
                "EXISTS(SELECT 1 FROM auth_access_token t JOIN auth_grant g ON g.id=t.grant_id JOIN auth_authentication a ON a.id=g.authentication_id JOIN auth_user u ON u.id=a.user_id JOIN auth_client c ON c.client_id=g.client_id JOIN auth_application app ON app.id=c.application_id WHERE t.token_hash=? AND t.expires_at>? AND g.revoked_at IS NULL AND c.status='ACTIVE' AND app.status='ACTIVE' AND c.version=? AND {ALIVE})"
            ),
            vec![
                digest.into(),
                n.into(),
                c["version"].clone(),
                n.into(),
                n.into(),
            ],
        ));
        row["scopes"] = scopes;
        row["platformAdmin"] = json!(
            self.admins
                .split(',')
                .any(|s| s.trim() == text(&row, "userId"))
        );
        Ok(row)
    }
    pub async fn me(&self, p: &Value) -> Result<Value> {
        let emails = self
            .s
            .all(
                "SELECT canonical_email FROM auth_user_email WHERE user_id=?",
                vec![p["userId"].clone()],
            )
            .await?;
        Ok(
            json!({"userId":p["userId"],"displayName":p["displayName"],"avatarUrl":p["avatarUrl"],"applicationId":p["applicationId"],"clientId":p["clientId"],"sessionId":p["sessionId"],"scopes":p["scopes"],"emails":emails.iter().map(|x| x["canonical_email"].clone()).collect::<Vec<_>>()}),
        )
    }
    pub async fn logout(&mut self, p: &Value, all: bool) -> Result<Value> {
        self.s
            .batch(
                vec![
                    self.s.statement(
                        if all {
                            "UPDATE auth_authentication SET revoked_at=? WHERE user_id=?"
                        } else {
                            "UPDATE auth_authentication SET revoked_at=? WHERE id=?"
                        },
                        vec![
                            now().into(),
                            p[if all { "userId" } else { "authenticationId" }].clone(),
                        ],
                    )?,
                    self.s.audit(
                        if all {
                            "account.logout.all"
                        } else {
                            "account.logout"
                        },
                        p["userId"].clone(),
                        &self.request_id,
                        Value::Null,
                        Value::Null,
                        Value::Null,
                        false,
                    )?,
                ],
                "VERSION_CONFLICT",
            )
            .await?;
        self.cookies.push(cookie_header(
            &self.origin,
            root_cookie(&self.origin),
            "",
            0,
        ));
        Ok(json!({"loggedOut":true}))
    }
}
