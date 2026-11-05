//! Cloudflare Workers backend. Business logic lives in Rust; bindings remain at the edge.
mod account;
mod account_management;
mod app;
mod authorization;
mod billing;
mod billing_catalog;
mod billing_seats;
mod billing_subscriptions;
mod delivery;
mod entitlements;
mod external_login;
mod federation;
mod http;
mod identity;
mod login_sessions;
mod password_kdf;
mod platform;
mod registration;
mod security;
mod sensitive_transactions;
mod store;
mod teams;
mod tenant_invitations;
mod tenant_membership;
mod tenant_protocol;
mod tenant_transfers;
mod tenants;
mod tokens;
mod unified_contracts;
mod unified_policy;

use worker::*;

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    app::handle(req, env).await
}

#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let result=async {
        let db=env.d1("DB")?;let now=js_sys::Date::now();
        let mut statements=vec![];
        for (table,column) in [("auth_one_use","token_hash"),("auth_rate_bucket","bucket_hash"),("auth_transaction","token_hash"),("auth_access_token","token_hash"),("auth_service_token","token_hash"),("auth_code","token_hash"),("auth_refresh_token","token_hash"),("auth_login_access_token","token_hash"),("auth_login_refresh_token","token_hash"),("auth_identity_proof","token_hash"),("auth_logout_receipt","request_key_hash"),("auth_mock_delivery","delivery_id"),("auth_management_result","rowid"),("auth_mock_notification","delivery_id")] {
            let receipt_protected = table == "auth_login_access_token" || table == "auth_login_refresh_token";
            let retain = if receipt_protected { format!(" AND NOT EXISTS(SELECT 1 FROM auth_logout_receipt r WHERE r.proof_hash={table}.{column} AND r.expires_at>?)") } else { String::new() };
            let mut values=vec![wasm_bindgen::JsValue::from_f64(now)];
            if receipt_protected { values.push(wasm_bindgen::JsValue::from_f64(now)); }
            statements.push(db.prepare(format!("DELETE FROM {table} WHERE {column} IN (SELECT {column} FROM {table} WHERE expires_at<=?{retain} LIMIT 100)")).bind(&values)?);
        }
        db.batch(statements).await?;Ok::<(),worker::Error>(())
    }.await;
    if result.is_err() {
        worker::console_error!("AUTH_CLEANUP_FAILED");
    }
}
