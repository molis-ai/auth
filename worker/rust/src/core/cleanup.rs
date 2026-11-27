use crate::{
    core::http::{log_env, log_event},
    core::security::uuid,
};
use serde_json::json;
use wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement, Env, Result};

const ROWS_PER_TABLE: usize = 200;
const MAX_ROUNDS: usize = 3;
const BUDGET_MS: f64 = 8_000.0;
const RETENTION_GRACE_MS: f64 = 86_400_000.0;

// Dependent rows are cleaned first. A parent is still protected if a child
// remains because of retention, the row limit, or an independent failure.
const TABLES: [(&str, &str); 17] = [
    ("auth_one_use", "token_hash"),
    ("auth_rate_bucket", "bucket_hash"),
    ("auth_login_access_token", "token_hash"),
    ("auth_login_refresh_token", "token_hash"),
    ("auth_verification_challenge", "id"),
    ("auth_identity_proof", "token_hash"),
    ("auth_logout_receipt", "request_key_hash"),
    ("auth_mock_delivery", "delivery_id"),
    ("auth_management_result", "rowid"),
    ("auth_mock_notification", "delivery_id"),
    ("auth_web_session", "id_hash"),
    ("auth_management_handoff", "id"),
    ("auth_login_activity", "rowid"),
    ("auth_tenant_invitation", "id"),
    ("auth_ownership_transfer", "id"),
    ("auth_product_transaction", "id"),
    ("auth_login_session", "id"),
];
const LAYERS: [(usize, usize); 3] = [(0, 15), (15, 16), (16, 17)];

fn statement(db: &D1Database, table: &str, key: &str, now: f64) -> Result<D1PreparedStatement> {
    let (source, expiry, cutoff, retain) = match table {
        "auth_login_access_token" | "auth_login_refresh_token" => (
            "",
            "t.expires_at",
            now,
            " AND NOT EXISTS(SELECT 1 FROM auth_logout_receipt r WHERE r.proof_hash=t.token_hash AND r.expires_at>?1)",
        ),
        "auth_product_transaction" => (
            "",
            "t.expires_at",
            now - RETENTION_GRACE_MS,
            " AND NOT EXISTS(SELECT 1 FROM auth_verification_challenge v WHERE v.transaction_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM auth_identity_proof p WHERE p.transaction_id=t.id)",
        ),
        "auth_login_activity" => (
            "JOIN auth_login_session s ON s.id=t.login_session_id",
            "s.absolute_expires_at",
            now,
            "",
        ),
        "auth_login_session" => (
            "",
            "t.absolute_expires_at",
            now,
            " AND NOT EXISTS(SELECT 1 FROM auth_login_access_token a WHERE a.login_session_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM auth_login_refresh_token r WHERE r.login_session_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM auth_logout_receipt r WHERE r.login_session_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM auth_identity_proof p WHERE p.login_session_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM auth_product_transaction p WHERE p.login_session_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM auth_management_handoff h WHERE h.source_session=t.id)
              AND NOT EXISTS(SELECT 1 FROM auth_login_activity a WHERE a.login_session_id=t.id)",
        ),
        "auth_tenant_invitation" | "auth_ownership_transfer" => (
            "",
            "t.expires_at",
            now - RETENTION_GRACE_MS,
            " AND t.status IN ('PENDING','EXPIRED')",
        ),
        _ => ("", "t.expires_at", now, ""),
    };
    db.prepare(format!(
        "DELETE FROM {table} WHERE {key} IN (SELECT t.{key} FROM {table} t {source}
         WHERE {expiry}<=?1{retain} ORDER BY {expiry},t.{key} LIMIT {ROWS_PER_TABLE})"
    ))
    .bind(&[JsValue::from_f64(cutoff)])
}

pub(crate) async fn run(env: &Env) {
    let cutoff = js_sys::Date::now();
    let environment = log_env(env);
    let request_id = uuid();
    let mut totals = [Some(0); TABLES.len()];
    let mut pending = [true; TABLES.len()];
    let mut rounds = 0;
    let mut failed = false;
    let reason = match env.d1("DB") {
        Err(error) => {
            log_event(
                "auth.cleanup.failure",
                environment,
                &request_id,
                [("error", json!(error.to_string()))],
                true,
            );
            "database_error"
        }
        Ok(db) => loop {
            rounds += 1;
            for (first, end) in LAYERS {
                let results = futures_util::future::join_all(
                    (first..end).filter(|&index| pending[index]).map(|index| {
                        let (table, key) = TABLES[index];
                        let db = &db;
                        async move {
                            let result =
                                async {
                                    let result = statement(db, table, key, cutoff)?.run().await?;
                                    result.meta()?.and_then(|meta| meta.changes).ok_or_else(|| {
                                        worker::Error::RustError(result.error().unwrap_or_else(
                                            || "D1 changes count unavailable".into(),
                                        ))
                                    })
                                }
                                .await;
                            (index, table, result)
                        }
                    }),
                )
                .await;
                for (index, table, result) in results {
                    match result {
                        Ok(changes) => {
                            totals[index] = totals[index].map(|count| count + changes);
                            // Parent rows may become eligible in a later round as children drain.
                            let has_pending = |table| {
                                TABLES
                                    .iter()
                                    .zip(pending)
                                    .any(|(&(name, _), open)| name == table && open)
                            };
                            pending[index] = changes >= ROWS_PER_TABLE
                                || match table {
                                    "auth_product_transaction" => {
                                        ["auth_verification_challenge", "auth_identity_proof"]
                                            .into_iter()
                                            .any(has_pending)
                                    }
                                    "auth_login_session" => [
                                        "auth_login_access_token",
                                        "auth_login_refresh_token",
                                        "auth_identity_proof",
                                        "auth_product_transaction",
                                        "auth_logout_receipt",
                                        "auth_management_handoff",
                                        "auth_login_activity",
                                    ]
                                    .into_iter()
                                    .any(has_pending),
                                    _ => false,
                                };
                        }
                        Err(error) => {
                            failed = true;
                            totals[index] = None;
                            pending[index] = false;
                            log_event(
                                "auth.cleanup.failure",
                                environment,
                                &request_id,
                                [("table", json!(table)), ("error", json!(error.to_string()))],
                                true,
                            );
                        }
                    }
                }
            }
            if !pending.iter().any(|&table| table) {
                break if failed { "table_error" } else { "drained" };
            }
            if rounds == MAX_ROUNDS {
                break "round_limit";
            }
            if js_sys::Date::now() - cutoff >= BUDGET_MS {
                break "time_budget";
            }
        },
    };
    let deleted: serde_json::Map<_, _> = TABLES
        .iter()
        .zip(totals)
        .map(|(&(table, _), count)| (table.to_owned(), json!(count)))
        .collect();
    log_event(
        "auth.cleanup",
        environment,
        &request_id,
        [
            ("rounds", json!(rounds)),
            ("deleted", json!(deleted)),
            ("duration_ms", json!((js_sys::Date::now() - cutoff) as u64)),
            ("stop_reason", json!(reason)),
        ],
        failed || reason == "database_error",
    );
}
