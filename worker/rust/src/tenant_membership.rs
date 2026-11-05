//! AUTH-10 membership transitions compose with the billing release plan in one batch.
use crate::{
    http::*,
    tenant_protocol as protocol,
    tenants::{Action, Context, Service, expected, member_view},
};
use serde_json::Value;
use worker::D1PreparedStatement;
pub(crate) struct ExitPlan {
    pub membership: Value,
    pub guards: Vec<D1PreparedStatement>,
    pub writes: Vec<D1PreparedStatement>,
}
pub(crate) fn prepare_exit(
    s: &Service,
    action: &Action,
    ctx: &Context,
    b: &Value,
) -> Result<ExitPlan> {
    let m = if action.op == "member.leave" {
        &ctx.member
    } else {
        &ctx.record
    };
    expected(b, m)?;
    ensure(m["status"] == "ACTIVE", 409, "VERSION_CONFLICT")?;
    ensure(m["role"] != "OWNER", 409, "OWNER_TRANSFER_REQUIRED")?;
    ensure(
        action.op == "member.leave" || ctx.member["role"] == "OWNER" || m["role"] == "MEMBER",
        403,
        "FORBIDDEN",
    )?;
    let mut ended = m.clone();
    ended["status"] = if action.op == "member.leave" {
        "LEFT"
    } else {
        "REMOVED"
    }
    .into();
    ended["version"] = (number(m, "version") + 1).into();
    let n = now();
    let mut writes=vec![
        s.a.s.statement("UPDATE auth_tenant_membership SET status=?,ended_at=?,version=version+1 WHERE id=?",vec![ended["status"].clone(),n.into(),m["id"].clone()])?,
        s.a.s.statement("UPDATE auth_ownership_transfer SET status='CANCELLED',resolved_at=?,version=version+1 WHERE tenant_id=? AND status='PENDING' AND (from_membership_id=? OR to_membership_id=?)",vec![n.into(),m["tenant_id"].clone(),m["id"].clone(),m["id"].clone()])?,
        s.a.s.statement("UPDATE auth_managed_tenant SET entitlement_revision=entitlement_revision+1,updated_at=? WHERE space_id=?",vec![n.into(),m["tenant_id"].clone()])?
    ];
    // The billing owner selects and releases the live assignments at commit time,
    // including any assignment committed after request-time membership reads.
    writes.extend(s.release_member_seats(m, action.op == "member.leave", n)?);
    Ok(ExitPlan {
        membership: member_view(&ended),
        guards: vec![
            s.tenant_guard(&ctx.tenant, true)?,
            s.member_guard(&ctx.member)?,
            s.member_guard(m)?,
        ],
        writes,
    })
}

/// The only post-exit exception is reading the caller's already committed leave
/// receipt. It grants no tenant access and never applies to a new membership.
pub(crate) async fn replay_leave(
    s: &Service<'_>,
    action: &Action,
    b: &Value,
    key: &str,
) -> Result<Option<Value>> {
    let Some(result) = protocol::replay(s, action, b, key).await? else {
        return Ok(None);
    };
    ensure(
        result["userId"] == s.user()
            && result["tenantId"] == action.tenant_id
            && result["status"] == "LEFT",
        403,
        "FORBIDDEN",
    )?;
    let tenant = s.tenant(&action.tenant_id).await?;
    ensure(tenant["status"] == "ACTIVE", 403, "TENANT_DISABLED")?;
    let mut w = protocol::base(s)?;
    w.push(s.tenant_guard(&tenant, true)?);
    w.push(s.a.s.guard("EXISTS(SELECT 1 FROM auth_tenant_membership WHERE id=? AND user_id=? AND tenant_id=? AND status='LEFT' AND version=?)",vec![result["membershipId"].clone(),s.user(),tenant["id"].clone(),result["version"].clone()])?);
    s.a.s.batch(w, "VERSION_CONFLICT").await?;
    Ok(Some(result))
}
