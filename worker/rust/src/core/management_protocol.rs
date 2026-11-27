//! Shared query parsing and keyset pagination for management lists.
use crate::core::{http::*, identity::Auth};
use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub enum PageOrder {
    IdAsc,
    TimeDesc(&'static str),
}
impl PageOrder {
    pub(crate) fn time_column(self) -> Option<&'static str> {
        match self {
            Self::IdAsc => None,
            Self::TimeDesc(column) => Some(column),
        }
    }

    pub(crate) fn anchor(self, row: &Value) -> Value {
        match self.time_column() {
            Some(column) => json!({"id":row["id"],"time":row[column]}),
            None => json!({"after":row["id"]}),
        }
    }
}

pub(crate) struct PageQuery {
    pub sql: String,
    pub args: Vec<Value>,
    pub view: fn(&Value) -> Result<Value>,
    pub filters: Value,
    pub order: PageOrder,
}

/// Only accepted query values enter the cursor scope. Keep the SQL predicates
/// and bound values alongside that scope so they describe the same page.
pub struct PageFilters {
    pub values: Value,
    pub conditions: Vec<String>,
    pub args: Vec<Value>,
}
impl PageFilters {
    pub fn parse(a: &Auth, keys: &[&str]) -> Result<Self> {
        let mut values = form(&a.query()?)?;
        let mut allowed = vec!["limit", "cursor"];
        allowed.extend_from_slice(keys);
        fields(&values, &[], &allowed)?;
        let filters = values.as_object_mut().ok_or_else(Failure::unavailable)?;
        filters.remove("limit");
        filters.remove("cursor");
        Ok(Self {
            values,
            conditions: vec![],
            args: vec![],
        })
    }

    pub fn bind(&mut self, condition: impl Into<String>, args: impl IntoIterator<Item = Value>) {
        self.conditions.push(condition.into());
        self.args.extend(args);
    }

    pub fn status(&mut self, accepted: &[&str]) -> Result<()> {
        if let Some(status) = self.values["status"].as_str() {
            ensure(accepted.contains(&status), 400, "INVALID_REQUEST")?;
            self.bind("status=?", [json!(status)]);
        }
        Ok(())
    }

    pub fn keyword(&self) -> Result<Option<&str>> {
        let Some(q) = self.values["q"].as_str() else {
            return Ok(None);
        };
        ensure(q.chars().count() <= 128, 400, "INVALID_REQUEST")?;
        let q = q.trim();
        Ok((!q.is_empty()).then_some(q))
    }

    pub fn search(&mut self, columns: &[&str]) -> Result<()> {
        if let Some(q) = self.keyword()? {
            let matches = columns
                .iter()
                .map(|column| format!("instr(lower({column}),lower(?))>0"))
                .collect::<Vec<_>>()
                .join(" OR ");
            let args = vec![json!(q); columns.len()];
            self.bind(format!("({matches})"), args);
        }
        Ok(())
    }

    pub fn page(self, sql: &str, view: fn(&Value) -> Result<Value>, order: PageOrder) -> PageQuery {
        if self.conditions.is_empty() {
            self.source_page(sql, view, order)
        } else {
            self.source_page(&format!("SELECT * FROM ({sql})"), view, order)
        }
    }

    pub fn source_page(
        self,
        sql: &str,
        view: fn(&Value) -> Result<Value>,
        order: PageOrder,
    ) -> PageQuery {
        let sql = if self.conditions.is_empty() {
            sql.to_owned()
        } else {
            format!("{sql} WHERE {}", self.conditions.join(" AND "))
        };
        PageQuery {
            sql,
            args: self.args,
            view,
            filters: self.values,
            order,
        }
    }
}

// The opaque cursor is reusable, scoped to the current actor, client, route,
// filters and authorization. Keep the scope and payload compatible with issued cursors.
pub(crate) struct PageRequest {
    pub(crate) limit: usize,
    pub(crate) cursor: Option<String>,
}
impl PageRequest {
    pub(crate) fn parse(a: &Auth, filters: &Value) -> Result<Self> {
        let q = form(&a.query()?)?;
        let mut allowed = vec!["limit", "cursor"];
        allowed.extend(
            filters
                .as_object()
                .ok_or_else(Failure::unavailable)?
                .keys()
                .map(String::as_str),
        );
        fields(&q, &[], &allowed)?;
        let limit = text(&q, "limit");
        let limit = if limit.is_empty() {
            20
        } else {
            ensure(
                limit.bytes().all(|x| x.is_ascii_digit()),
                400,
                "INVALID_REQUEST",
            )?;
            limit.parse::<usize>().unwrap_or(0)
        };
        ensure((1..=100).contains(&limit), 400, "INVALID_REQUEST")?;
        let raw = text(&q, "cursor");
        let cursor = if raw.is_empty() {
            None
        } else {
            ensure(raw.len() <= 2048, 400, "INVALID_REQUEST")?;
            Some(raw)
        };
        Ok(Self { limit, cursor })
    }
}
