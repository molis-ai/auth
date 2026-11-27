//! Cloudflare Workers backend. Business logic lives in Rust; bindings remain at the edge.
#![deny(clippy::self_named_module_files)]
#![cfg_attr(not(test), deny(clippy::unwrap_used))]

mod account;
mod app;
mod audit;
mod auth;
mod core;
mod delivery;
mod internal;
mod platform;
mod tenants;
mod web;

use worker::*;

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    app::handle(req, env).await
}

#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    core::cleanup::run(&env).await;
}
