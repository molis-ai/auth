use crate::{http::*, security::*, store::Store};
use worker::{Env, Request};

pub struct Auth {
    pub s: Store,
    pub origin: String,
    pub request: Request,
    pub request_id: String,
    pub cookies: Vec<String>,
    pub env: Env,
}
impl Auth {
    pub fn new(request: Request, env: &Env, request_id: String) -> Result<Self> {
        let origin = env.var("AUTH_ORIGIN")?.to_string();
        crate::unified_policy::validate_environment(env, &origin)?;
        Ok(Self {
            s: Store::new(env.d1("DB")?),
            origin,
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
}
