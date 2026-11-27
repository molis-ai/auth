//! Tenant request protocol: current authorization, scoped pagination and atomic retry receipts.
use crate::{
    auth::login_sessions,
    http::*,
    identity::Auth,
    security::{hash, secret},
    tenants::{ACTIVE_MEMBER, ACTIVE_PERMISSION, Action, Context, Service, require_member},
};
use serde_json::{Value, json};
use worker::D1PreparedStatement;

pub fn ttl(name: &str) -> i64 {
    crate::unified_policy::default_integer(name) * 1000
}
pub fn base(s: &Service<'_>) -> Result<Vec<D1PreparedStatement>> {
    Ok(vec![
        login_sessions::client_guard(s.a, &s.c)?,
        login_sessions::active_guard(s.a, &s.s)?,
    ])
}
pub fn key(a: &Auth) -> Result<String> {
    let key = a.header("Idempotency-Key");
    ensure(
        (16..=128).contains(&key.chars().count()),
        400,
        "INVALID_REQUEST",
    )?;
    Ok(hash(&key))
}
pub async fn replay(
    s: &Service<'_>,
    action: &Action,
    b: &Value,
    key: &str,
) -> Result<Option<Value>> {
    let row=s.a.s.one("SELECT * FROM auth_management_result WHERE actor_user_id=? AND client_id=? AND operation=? AND target=? AND idempotency_key_hash=? AND expires_at>?",vec![s.s["user_id"].clone(),s.s["client_id"].clone(),action.op.into(),action.path.clone().into(),key.into(),now().into()]).await?;
    if row.is_null() {
        return Ok(None);
    }
    ensure(
        row["request_hash"] == hash(&b.to_string()),
        409,
        "IDEMPOTENCY_CONFLICT",
    )?;
    Ok(Some(parsed(&row, "response_json")?["data"].clone()))
}
pub fn receipt(
    s: &Service<'_>,
    action: &Action,
    b: &Value,
    key: &str,
    result: &Value,
) -> Result<Vec<D1PreparedStatement>> {
    let n = now();
    let args = vec![
        s.s["user_id"].clone(),
        s.s["client_id"].clone(),
        action.op.into(),
        action.path.clone().into(),
        key.into(),
        n.into(),
    ];
    Ok(vec![s.a.s.statement("DELETE FROM auth_management_result WHERE actor_user_id=? AND client_id=? AND operation=? AND target=? AND idempotency_key_hash=? AND expires_at<=?",args)?,
        s.a.s.statement("INSERT INTO auth_management_result VALUES (?,?,?,?,?,?,200,?,?,?)",vec![s.s["user_id"].clone(),s.s["client_id"].clone(),action.op.into(),action.path.clone().into(),key.into(),hash(&b.to_string()).into(),json!({"data":result}).to_string().into(),n.into(),(n+ttl("idempotencyTtlSeconds")).into()])?])
}
pub const ACTOR: &str = "(SELECT user_id FROM actor)";

#[derive(Clone, Copy)]
pub enum Access {
    Session,
    Permission(&'static str),
    Member(&'static [&'static str]),
}

pub struct Lookup {
    pub sql: String,
    pub id: String,
    pub guard: Option<fn(&Service<'_>, &Value) -> Result<D1PreparedStatement>>,
}

#[derive(Clone, Copy)]
pub enum PageOrder {
    Id,
    AuditTime,
    TenantTime,
}
impl PageOrder {
    fn time_column(self) -> Option<&'static str> {
        match self {
            Self::Id => None,
            Self::AuditTime => Some("occurred_at"),
            Self::TenantTime => Some("managed_at"),
        }
    }

    fn anchor(self, row: &Value) -> Value {
        match self.time_column() {
            Some(column) => json!({"id":row["id"],"time":row[column]}),
            None => json!({"after":row["id"]}),
        }
    }
}

pub enum Read {
    Detail(fn(&Context) -> Result<Value>),
    Page {
        sql: String,
        args: Vec<Value>,
        view: fn(&Value) -> Result<Value>,
        filters: Value,
        order: PageOrder,
    },
}
impl Read {
    pub fn page(
        sql: impl Into<String>,
        args: Vec<Value>,
        view: fn(&Value) -> Result<Value>,
    ) -> Self {
        Self::Page {
            sql: sql.into(),
            args,
            view,
            filters: json!({}),
            order: PageOrder::Id,
        }
    }
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
        let mut values = form(a.request.url()?.query().unwrap_or_default())?;
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

    pub fn status(&mut self) -> Result<()> {
        if let Some(status) = self.values["status"].as_str() {
            ensure(
                matches!(status, "ACTIVE" | "DISABLED"),
                400,
                "INVALID_REQUEST",
            )?;
            self.bind("status=?", [json!(status)]);
        }
        Ok(())
    }

    pub fn search(&mut self, columns: &[&str]) -> Result<()> {
        if let Some(q) = self.values["q"].as_str() {
            ensure(q.chars().count() <= 128, 400, "INVALID_REQUEST")?;
            let q = q.trim();
            if !q.is_empty() {
                let matches = columns
                    .iter()
                    .map(|column| format!("instr(lower({column}),lower(?))>0"))
                    .collect::<Vec<_>>()
                    .join(" OR ");
                let args = vec![json!(q); columns.len()];
                self.bind(format!("({matches})"), args);
            }
        }
        Ok(())
    }

    pub fn page(self, sql: &str, view: fn(&Value) -> Result<Value>, order: PageOrder) -> Read {
        let sql = if self.conditions.is_empty() {
            sql.to_owned()
        } else {
            format!(
                "SELECT * FROM ({sql}) WHERE {}",
                self.conditions.join(" AND ")
            )
        };
        Read::Page {
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
struct PageRequest {
    limit: usize,
    cursor_hash: Option<String>,
}
impl PageRequest {
    fn parse(a: &Auth, filters: &Value) -> Result<Self> {
        let q = form(a.request.url()?.query().unwrap_or_default())?;
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
        let cursor_hash = if raw.is_empty() {
            None
        } else {
            ensure(token(&raw), 400, "INVALID_REQUEST")?;
            Some(hash(&raw))
        };
        Ok(Self { limit, cursor_hash })
    }
}

const CURSOR_ROW: &str = "SELECT binding_hash,payload FROM auth_one_use
    WHERE token_hash=? AND purpose='V2_TENANT_CURSOR' AND expires_at>?";

struct Snapshot<'a> {
    service: Service<'a>,
    ctx: Context,
}
impl Snapshot<'_> {
    fn scope(
        &self,
        action: &Action,
        page: &PageRequest,
        filters: &Value,
        order: PageOrder,
    ) -> String {
        let Snapshot { service, ctx } = self;
        let mut binding = json!({"user":service.s["user_id"],"client":service.s["client_id"],"environment":service.c["environment_id"],"path":action.path,"limit":page.limit,"membership":ctx.member,"permission":ctx.permission,"tenantVersion":ctx.tenant["version"],"filters":filters});
        if let Some(column) = order.time_column() {
            binding["order"] = json!(column);
        }
        hash(&binding.to_string())
    }
}

fn validate_cursor(row: &Value, scope: &str) -> Result<Value> {
    ensure(row["binding_hash"] == scope, 400, "INVALID_REQUEST")?;
    parsed(row, "payload")
}

struct Cursor<'a> {
    page: &'a PageRequest,
    filters: &'a Value,
    hash: &'a str,
    order: PageOrder,
}
struct CursorSnapshot<'a> {
    snapshot: Snapshot<'a>,
    binding: String,
    payload: Value,
    after: Value,
}
struct ReadQuery<'a> {
    a: &'a Auth,
    action: &'a Action,
    access: Access,
    lookup: Option<&'a Lookup>,
    digest: String,
    principal_sql: String,
    principal_args: Vec<Value>,
}

fn first(rows: &mut impl Iterator<Item = Vec<Value>>) -> Result<Value> {
    Ok(rows
        .next()
        .ok_or_else(Failure::unavailable)?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

impl<'a> ReadQuery<'a> {
    fn prerequisites(&self, credential: D1PreparedStatement) -> Result<Vec<D1PreparedStatement>> {
        let who = login_sessions::ACCESS_USER_ID;
        let mut statements = vec![credential];
        match self.access {
            Access::Session => {}
            Access::Permission(permission) => statements.push(self.a.s.statement(
                &format!("SELECT * FROM auth_platform_permission WHERE user_id={who} AND {ACTIVE_PERMISSION}"),
                vec![self.digest.clone().into(), permission.into()],
            )?),
            Access::Member(_) => statements.extend([
                self.a.s.statement(
                    "SELECT space_id id,status,version FROM auth_managed_tenant WHERE space_id=?",
                    vec![self.action.tenant_id.clone().into()],
                )?,
                self.a.s.statement(
                    &format!("SELECT * FROM auth_tenant_membership WHERE user_id={who} AND {ACTIVE_MEMBER}"),
                    vec![self.digest.clone().into(), self.action.tenant_id.clone().into()],
                )?,
            ]),
        }
        Ok(statements)
    }

    fn context(
        &self,
        rows: &mut impl Iterator<Item = Vec<Value>>,
        include_lookup: bool,
    ) -> Result<Snapshot<'a>> {
        let (s, c) = login_sessions::active_result(
            self.a,
            first(rows)?,
            self.digest.clone(),
            &self.a.header("Origin"),
        )?;
        let service = Service { a: self.a, s, c };
        let mut ctx = Context::new();
        match self.access {
            Access::Session => {}
            Access::Permission(_) => {
                ctx.permission = first(rows)?;
                ensure(!ctx.permission.is_null(), 403, "FORBIDDEN")?;
            }
            Access::Member(roles) => {
                ctx.tenant = first(rows)?;
                ctx.member = first(rows)?;
                require_member(&ctx, roles)?;
            }
        }
        if include_lookup && self.lookup.is_some() {
            ctx.record = first(rows)?;
            ensure(!ctx.record.is_null(), 404, "NOT_FOUND")?;
        }
        Ok(Snapshot { service, ctx })
    }

    fn actor(&self, expected: Option<&Snapshot<'_>>) -> (String, Vec<Value>) {
        let mut values = self.principal_args.clone();
        let mut required = Vec::new();
        if let Some(snapshot) = expected {
            required.push("principal.user_id=? AND principal.client_id=?".to_owned());
            values.extend([
                snapshot.service.user(),
                snapshot.service.s["client_id"].clone(),
            ]);
        }
        match self.access {
            Access::Session => {}
            Access::Permission(permission) => {
                values.push(permission.into());
                let mut sql = format!(
                    "EXISTS(SELECT 1 FROM auth_platform_permission WHERE user_id=principal.user_id AND {ACTIVE_PERMISSION}"
                );
                if let Some(snapshot) = expected {
                    sql.push_str(" AND version=?");
                    values.push(snapshot.ctx.permission["version"].clone());
                }
                required.push(sql + ")");
            }
            Access::Member(roles) => {
                values.extend([self.action.tenant_id.clone().into(), json!(roles)]);
                let mut sql = format!(
                    "EXISTS(SELECT 1 FROM auth_tenant_membership
                     WHERE user_id=principal.user_id AND {ACTIVE_MEMBER}
                     AND role IN (SELECT value FROM json_each(?))"
                );
                if let Some(snapshot) = expected {
                    sql.push_str(" AND id=? AND version=?");
                    values.extend([
                        snapshot.ctx.member["id"].clone(),
                        snapshot.ctx.member["version"].clone(),
                    ]);
                }
                sql.push_str(
                    " AND EXISTS(SELECT 1 FROM auth_managed_tenant
                    WHERE space_id=tenant_id AND status='ACTIVE'",
                );
                if let Some(snapshot) = expected {
                    sql.push_str(" AND version=?");
                    values.push(snapshot.ctx.tenant["version"].clone());
                }
                required.push(sql + "))");
            }
        }
        let clause = if required.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", required.join(" AND "))
        };
        (
            format!(
                "WITH actor AS (SELECT principal.* FROM ({}) principal{clause})",
                self.principal_sql
            ),
            values,
        )
    }

    fn lookup_statement(&self) -> Result<Option<D1PreparedStatement>> {
        self.lookup.as_ref().map(|target| {
            let (actor, mut values) = self.actor(None);
            values.push(target.id.clone().into());
            self.a.s.statement(
                &format!("{actor} SELECT * FROM ({}) LIMIT CASE WHEN EXISTS(SELECT 1 FROM actor) THEN 1 ELSE 0 END", target.sql),
                values,
            )
        }).transpose()
    }

    fn page(
        &self,
        size: usize,
        sql: &str,
        args: &[Value],
        order: PageOrder,
        cursor: Option<(&Cursor<'_>, &CursorSnapshot<'_>, i64)>,
    ) -> Result<D1PreparedStatement> {
        let (actor, mut values) = self.actor(cursor.map(|(_, saved, _)| &saved.snapshot));
        values.extend_from_slice(args);
        let (anchor, sort) = if let Some(column) = order.time_column() {
            let sort = format!("{column} DESC, id DESC");
            let anchor = if let Some((_, saved, _)) = cursor {
                ensure(
                    saved.after["time"].is_i64() && saved.after["id"].is_string(),
                    400,
                    "INVALID_REQUEST",
                )?;
                values.extend([saved.after["time"].clone(), saved.after["id"].clone()]);
                format!(" WHERE ({column},id)<(?,?)")
            } else {
                String::new()
            };
            (anchor, sort)
        } else {
            values.push(
                cursor.map_or_else(|| json!(""), |(_, saved, _)| saved.after["after"].clone()),
            );
            (" WHERE id>?".into(), "id".into())
        };
        let mut gate = "EXISTS(SELECT 1 FROM actor)".to_owned();
        if let Some(target) = self.lookup {
            gate.push_str(&format!(" AND EXISTS(SELECT 1 FROM ({}))", target.sql));
            values.push(target.id.clone().into());
        }
        if let Some((cursor, saved, time)) = cursor {
            gate.push_str(&format!(
                " AND EXISTS(SELECT 1 FROM ({CURSOR_ROW}) WHERE binding_hash=? AND payload=?)"
            ));
            values.extend([
                cursor.hash.into(),
                time.into(),
                saved.binding.clone().into(),
                saved.payload.clone(),
            ]);
        }
        values.push(size.into());
        // SQLite evaluates LIMIT first. A zero limit skips the protected
        // SELECT, even when its row projection or WHERE expression can fail.
        self.a.s.statement(
            &format!("{actor} SELECT * FROM ({sql}){anchor} ORDER BY {sort} LIMIT CASE WHEN {gate} THEN ? ELSE 0 END"),
            values,
        )
    }

    fn credential(&self) -> Result<D1PreparedStatement> {
        login_sessions::active_lookup(
            self.a,
            login_sessions::bearer(&self.a.header("Authorization")),
        )
        .map(|(_, statement)| statement)
    }

    async fn probe(&self, cursor: Option<&Cursor<'_>>) -> Result<Option<CursorSnapshot<'a>>> {
        let mut statements = self.prerequisites(self.credential()?)?;
        statements.extend(self.lookup_statement()?);
        if let Some(cursor) = cursor {
            statements.push(
                self.a
                    .s
                    .statement(CURSOR_ROW, vec![cursor.hash.into(), now().into()])?,
            );
        }
        let mut rows = match self.a.s.batch_read(statements).await {
            Ok(rows) => rows.into_iter(),
            Err(error) => {
                // A broken data source can fail at SQL compilation before
                // SQLite evaluates LIMIT. Check authorization without it.
                login_sessions::active(self.a).await?;
                let mut rows = self
                    .a
                    .s
                    .batch_read(self.prerequisites(self.credential()?)?)
                    .await?
                    .into_iter();
                self.context(&mut rows, false)?;
                return Err(error);
            }
        };
        let snapshot = self.context(&mut rows, true)?;
        cursor
            .map(|cursor| {
                let row = first(&mut rows)?;
                let binding =
                    snapshot.scope(self.action, cursor.page, cursor.filters, cursor.order);
                let after = validate_cursor(&row, &binding)?;
                Ok(CursorSnapshot {
                    snapshot,
                    binding,
                    payload: row["payload"].clone(),
                    after,
                })
            })
            .transpose()
    }
}

pub async fn read(
    a: &Auth,
    action: &Action,
    access: Access,
    lookup: Option<Lookup>,
    plan: Result<Read>,
) -> Result<Value> {
    let (digest, credential) =
        login_sessions::active_lookup(a, login_sessions::bearer(&a.header("Authorization")))?;
    let (principal_sql, principal_args) = login_sessions::active_actor(a, &digest);
    let query = ReadQuery {
        a,
        action,
        access,
        lookup: lookup.as_ref(),
        digest,
        principal_sql,
        principal_args,
    };
    let page = match &plan {
        Ok(Read::Page { filters, .. }) => Some(PageRequest::parse(a, filters)),
        _ => None,
    };
    let cursor = match (&plan, &page) {
        (Ok(Read::Page { filters, order, .. }), Some(Ok(page))) => {
            page.cursor_hash.as_deref().map(|hash| Cursor {
                page,
                filters,
                hash,
                order: *order,
            })
        }
        _ => None,
    };
    // The existing cursor binding is a hash of authorization and request
    // context. Verify it before submitting the protected page, then fence
    // that scope and cursor again inside the actual page snapshot.
    let saved = if let Some(cursor) = &cursor {
        query.probe(Some(cursor)).await?
    } else {
        None
    };
    let mut statements = query.prerequisites(credential)?;
    statements.extend(query.lookup_statement()?);
    if let (
        Ok(Read::Page {
            sql, args, order, ..
        }),
        Some(Ok(page)),
    ) = (&plan, &page)
    {
        let time = now();
        let bound = cursor.as_ref().zip(saved.as_ref());
        if let Some((cursor, _)) = bound {
            statements.push(a.s.statement(CURSOR_ROW, vec![cursor.hash.into(), time.into()])?);
        }
        statements.push(query.page(
            page.limit + 1,
            sql,
            args,
            *order,
            bound.map(|(cursor, saved)| (cursor, saved, time)),
        )?);
    }
    let mut results = match a.s.batch_read(statements).await {
        Ok(results) => results.into_iter(),
        Err(error) => {
            query.probe(cursor.as_ref()).await?;
            return Err(error);
        }
    };
    let snapshot = query.context(&mut results, true)?;
    let result = match plan? {
        Read::Detail(view) => return view(&snapshot.ctx),
        Read::Page {
            view,
            filters,
            order,
            ..
        } => {
            let page = page.ok_or_else(Failure::unavailable)??;
            let scope = snapshot.scope(action, &page, &filters, order);
            if let Some(saved) = saved {
                let cursor = first(&mut results)?;
                validate_cursor(&cursor, &scope)?;
                ensure(cursor["payload"] == saved.payload, 400, "INVALID_REQUEST")?;
            }
            let Snapshot { service, ctx } = snapshot;
            let rows = results.next().ok_or_else(Failure::unavailable)?;
            let items = rows
                .iter()
                .take(page.limit)
                .map(view)
                .collect::<Result<Vec<_>>>()?;
            let next = if rows.len() > page.limit {
                let mut writes = base(&service)?;
                match access {
                    Access::Session => {}
                    Access::Permission(_) => {
                        writes.push(service.permission_guard(&ctx.permission)?)
                    }
                    Access::Member(_) => writes.extend([
                        service.tenant_guard(&ctx.tenant, true)?,
                        service.member_guard(&ctx.member)?,
                    ]),
                }
                if let Some(guard) = lookup.as_ref().and_then(|target| target.guard) {
                    writes.push(guard(&service, &ctx.record)?);
                }
                let raw = secret();
                writes.push(a.s.statement(
                    "INSERT INTO auth_one_use VALUES (?,'V2_TENANT_CURSOR',?,?,?)",
                    vec![
                        hash(&raw).into(),
                        scope.into(),
                        order.anchor(&rows[page.limit - 1]).to_string().into(),
                        (now() + 900000).into(),
                    ],
                )?);
                a.s.batch_page_cursor(writes).await?;
                Value::String(raw)
            } else {
                Value::Null
            };
            json!({"items":items,"nextCursor":next})
        }
    };
    Ok(result)
}
