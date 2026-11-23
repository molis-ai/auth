//! Cloudflare Workers backend. Business logic lives in Rust; bindings remain at the edge.
mod account_management;
mod app;
mod billing;
mod billing_catalog;
mod billing_seats;
mod billing_subscriptions;
mod cleanup;
#[cfg(test)]
mod contract_structure;
mod delivery;
mod entitlements;
mod external_login;
mod external_profile;
mod github_login;
mod google_login;
mod http;
mod identity;
mod login_capabilities;
mod login_commands;
mod login_sessions;
mod mail_delivery;
mod mail_templates;
mod management_handoff;
mod password_kdf;
mod platform_accounts;
mod platform_management;
mod registration;
mod security;
mod sensitive_transactions;
mod sms_auth;
mod store;
mod tenant_creation;
mod tenant_invitations;
mod tenant_membership;
mod tenant_protocol;
mod tenant_transfers;
mod tenants;
mod test_admission;
mod unified_contracts;
mod unified_policy;
mod web_auth;
mod web_session;

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
