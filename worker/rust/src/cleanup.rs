use serde_json::json;
use wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement, Env, Result};

const ROWS_PER_TABLE: usize = 150;
const MAX_ROUNDS: usize = 3;
const BUDGET_MS: f64 = 2_000.0;
const TRANSACTION_GRACE_MS: f64 = 86_400_000.0;

// Delete child rows before checking whether their expired parent can be removed.
const TABLES: [(&str, &str); 13] = [
    ("auth_one_use", "token_hash"),
    ("auth_rate_bucket", "bucket_hash"),
    ("auth_login_access_token", "token_hash"),
    ("auth_login_refresh_token", "token_hash"),
    ("auth_verification_challenge", "id"),
    ("auth_identity_proof", "token_hash"),
    ("auth_product_transaction", "id"),
    ("auth_logout_receipt", "request_key_hash"),
    ("auth_mock_delivery", "delivery_id"),
    ("auth_management_result", "rowid"),
    ("auth_mock_notification", "delivery_id"),
    ("auth_web_session", "id_hash"),
    ("auth_management_handoff", "id"),
];

fn round(db: &D1Database, cutoff: f64) -> Result<Vec<D1PreparedStatement>> {
    TABLES
        .iter()
        .map(|&(table, key)| {
            let (expiry, retain) = match table {
                "auth_login_access_token" | "auth_login_refresh_token" => (
                    cutoff,
                    " AND NOT EXISTS(SELECT 1 FROM auth_logout_receipt r WHERE r.proof_hash=t.token_hash AND r.expires_at>?1)",
                ),
                "auth_product_transaction" => (
                    cutoff - TRANSACTION_GRACE_MS,
                    " AND NOT EXISTS(SELECT 1 FROM auth_verification_challenge v WHERE v.transaction_id=t.id)                       AND NOT EXISTS(SELECT 1 FROM auth_identity_proof p WHERE p.transaction_id=t.id)",
                ),
                _ => (cutoff, ""),
            };
            db.prepare(format!(
                "DELETE FROM {table} WHERE {key} IN (SELECT t.{key} FROM {table} t                  WHERE t.expires_at<=?1{retain} ORDER BY t.expires_at,t.rowid LIMIT {ROWS_PER_TABLE})"
            ))
            .bind(&[JsValue::from_f64(expiry)])
        })
        .collect()
}

pub(crate) async fn run(env: &Env) {
    let cutoff = js_sys::Date::now();
    let mut totals = [Some(0); TABLES.len()];
    let mut rounds = 0;
    let reason = async {
        let db = env.d1("DB")?;
        let reason = loop {
            let results = db.batch(round(&db, cutoff)?).await?;
            rounds += 1;
            let mut full = false;
            let mut missing_counts = false;
            for (index, total) in totals.iter_mut().enumerate() {
                let changes = results
                    .get(index)
                    .filter(|result| result.success())
                    .and_then(|result| result.meta().ok().flatten())
                    .and_then(|meta| meta.changes);
                match changes {
                    Some(changes) => {
                        *total = total.map(|count| count + changes);
                        full |= changes >= ROWS_PER_TABLE;
                    }
                    None => {
                        *total = None;
                        missing_counts = true;
                    }
                }
            }
            if missing_counts {
                break "missing_counts";
            }
            if !full {
                break "drained";
            }
            if rounds == MAX_ROUNDS {
                break "round_limit";
            }
            if js_sys::Date::now() - cutoff >= BUDGET_MS {
                break "time_budget";
            }
        };
        Ok::<_, worker::Error>(reason)
    }
    .await
    .unwrap_or("database_error");
    let deleted: serde_json::Map<_, _> = TABLES
        .iter()
        .zip(totals)
        .map(|(&(table, _), count)| (table.to_owned(), json!(count)))
        .collect();
    let summary = json!({
        "event": "AUTH_CLEANUP",
        "rounds": rounds,
        "deleted": deleted,
        "elapsedMs": (js_sys::Date::now() - cutoff) as u64,
        "stopReason": reason,
    });
    if matches!(reason, "database_error" | "missing_counts") {
        worker::console_error!("{summary}");
    } else {
        worker::console_log!("{summary}");
    }
}
