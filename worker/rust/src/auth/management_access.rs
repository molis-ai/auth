//! Management request protocol: current authorization, scoped pagination and atomic retry receipts.
use crate::core::management_protocol::{PageOrder, PageQuery, PageRequest};
use crate::{auth::login_sessions, core::http::*, core::identity::Auth, core::security::hash};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use worker::D1PreparedStatement;

pub(crate) struct Service<'a> {
    pub a: &'a Auth,
    pub s: Value,
    pub c: Value,
}
pub(crate) struct Context {
    pub tenant: Value,
    pub member: Value,
    pub record: Value,
    pub from: Value,
    pub to: Value,
    pub permission: Value,
    pub guards: Vec<D1PreparedStatement>,
}
impl Context {
    pub(crate) fn new() -> Self {
        Self {
            tenant: Value::Null,
            member: Value::Null,
            record: Value::Null,
            from: Value::Null,
            to: Value::Null,
            permission: Value::Null,
            guards: vec![],
        }
    }
}
pub(crate) struct Action {
    pub op: &'static str,
    pub path: String,
    pub tenant_id: String,
    pub id: String,
    pub schema: Option<&'static str>,
}
pub(crate) struct Change {
    pub result: Value,
    pub writes: Vec<D1PreparedStatement>,
    pub target_user: Value,
}
impl Change {
    pub fn new(result: Value, writes: Vec<D1PreparedStatement>) -> Self {
        Self {
            result,
            writes,
            target_user: Value::Null,
        }
    }
}
pub(crate) fn expected(b: &Value, row: &Value) -> Result<()> {
    ensure(
        b["expectedVersion"] == row["version"],
        409,
        "VERSION_CONFLICT",
    )
}
pub(crate) const ACTIVE_MEMBER: &str = "tenant_id=? AND status='ACTIVE'";
pub(crate) const ACTIVE_PERMISSION: &str = "permission=? AND status='ACTIVE'";
pub(crate) const ALL_ROLES: &[&str] = &["OWNER", "ADMIN", "MEMBER"];
pub(crate) const MANAGER_ROLES: &[&str] = &["OWNER", "ADMIN"];

pub(crate) fn require_member(ctx: &Context, roles: &[&str]) -> Result<()> {
    ensure(
        !ctx.tenant.is_null() && !ctx.member.is_null(),
        404,
        "NOT_FOUND",
    )?;
    ensure(ctx.tenant["status"] == "ACTIVE", 403, "TENANT_DISABLED")?;
    ensure(
        roles.contains(&text(&ctx.member, "role").as_str()),
        403,
        "FORBIDDEN",
    )
}

impl Service<'_> {
    pub fn user(&self) -> Value {
        self.s["user_id"].clone()
    }
    pub fn tenant_guard(&self, t: &Value, active: bool) -> Result<D1PreparedStatement> {
        self.a.s.guard("EXISTS(SELECT 1 FROM auth_tenant WHERE id=? AND version=? AND (?=0 OR status='ACTIVE'))",vec![t["id"].clone(),t["version"].clone(),active.into()])
    }
    pub fn member_guard(&self, m: &Value) -> Result<D1PreparedStatement> {
        self.a.s.guard("EXISTS(SELECT 1 FROM auth_tenant_membership WHERE id=? AND tenant_id=? AND user_id=? AND status='ACTIVE' AND role=? AND version=?)",vec![m["id"].clone(),m["tenant_id"].clone(),m["user_id"].clone(),m["role"].clone(),m["version"].clone()])
    }
    pub async fn platform_permission(&self, ctx: &mut Context, permission: &str) -> Result<()> {
        ctx.permission = self
            .a
            .s
            .one(
                &format!(
                    "SELECT * FROM auth_platform_permission WHERE user_id=? AND {ACTIVE_PERMISSION}"
                ),
                vec![self.user(), permission.into()],
            )
            .await?;
        ensure(!ctx.permission.is_null(), 403, "FORBIDDEN")?;
        ctx.guards.push(self.permission_guard(&ctx.permission)?);
        Ok(())
    }
    pub fn permission_guard(&self, permission: &Value) -> Result<D1PreparedStatement> {
        self.a.s.guard(
            &format!("EXISTS(SELECT 1 FROM auth_platform_permission WHERE user_id=? AND {ACTIVE_PERMISSION} AND version=?)"),
            vec![self.user(), permission["permission"].clone(), permission["version"].clone()],
        )
    }
}

pub fn ttl(name: &str) -> i64 {
    crate::core::contracts::unified_policy::default_integer(name) * 1000
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
        s.a.s.statement("INSERT INTO auth_management_result(actor_user_id,client_id,operation,target,idempotency_key_hash,request_hash,response_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",vec![s.s["user_id"].clone(),s.s["client_id"].clone(),action.op.into(),action.path.clone().into(),key.into(),hash(&b.to_string()).into(),json!({"data":result}).to_string().into(),n.into(),(n+ttl("idempotencyTtlSeconds")).into()])?])
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
            order: PageOrder::IdAsc,
        }
    }
}

impl From<PageQuery> for Read {
    fn from(page: PageQuery) -> Self {
        Self::Page {
            sql: page.sql,
            args: page.args,
            view: page.view,
            filters: page.filters,
            order: page.order,
        }
    }
}

const CURSOR_TTL_MS: i64 = 15 * 60_000;
const CURSOR_DOMAIN: &[u8] = b"molis-auth/management-cursor/v1\0";

fn invalid_cursor() -> Failure {
    Failure {
        status: 400,
        code: "INVALID_REQUEST",
    }
}

fn cursor_mac(a: &Auth, payload: &str) -> Result<Hmac<Sha256>> {
    let key = a.env.secret("AUTH_WEB_SESSION_KEY")?.to_string();
    let key = URL_SAFE_NO_PAD
        .decode(key)
        .map_err(|_| Failure::unavailable())?;
    ensure(key.len() == 32, 503, "AUTH_UNAVAILABLE")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| Failure::unavailable())?;
    mac.update(CURSOR_DOMAIN);
    mac.update(payload.as_bytes());
    Ok(mac)
}

fn open_cursor(a: &Auth, cursor: &str, request_scope: &str) -> Result<Value> {
    let (payload, signature) = cursor.split_once('.').ok_or_else(invalid_cursor)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| invalid_cursor())?;
    cursor_mac(a, payload)?
        .verify_slice(&signature)
        .map_err(|_| invalid_cursor())?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| invalid_cursor())?;
    let value: Value = serde_json::from_slice(&payload).map_err(|_| invalid_cursor())?;
    ensure(
        value["requestScope"] == request_scope && number(&value, "exp") > now(),
        400,
        "INVALID_REQUEST",
    )?;
    Ok(value)
}

fn sign_cursor(a: &Auth, scope: &str, authority: &Value, anchor: Value) -> Result<Value> {
    let payload = URL_SAFE_NO_PAD.encode(
        json!({
            "requestScope":scope,
            "scopeHash":hash(&authority.to_string()),
            "authority":authority,
            "anchor":anchor,
            "exp":now()+CURSOR_TTL_MS,
        })
        .to_string(),
    );
    let signature = URL_SAFE_NO_PAD.encode(cursor_mac(a, &payload)?.finalize().into_bytes());
    Ok(format!("{payload}.{signature}").into())
}

struct Snapshot<'a> {
    service: Service<'a>,
    ctx: Context,
}
impl Snapshot<'_> {
    fn authority(&self) -> Value {
        let Snapshot { service, ctx } = self;
        json!({
            "user":service.s["user_id"],
            "client":service.s["client_id"],
            "environment":service.c["environment_id"],
            "membership":ctx.member["id"],
            "memberVersion":ctx.member["version"],
            "permissionVersion":ctx.permission["version"],
            "tenantVersion":ctx.tenant["version"],
        })
    }
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
                    "SELECT id,status,version FROM auth_tenant WHERE id=?",
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

    fn actor(&self, expected: Option<&Value>) -> (String, Vec<Value>) {
        let mut values = self.principal_args.clone();
        let mut required = Vec::new();
        if let Some(authority) = expected {
            required.push("principal.user_id=? AND principal.client_id=?".to_owned());
            values.extend([authority["user"].clone(), authority["client"].clone()]);
        }
        match self.access {
            Access::Session => {}
            Access::Permission(permission) => {
                values.push(permission.into());
                let mut sql = format!(
                    "EXISTS(SELECT 1 FROM auth_platform_permission WHERE user_id=principal.user_id AND {ACTIVE_PERMISSION}"
                );
                if let Some(authority) = expected {
                    sql.push_str(" AND version=?");
                    values.push(authority["permissionVersion"].clone());
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
                if let Some(authority) = expected {
                    sql.push_str(" AND id=? AND version=?");
                    values.extend([
                        authority["membership"].clone(),
                        authority["memberVersion"].clone(),
                    ]);
                }
                sql.push_str(
                    " AND EXISTS(SELECT 1 FROM auth_tenant
                    WHERE id=tenant_id AND status='ACTIVE'",
                );
                if let Some(authority) = expected {
                    sql.push_str(" AND version=?");
                    values.push(authority["tenantVersion"].clone());
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
        cursor: Option<&Value>,
    ) -> Result<D1PreparedStatement> {
        let (actor, mut values) = self.actor(cursor.map(|saved| &saved["authority"]));
        values.extend_from_slice(args);
        let (anchor, sort) = if let Some(column) = order.time_column() {
            let sort = format!("{column} DESC, id DESC");
            let anchor = if let Some(saved) = cursor {
                ensure(
                    saved["anchor"]["time"].is_i64() && saved["anchor"]["id"].is_string(),
                    400,
                    "INVALID_REQUEST",
                )?;
                values.extend([
                    saved["anchor"]["time"].clone(),
                    saved["anchor"]["id"].clone(),
                ]);
                format!(" WHERE ({column},id)<(?,?)")
            } else {
                String::new()
            };
            (anchor, sort)
        } else {
            values.push(cursor.map_or_else(|| json!(""), |saved| saved["anchor"]["after"].clone()));
            (" WHERE id>?".into(), "id".into())
        };
        let mut gate = "EXISTS(SELECT 1 FROM actor)".to_owned();
        if let Some(target) = self.lookup {
            gate.push_str(&format!(" AND EXISTS(SELECT 1 FROM ({}))", target.sql));
            values.push(target.id.clone().into());
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
    let parsed_page = match &plan {
        Ok(Read::Page { filters, order, .. }) => Some((|| -> Result<_> {
            let page = PageRequest::parse(a, filters)?;
            let scope = hash(&json!({
                "path":action.path,"limit":page.limit,"filters":filters,"order":order.time_column()
            }).to_string());
            let cursor = page
                .cursor
                .as_deref()
                .map(|raw| open_cursor(a, raw, &scope))
                .transpose()?;
            Ok((page.limit, scope, cursor))
        })()),
        _ => None,
    };
    let browser = a.s.read_browser_session()?;
    let has_browser_guard = browser.is_some();
    let mut statements = browser.into_iter().collect::<Vec<_>>();
    statements.extend(query.prerequisites(credential)?);
    statements.extend(query.lookup_statement()?);
    if let (
        Ok(Read::Page {
            sql, args, order, ..
        }),
        Some(Ok((limit, _, cursor))),
    ) = (&plan, &parsed_page)
    {
        statements.push(query.page(limit + 1, sql, args, *order, cursor.as_ref())?);
    }
    let mut rows = match a.s.batch_read(statements).await {
        Ok(rows) => rows.into_iter(),
        Err(error) => {
            // SQL compilation can fail before SQLite evaluates the authorization gate.
            let principal = query.prerequisites(query.credential()?)?;
            query.context(&mut a.s.batch_read(principal).await?.into_iter(), false)?;
            return Err(error);
        }
    };
    if has_browser_guard {
        ensure(!first(&mut rows)?.is_null(), 409, "VERSION_CONFLICT")?;
    }
    let snapshot = query.context(&mut rows, true)?;
    match plan? {
        Read::Detail(view) => view(&snapshot.ctx),
        Read::Page { view, order, .. } => {
            let (limit, scope, cursor) = parsed_page.ok_or_else(Failure::unavailable)??;
            let authority = snapshot.authority();
            if let Some(cursor) = cursor {
                ensure(
                    cursor["scopeHash"] == hash(&authority.to_string()),
                    400,
                    "INVALID_REQUEST",
                )?;
            }
            let rows = rows.next().ok_or_else(Failure::unavailable)?;
            let items = rows
                .iter()
                .take(limit)
                .map(view)
                .collect::<Result<Vec<_>>>()?;
            let next = if rows.len() > limit {
                sign_cursor(a, &scope, &authority, order.anchor(&rows[limit - 1]))?
            } else {
                Value::Null
            };
            Ok(json!({"items":items,"nextCursor":next}))
        }
    }
}
