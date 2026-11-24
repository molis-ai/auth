//! Tenant request protocol: current authorization, scoped pagination and atomic retry receipts.
use crate::{
    auth::login_sessions,
    http::*,
    identity::Auth,
    security::{hash, secret},
    tenants::{
        ACTIVE_MEMBER, ACTIVE_PERMISSION, Action, Context, Service, TENANTS, require_member,
    },
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

pub enum Read {
    Detail(fn(&Context) -> Result<Value>),
    Page {
        sql: String,
        args: Vec<Value>,
        view: fn(&Value) -> Result<Value>,
        filters: Value,
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
        }
    }
}

// The opaque cursor is reusable, scoped to the current actor, client, route,
// filters and authorization. Keep the scope and payload compatible with issued cursors.
struct PageRequest {
    limit: usize,
    cursor_hash: Value,
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
            Value::Null
        } else {
            ensure(token(&raw), 400, "INVALID_REQUEST")?;
            hash(&raw).into()
        };
        Ok(Self { limit, cursor_hash })
    }

    fn push_statements(
        &self,
        a: &Auth,
        statements: &mut Vec<D1PreparedStatement>,
        digest: &str,
        sql: &str,
        args: &[Value],
    ) -> Result<()> {
        let who = login_sessions::ACCESS_USER_ID;
        if self.cursor_hash.is_null() {
            let mut values = vec![digest.into()];
            values.extend_from_slice(args);
            values.push((self.limit + 1).into());
            statements.push(a.s.statement(
                &format!(
                    "WITH actor AS (SELECT {who} AS user_id)
                          SELECT * FROM ({sql}) WHERE id>'' ORDER BY id LIMIT ?"
                ),
                values,
            )?);
        } else {
            let cursor = "SELECT binding_hash,payload FROM auth_one_use
                          WHERE token_hash=? AND purpose='V2_TENANT_CURSOR' AND expires_at>?";
            let expiry = now();
            let cursor_args = vec![self.cursor_hash.clone(), expiry.into()];
            statements.push(a.s.statement(cursor, cursor_args.clone())?);
            let mut values = vec![digest.into()];
            values.extend(cursor_args);
            values.extend_from_slice(args);
            values.push((self.limit + 1).into());
            statements.push(a.s.statement(
                &format!(
                    "WITH actor AS (SELECT {who} AS user_id), page_cursor AS ({cursor})
                          SELECT * FROM ({sql}) WHERE id>COALESCE(
                            (SELECT CASE WHEN json_valid(payload) THEN
                              CASE WHEN json_type(payload,'$.after')='text'
                              THEN json_extract(payload,'$.after') END END FROM page_cursor),'')
                          ORDER BY id LIMIT ?"
                ),
                values,
            )?);
        }
        Ok(())
    }
}

fn first(rows: &mut impl Iterator<Item = Vec<Value>>) -> Result<Value> {
    Ok(rows
        .next()
        .ok_or_else(Failure::unavailable)?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
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
    let who = login_sessions::ACCESS_USER_ID;
    let mut statements = vec![credential];
    match access {
        Access::Session => {}
        Access::Permission(permission) => statements.push(a.s.statement(
            &format!(
                "SELECT * FROM auth_platform_permission WHERE user_id={who} AND {ACTIVE_PERMISSION}"
            ),
            vec![digest.clone().into(), permission.into()],
        )?),
        Access::Member(_) => statements.extend([
            a.s.statement(
                &format!("{TENANTS} WHERE t.space_id=?"),
                vec![action.tenant_id.clone().into()],
            )?,
            a.s.statement(
                &format!(
                    "SELECT * FROM auth_tenant_membership WHERE user_id={who} AND {ACTIVE_MEMBER}"
                ),
                vec![digest.clone().into(), action.tenant_id.clone().into()],
            )?,
        ]),
    }
    if let Some(target) = &lookup {
        statements.push(a.s.statement(&target.sql, vec![target.id.clone().into()])?);
    }
    let page = match &plan {
        Ok(Read::Page { filters, .. }) => Some(PageRequest::parse(a, filters)),
        _ => None,
    };
    if let (Ok(Read::Page { sql, args, .. }), Some(Ok(page))) = (&plan, &page) {
        page.push_statements(a, &mut statements, &digest, sql, args)?;
    }

    // D1 executes the credential, authorization and data SELECTs in one
    // transaction. Validate the credential and context before exposing any row.
    let mut results = a.s.batch_read(statements).await?.into_iter();
    let (s, c) =
        login_sessions::active_result(a, first(&mut results)?, digest, &a.header("Origin"))?;
    let service = Service { a, s, c };
    let mut ctx = Context::new();
    match access {
        Access::Session => {}
        Access::Permission(_) => {
            ctx.permission = first(&mut results)?;
            ensure(!ctx.permission.is_null(), 403, "FORBIDDEN")?;
        }
        Access::Member(roles) => {
            ctx.tenant = first(&mut results)?;
            ctx.member = first(&mut results)?;
            require_member(&ctx, roles)?;
        }
    }
    if lookup.is_some() {
        ctx.record = first(&mut results)?;
        ensure(!ctx.record.is_null(), 404, "NOT_FOUND")?;
    }

    let result = match plan? {
        Read::Detail(view) => return view(&ctx),
        Read::Page { view, filters, .. } => {
            let page = page.ok_or_else(Failure::unavailable)??;
            let scope = hash(&json!({"user":service.s["user_id"],"client":service.s["client_id"],"environment":service.c["environment_id"],"path":action.path,"limit":page.limit,"membership":ctx.member,"permission":ctx.permission,"tenantVersion":ctx.tenant["version"],"filters":filters}).to_string());
            if !page.cursor_hash.is_null() {
                let cursor = first(&mut results)?;
                ensure(cursor["binding_hash"] == scope, 400, "INVALID_REQUEST")?;
                parsed(&cursor, "payload")?;
            }
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
                if let Some(guard) = lookup.and_then(|target| target.guard) {
                    writes.push(guard(&service, &ctx.record)?);
                }
                let raw = secret();
                writes.push(a.s.statement(
                    "INSERT INTO auth_one_use VALUES (?,'V2_TENANT_CURSOR',?,?,?)",
                    vec![
                        hash(&raw).into(),
                        scope.into(),
                        json!({"after":rows[page.limit - 1]["id"]}).to_string().into(),
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
