use crate::{http::*, security::uuid};
use serde_json::Value;
use wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement};

pub struct Store {
    pub db: D1Database,
    pub web_owner: Option<(String, i64)>,
}
impl Store {
    pub fn new(db: D1Database) -> Self {
        Self {
            db,
            web_owner: None,
        }
    }
    pub fn statement(&self, sql: &str, values: Vec<Value>) -> Result<D1PreparedStatement> {
        let args: Vec<JsValue> = values
            .into_iter()
            .map(|v| match v {
                Value::Null => JsValue::NULL,
                Value::String(s) => JsValue::from(s),
                Value::Number(n) => JsValue::from_f64(n.as_f64().unwrap()),
                Value::Bool(b) => JsValue::from_f64(if b { 1.0 } else { 0.0 }),
                _ => JsValue::from(v.to_string()),
            })
            .collect();
        Ok(self.db.prepare(sql).bind(&args)?)
    }
    pub async fn one(&self, sql: &str, values: Vec<Value>) -> Result<Value> {
        Ok(self
            .statement(sql, values)?
            .first::<Value>(None)
            .await?
            .unwrap_or(Value::Null))
    }
    pub async fn all(&self, sql: &str, values: Vec<Value>) -> Result<Vec<Value>> {
        Ok(self
            .statement(sql, values)?
            .all()
            .await?
            .results::<Value>()?)
    }
    pub async fn run(&self, sql: &str, values: Vec<Value>) -> Result<()> {
        self.statement(sql, values)?.run().await?;
        Ok(())
    }
    pub fn guard(&self, condition: &str, mut values: Vec<Value>) -> Result<D1PreparedStatement> {
        values.insert(0, Value::String(uuid()));
        self.statement(&format!("INSERT INTO auth_write_guard(id,ok) VALUES (?,CASE WHEN ({condition}) THEN 1 ELSE 0 END)"),values)
    }
    pub async fn batch(
        &self,
        mut statements: Vec<D1PreparedStatement>,
        conflict: &'static str,
    ) -> Result<()> {
        if let Some((id, revision)) = &self.web_owner {
            statements.insert(0, self.guard("EXISTS(SELECT 1 FROM auth_web_session WHERE id_hash=? AND revision=? AND status='BUSY' AND expires_at>?)", vec![id.clone().into(),(*revision).into(),now().into()])?);
        }
        statements.push(self.statement("DELETE FROM auth_write_guard", vec![])?);
        match self.db.batch(statements).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                Err(if msg.contains("CHECK constraint failed") {
                    Failure {
                        status: 409,
                        code: conflict,
                    }
                } else if msg.contains("UNIQUE constraint failed") {
                    Failure {
                        status: 409,
                        code: "ALREADY_EXISTS",
                    }
                } else {
                    e.into()
                })
            }
        }
    }
    pub fn audit(
        &self,
        action: &str,
        actor: Value,
        request_id: &str,
        space: Value,
        target: Value,
        summary: Value,
        denied: bool,
    ) -> Result<D1PreparedStatement> {
        self.statement("INSERT INTO auth_audit_event(id,action,outcome,actor_user_id,target_user_id,space_id,request_id,occurred_at,change_summary) VALUES (?,?,?,?,?,?,?,?,?)",vec![uuid().into(),action.into(),(if denied {"DENIED"} else {"SUCCESS"}).into(),actor.clone(),if target.is_null(){actor}else{target},space,request_id.into(),now().into(),summary])
    }
}
