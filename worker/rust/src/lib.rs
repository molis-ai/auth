//! Cloudflare Workers backend. Business logic lives in Rust; bindings remain at the edge.
#![cfg_attr(not(test), deny(clippy::unwrap_used))]

mod account_management;
mod app;
mod auth;
mod billing;
mod cleanup;
#[cfg(test)]
mod contract_structure;
mod delivery;
mod http;
mod identity;
mod password_kdf;
mod platform;
mod security;
mod sensitive_transactions;
mod store;
mod tenants;
mod test_admission;
mod unified_contracts;
mod unified_policy;
mod web;

use worker::*;

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    app::handle(req, env).await
}

#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    cleanup::run(&env).await;
}
mod sync_read_proof;
