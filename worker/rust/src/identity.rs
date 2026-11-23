use crate::{http::*, security::*, store::Store};
use std::cell::Cell;
use worker::{Env, Request};

pub(crate) const DEFAULT_RETRY_AFTER: u64 = 60;

pub struct Auth {
    pub s: Store,
    pub origin: String,
    pub request: Request,
    pub request_id: String,
    pub client_ip: String,
    pub retry_after: Cell<Option<u64>>,
    pub cookies: Vec<String>,
    pub env: Env,
}
impl Auth {
    pub fn new(
        request: Request,
        env: &Env,
        request_id: String,
        client_ip: Option<String>,
    ) -> Result<Self> {
        let origin = env.var("AUTH_ORIGIN")?.to_string();
        crate::unified_policy::validate_environment(env, &origin)?;
        // In-process calls provide the IP captured from the edge request.
        let client_ip = client_ip.unwrap_or_else(|| {
            request
                .headers()
                .get("CF-Connecting-IP")
                .ok()
                .flatten()
                .filter(|ip| !ip.is_empty())
                .unwrap_or_else(|| "local".to_owned())
        });
        Ok(Self {
            s: Store::new(env.d1("DB")?),
            origin,
            request,
            request_id,
            client_ip,
            retry_after: Cell::new(None),
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
        let r = self.s.one(
            "INSERT INTO auth_rate_bucket(bucket_hash,hits,expires_at) VALUES (?,1,?)
             ON CONFLICT(bucket_hash) DO UPDATE SET
               hits=CASE WHEN auth_rate_bucket.expires_at<=? THEN 1 ELSE auth_rate_bucket.hits+1 END,
               expires_at=CASE WHEN auth_rate_bucket.expires_at<=? THEN excluded.expires_at ELSE auth_rate_bucket.expires_at END
             RETURNING hits, expires_at",
            vec![hash(&format!("{kind}:{subject}")).into(), (n + window).into(), n.into(), n.into()],
        ).await?;
        if !r.is_null() && number(&r, "hits") <= limit {
            return Ok(());
        }
        if let Some(expires_at) = r["expires_at"].as_i64() {
            let seconds = ((expires_at - n).max(0) + 999) / 1000;
            self.retry_after.set(Some(seconds.clamp(1, 86_400) as u64));
        }
        Err(Failure {
            status: 429,
            code: "RATE_LIMITED",
        })
    }
    pub async fn rate_ip(&self, kind: &str, limit: i64) -> Result<()> {
        self.rate_ip_window(kind, limit, 60_000).await
    }
    pub async fn rate_ip_window(&self, kind: &str, limit: i64, window: i64) -> Result<()> {
        self.rate(kind, &self.client_ip, limit, window).await
    }
}
