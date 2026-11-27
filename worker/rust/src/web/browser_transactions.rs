//! Encrypted task state for individual browser authentication transactions.
use super::web_session::{decode, seal};
use crate::core::{http::*, identity::Auth};
use serde_json::{Value, json};
use worker::D1PreparedStatement;

pub(super) struct BrowserTransactions {
    rows: Vec<Value>,
}

impl BrowserTransactions {
    pub(super) async fn load(
        a: &Auth,
        browser: &str,
        key: &str,
        path: &str,
        body: &Value,
    ) -> Result<(Self, Value)> {
        let mut handles: Vec<String> = [
            "reauthHandle",
            "identityHandle",
            "resetHandle",
            "verificationId",
        ]
        .into_iter()
        .filter_map(|field| body[field].as_str())
        .filter(|handle| uuid_shape(handle))
        .map(str::to_owned)
        .collect();
        if let Some(handle) = path
            .strip_prefix("/api/account/auth/transactions/")
            .and_then(|path| path.split('/').next())
            .filter(|handle| uuid_shape(handle))
        {
            handles.push(handle.to_owned());
        }
        if path == "/account/callback" {
            let query = form(a.http()?.url()?.query().unwrap_or_default())?;
            if let Some(handle) = query["transactionId"].as_str().filter(|id| uuid_shape(id)) {
                handles.push(handle.to_owned());
            }
        }
        if handles.is_empty() {
            return Ok((Self { rows: vec![] }, json!({})));
        }
        let rows =
            a.s.all(
                "SELECT handle,payload,revision FROM auth_browser_transaction
             WHERE browser_hash=? AND expires_at>? AND handle IN (SELECT value FROM json_each(?))",
                vec![browser.into(), now().into(), json!(handles)],
            )
            .await?;
        let mut data = json!({});
        for row in &rows {
            let handle = text(row, "handle");
            let transaction =
                decode(key, &format!("{browser}:{handle}"), &text(row, "payload")).await?;
            data[handle] = transaction;
        }
        Ok((Self { rows }, data))
    }

    pub(super) async fn writes(
        &self,
        a: &Auth,
        old_browser: &str,
        browser: &str,
        key: &str,
        before: &Value,
        after: &Value,
    ) -> Result<Vec<D1PreparedStatement>> {
        let mut writes = vec![];
        for row in &self.rows {
            let handle = text(row, "handle");
            if after[&handle] == before[&handle] && old_browser == browser {
                continue;
            }
            writes.push(a.s.guard(
                "EXISTS(SELECT 1 FROM auth_browser_transaction WHERE browser_hash=? AND handle=? AND revision=?)",
                vec![old_browser.into(), handle.clone().into(), row["revision"].clone()],
            )?);
            writes.push(a.s.statement(
                "DELETE FROM auth_browser_transaction WHERE browser_hash=? AND handle=?",
                vec![old_browser.into(), handle.into()],
            )?);
        }
        for (handle, transaction) in after.as_object().into_iter().flatten() {
            if transaction == &before[handle] && old_browser == browser {
                continue;
            }
            let expiry = transaction["expiresAt"]
                .as_str()
                .map(js_sys::Date::parse)
                .unwrap_or(0.0) as i64;
            if expiry <= now() {
                continue;
            }
            let next_revision = self
                .rows
                .iter()
                .find(|row| row["handle"] == *handle)
                .map_or(0, |row| number(row, "revision") + 1);
            let payload = seal(
                key,
                &json!({"id":format!("{browser}:{handle}"),"data":transaction}).to_string(),
            )
            .await
            .map_err(|_| Failure::unavailable())?;
            writes.push(a.s.statement(
                "INSERT INTO auth_browser_transaction(browser_hash,handle,payload,expires_at,revision)
                 VALUES (?,?,?,?,?)",
                vec![browser.into(), handle.as_str().into(), payload.into(), expiry.into(), next_revision.into()],
            )?);
        }
        Ok(writes)
    }
}

fn uuid_shape(handle: &str) -> bool {
    shape("Id", &json!(handle)).is_ok()
}
