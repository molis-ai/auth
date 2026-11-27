use crate::{core::http::*, core::security::uuid};
use serde_json::Value;
use wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement, D1Result};

pub(crate) enum WebSessionAccess {
    Lease(String, i64),
    ReadOnly(String, i64),
}

pub struct Store {
    pub db: D1Database,
    pub(crate) web_session_access: Option<WebSessionAccess>,
    log_env: &'static str,
    request_id: String,
    route: &'static str,
}
impl Store {
    pub fn new(db: D1Database, log: &RequestLog<'_>) -> Self {
        Self {
            db,
            web_session_access: None,
            log_env: log.env,
            request_id: log.id.to_owned(),
            route: log.route,
        }
    }
    pub(crate) fn log_failure(&self, phase: &'static str, failure: &Failure, started: i64) {
        log_failure(
            self.log_env,
            &self.request_id,
            self.route,
            phase,
            failure,
            started,
        );
    }
    fn database_failure(&self, error: worker::Error, phase: &'static str, started: i64) -> Failure {
        let failure = Failure::from(error);
        self.log_failure(phase, &failure, started);
        failure
    }
    pub fn statement(&self, sql: &str, values: Vec<Value>) -> Result<D1PreparedStatement> {
        let args = values
            .into_iter()
            .map(|v| {
                Ok(match v {
                    Value::Null => JsValue::NULL,
                    Value::String(s) => JsValue::from(s),
                    Value::Number(n) => JsValue::from_f64(
                        n.as_f64()
                            .filter(|n| n.is_finite())
                            .ok_or_else(Failure::unavailable)?,
                    ),
                    Value::Bool(b) => JsValue::from_f64(if b { 1.0 } else { 0.0 }),
                    _ => JsValue::from(v.to_string()),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let started = now();
        self.db
            .prepare(sql)
            .bind(&args)
            .map_err(|error| self.database_failure(error, "d1.bind", started))
    }
    pub async fn one(&self, sql: &str, values: Vec<Value>) -> Result<Value> {
        self.first(self.statement(sql, values)?).await
    }
    pub(crate) async fn first(&self, statement: D1PreparedStatement) -> Result<Value> {
        let started = now();
        let result = statement
            .first::<Value>(None)
            .await
            .map_err(|error| self.database_failure(error, "d1.first", started))?;
        Ok(result.unwrap_or(Value::Null))
    }
    pub async fn all(&self, sql: &str, values: Vec<Value>) -> Result<Vec<Value>> {
        let statement = self.statement(sql, values)?;
        let started = now();
        statement
            .all()
            .await
            .and_then(|result| result.results::<Value>())
            .map_err(|error| self.database_failure(error, "d1.all", started))
    }
    pub async fn run(&self, sql: &str, values: Vec<Value>) -> Result<()> {
        let statement = self.statement(sql, values)?;
        let started = now();
        statement
            .run()
            .await
            .map(|_| ())
            .map_err(|error| self.database_failure(error, "d1.run", started))
    }
    pub fn guard(&self, condition: &str, mut values: Vec<Value>) -> Result<D1PreparedStatement> {
        values.insert(0, Value::String(uuid()));
        self.statement(&format!("INSERT INTO auth_write_guard(id,ok) VALUES (?,CASE WHEN ({condition}) THEN 1 ELSE 0 END)"),values)
    }
    pub async fn batch(
        &self,
        statements: Vec<D1PreparedStatement>,
        conflict: &'static str,
    ) -> Result<()> {
        self.write_batch(statements, conflict).await.map(|_| ())
    }
    pub(crate) fn read_browser_session(&self) -> Result<Option<D1PreparedStatement>> {
        match &self.web_session_access {
            Some(WebSessionAccess::ReadOnly(id, revision)) => self.statement(
                "SELECT 1 FROM auth_web_session WHERE id_hash=? AND revision=? AND status='READY' AND expires_at>?",
                vec![id.as_str().into(), (*revision).into(), now().into()],
            ).map(Some),
            _ => Ok(None),
        }
    }

    pub(crate) async fn batch_returning(
        &self,
        mut statements: Vec<D1PreparedStatement>,
        returning: D1PreparedStatement,
        conflict: &'static str,
    ) -> Result<Value> {
        let index = statements.len() + usize::from(self.web_session_access.is_some());
        statements.push(returning);
        let started = now();
        let results = self.write_batch(statements, conflict).await?;
        let result = results.get(index).ok_or_else(Failure::unavailable)?;
        self.result_rows(result, "d1.batch", started)?
            .into_iter()
            .next()
            .ok_or_else(Failure::unavailable)
    }
    pub(crate) async fn batch_read(
        &self,
        statements: Vec<D1PreparedStatement>,
    ) -> Result<Vec<Vec<Value>>> {
        let started = now();
        let size = statements.len();
        let results = self
            .db
            .batch(statements)
            .await
            .map_err(|error| self.database_failure(error, "d1.batch_read", started))?;
        if results.len() != size {
            let failure = Failure::unavailable();
            self.log_failure("d1.batch_read", &failure, started);
            return Err(failure);
        }
        results
            .iter()
            .map(|result| self.result_rows(result, "d1.batch_read", started))
            .collect()
    }
    fn result_rows(
        &self,
        result: &D1Result,
        phase: &'static str,
        started: i64,
    ) -> Result<Vec<Value>> {
        if !result.success() {
            let failure = Failure::unavailable();
            self.log_failure(phase, &failure, started);
            return Err(failure);
        }
        result
            .results::<Value>()
            .map_err(|error| self.database_failure(error, phase, started))
    }
    async fn write_batch(
        &self,
        mut statements: Vec<D1PreparedStatement>,
        conflict: &'static str,
    ) -> Result<Vec<D1Result>> {
        if let Some(access) = &self.web_session_access {
            let (id, revision, status) = match access {
                WebSessionAccess::Lease(id, revision) => (id, revision, "BUSY"),
                WebSessionAccess::ReadOnly(..) => return Err(Failure::unavailable()),
            };
            statements.insert(0, self.guard("EXISTS(SELECT 1 FROM auth_web_session WHERE id_hash=? AND revision=? AND status=? AND expires_at>?)", vec![id.clone().into(),(*revision).into(),status.into(),now().into()])?);
        }
        statements.push(self.statement("DELETE FROM auth_write_guard", vec![])?);
        let started = now();
        match self.db.batch(statements).await {
            Ok(results) => Ok(results),
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
                    self.database_failure(e, "d1.batch", started)
                })
            }
        }
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep each audit event field explicit at call sites"
    )]
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
