use crate::{
    core::http::*,
    core::security::*,
    core::store::{CommitFence, Store},
};
use serde_json::Value;
use std::cell::Cell;
use std::sync::Arc;
use worker::{Env, Request};

pub(crate) const DEFAULT_RETRY_AFTER: u64 = 60;

pub(crate) fn retry_after_seconds(expires_at: i64, current_ms: i64) -> u64 {
    let remaining_ms = expires_at.saturating_sub(current_ms).max(0) as u64;
    remaining_ms.div_ceil(1_000).clamp(1, 86_400)
}

#[derive(Default)]
pub(crate) struct OperationInput {
    pub query: String,
    pub authorization: String,
    pub origin: String,
    pub initiator_proof: String,
    pub idempotency_key: String,
}

impl OperationInput {
    fn header(&self, key: &str) -> &str {
        match key {
            "Authorization" => &self.authorization,
            "Origin" => &self.origin,
            "X-Auth-Initiator-Proof" => &self.initiator_proof,
            "Idempotency-Key" => &self.idempotency_key,
            _ => "",
        }
    }
}

pub struct Auth {
    pub s: Store,
    pub origin: String,
    pub(crate) unified_config: Option<Arc<Value>>,
    request: Option<Request>,
    operation: Option<OperationInput>,
    pub request_id: String,
    pub client_ip: String,
    pub retry_after_at: Cell<Option<i64>>,
    pub cookies: Vec<String>,
    pub env: Env,
}
impl Auth {
    pub fn new(
        request: Request,
        env: &Env,
        log: &RequestLog<'_>,
        client_ip: Option<String>,
    ) -> Result<Self> {
        let origin = env.var("AUTH_ORIGIN")?.to_string();
        let unified_config =
            crate::core::contracts::unified_policy::environment_configuration(env, &origin)?;
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
            s: Store::new(env.d1("DB")?, log),
            origin,
            unified_config,
            request: Some(request),
            operation: None,
            request_id: log.id.to_owned(),
            client_ip,
            retry_after_at: Cell::new(None),
            cookies: vec![],
            env: env.clone(),
        })
    }
    pub(crate) fn for_operation(
        &self,
        input: OperationInput,
        route: &'static str,
        fence: Option<CommitFence>,
    ) -> Self {
        Self {
            s: self.s.for_operation(route, fence),
            origin: self.origin.clone(),
            unified_config: self.unified_config.clone(),
            request: None,
            operation: Some(input),
            request_id: self.request_id.clone(),
            client_ip: self.client_ip.clone(),
            retry_after_at: Cell::new(None),
            cookies: vec![],
            env: self.env.clone(),
        }
    }
    pub(crate) fn http(&self) -> Result<&Request> {
        self.request.as_ref().ok_or_else(Failure::unavailable)
    }
    pub(crate) fn http_mut(&mut self) -> Result<&mut Request> {
        self.request.as_mut().ok_or_else(Failure::unavailable)
    }
    pub(crate) fn query(&self) -> Result<String> {
        if let Some(input) = &self.operation {
            return Ok(input.query.clone());
        }
        Ok(self.http()?.url()?.query().unwrap_or_default().to_owned())
    }
    pub fn header(&self, key: &str) -> String {
        if let Some(input) = &self.operation {
            return input.header(key).to_owned();
        }
        self.request
            .as_ref()
            .and_then(|request| request.headers().get(key).ok().flatten())
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
        Err(self.rate_limited(&r))
    }
    fn rate_limited(&self, row: &serde_json::Value) -> Failure {
        self.retry_after_at.set(row["expires_at"].as_i64());
        Failure {
            status: 429,
            code: "RATE_LIMITED",
        }
    }
    pub(crate) async fn rate_batch(&self, rules: &[(&str, &str, i64, i64)]) -> Result<i64> {
        let n = now();
        let mut bindings = vec![n.into()];
        let mut limits = Vec::new();
        let mut slots = Vec::new();
        for (position, (kind, subject, limit, window)) in rules.iter().enumerate() {
            let key = hash(&format!("{kind}:{subject}"));
            let parameter = bindings.len() + 1;
            slots.push(format!(
                "(?{parameter}, ?{}, ?{}, {position})",
                parameter + 1,
                parameter + 2
            ));
            bindings.extend([key.clone().into(), (*limit).into(), (n + window).into()]);
            limits.push((key, *limit));
        }
        // Read the counters before the UPSERT. Charge every preceding bucket
        // and the first rejected bucket, just as the sequential checks do.
        let rows = self.s.all(
            &format!("WITH rules(bucket_hash,max_hits,new_expiry,position) AS (VALUES {}),
                next_hits AS MATERIALIZED (
                    SELECT r.*,
                        CASE WHEN b.expires_at>?1 THEN b.hits+1 ELSE 1 END AS hits,
                        CASE WHEN b.expires_at>?1 THEN b.expires_at ELSE r.new_expiry END AS expires_at
                    FROM rules r LEFT JOIN auth_rate_bucket b ON b.bucket_hash=r.bucket_hash
                ), first_denial AS (SELECT MIN(position) position FROM next_hits WHERE hits>max_hits)
                INSERT INTO auth_rate_bucket(bucket_hash,hits,expires_at)
                SELECT h.bucket_hash,h.hits,h.expires_at
                FROM next_hits h CROSS JOIN first_denial d
                WHERE d.position IS NULL OR h.position<=d.position
                ON CONFLICT(bucket_hash) DO UPDATE SET hits=excluded.hits,expires_at=excluded.expires_at
                RETURNING bucket_hash,hits,expires_at",
                slots.join(",")
            ),
            bindings,
        ).await?;
        for row in &rows {
            let (_, limit) = limits
                .iter()
                .find(|(key, _)| row["bucket_hash"].as_str() == Some(key))
                .ok_or_else(Failure::unavailable)?;
            if number(row, "hits") > *limit {
                return Err(self.rate_limited(row));
            }
        }
        ensure(rows.len() == rules.len(), 503, "AUTH_UNAVAILABLE")?;
        Ok(n)
    }
    pub async fn rate_ip(&self, kind: &str, limit: i64) -> Result<()> {
        self.rate(kind, &self.client_ip, limit, 60_000).await
    }
}

#[cfg(test)]
mod tests {
    use super::retry_after_seconds;

    #[test]
    fn retry_after_uses_remaining_time_and_stays_within_contract() {
        assert_eq!(retry_after_seconds(5_000, 0), 5);
        assert_eq!(retry_after_seconds(5_000, 3_000), 2);
        assert_eq!(retry_after_seconds(5_000, 3_999), 2);
        assert_eq!(retry_after_seconds(5_000, 5_000), 1);
        assert_eq!(retry_after_seconds(5_000, 5_001), 1);
        assert_eq!(retry_after_seconds(86_400_001, 0), 86_400);
    }
}
