//! Cloudflare Workers backend. Business logic lives in Rust; bindings remain at the edge.
mod account;
mod app;
mod authorization;
mod federation;
mod http;
mod identity;
mod password_kdf;
mod platform;
mod security;
mod store;
mod teams;
mod tokens;

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
        for (table,column) in [("auth_one_use","token_hash"),("auth_rate_bucket","bucket_hash"),("auth_transaction","token_hash"),("auth_access_token","token_hash"),("auth_service_token","token_hash"),("auth_code","token_hash"),("auth_refresh_token","token_hash")] {
            statements.push(db.prepare(format!("DELETE FROM {table} WHERE {column} IN (SELECT {column} FROM {table} WHERE expires_at<=? LIMIT 100)")).bind(&[wasm_bindgen::JsValue::from_f64(now)])?);
        }
        db.batch(statements).await?;Ok::<(),worker::Error>(())
    }.await;
    if result.is_err() {
        worker::console_error!("AUTH_CLEANUP_FAILED");
    }
}
