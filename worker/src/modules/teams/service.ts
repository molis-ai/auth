import { Store } from '../../infrastructure/database.ts'
import { paginate } from '../../infrastructure/pagination.ts'
import { email, fields, iso, name, requireThat as ok, str } from '../../shared/http.ts'
import { Auth, type Principal } from '../identity/service.ts'

type Team = {
  id: string
  name: string
  description: string
  avatar_data: string | null
  space_type: string
  status: string
  version: number
  role: string | null
  memberCount: number
  ownerName: string | null
}
const selectTeam = `SELECT s.*,m.role,(SELECT count(*) FROM auth_membership WHERE space_id=s.id) memberCount,
 (SELECT u.display_name FROM auth_membership o JOIN auth_user u ON u.id=o.user_id WHERE o.space_id=s.id AND o.role='OWNER') ownerName
 FROM auth_space s LEFT JOIN auth_membership m ON m.space_id=s.id AND m.user_id=?`
export class Teams {
  readonly a: Auth
  readonly p: Principal
  readonly s: Store
  constructor(a: Auth, p: Principal) {
    this.a = a
    this.p = p
    this.s = a.s
  }
  view(t: Team) {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      avatarUrl: t.avatar_data,
      spaceType: t.space_type,
      status: t.status,
      version: t.version,
      role: t.role,
      memberCount: t.memberCount,
      ownerName: t.ownerName,
      canInspectManagement: this.p.platformAdmin || ['OWNER', 'ADMIN'].includes(t.role ?? ''),
    }
  }
  async team(id: string, management = false) {
    const t = await this.s.one<Team>(selectTeam + ' WHERE s.id=?', this.p.userId, id)
    ok(t && (t.role || (this.p.platformAdmin && t.space_type === 'TEAM')), 403, 'SPACE_FORBIDDEN')
    if (management)
      ok(this.p.platformAdmin || ['OWNER', 'ADMIN'].includes(t.role ?? ''), 403, 'SPACE_FORBIDDEN')
    return t
  }
  guard(id: string, roles: string[], active = true) {
    return this.s.guard(
      `EXISTS(SELECT 1 FROM auth_space s JOIN auth_membership m ON m.space_id=s.id WHERE s.id=? AND s.space_type='TEAM' AND m.user_id=? AND m.role IN (${roles.map(() => '?').join(',')})${active ? " AND s.status='ACTIVE'" : ''})`,
      [id, this.p.userId, ...roles],
    )
  }
  async list(url: URL, teams: boolean) {
    const q = url.searchParams.get('q') ?? '',
      order = url.searchParams.get('order') ?? 'asc'
    ok(q.length <= 120 && ['asc', 'desc'].includes(order))
    const sql =
      selectTeam +
      ` WHERE ${teams ? "s.space_type='TEAM' AND " : ''}(m.user_id IS NOT NULL OR ?=1) AND instr(lower(s.name),lower(?))>0`
    const result = await paginate<Team>(
      this.s,
      url,
      sql,
      [this.p.userId, teams && this.p.platformAdmin ? 1 : 0, q],
      `name COLLATE NOCASE ${order},id ${order}`,
    )
    return { ...result, items: result.items.map((t) => this.view(t)) }
  }
  async create(b: Record<string, unknown>, avatar: string | null) {
    fields(b, ['name'], ['description', 'avatarUrl'])
    const id = crypto.randomUUID(),
      now = Date.now(),
      n = name(b.name),
      desc = str(b.description ?? '', 200)
    await this.s.batch([
      this.s.statement(
        "INSERT INTO auth_space(id,name,description,avatar_data,space_type,status,created_at,updated_at) VALUES (?,?,?,?,'TEAM','ACTIVE',?,?)",
        id,
        n,
        desc,
        avatar,
        now,
        now,
      ),
      this.s.statement(
        "INSERT INTO auth_membership VALUES (?,?,'OWNER',?)",
        id,
        this.p.userId,
        now,
      ),
      this.s.audit('space.create', this.p.userId, this.a.requestId, { space: id }),
    ])
    return this.view(await this.team(id))
  }
  async update(id: string, b: Record<string, unknown>, avatar: string | null) {
    fields(b, ['name', 'version'], ['description', 'avatarUrl'])
    ok(Number.isSafeInteger(b.version))
    const t = await this.team(id)
    const n = name(b.name),
      desc = str(b.description ?? t.description, 200)
    await this.s.batch([
      this.guard(id, ['OWNER', 'ADMIN']),
      this.s.guard('EXISTS(SELECT 1 FROM auth_space WHERE id=? AND version=?)', [
        id,
        b.version as number,
      ]),
      this.s.statement(
        'UPDATE auth_space SET name=?,description=?,avatar_data=?,version=version+1,updated_at=? WHERE id=?',
        n,
        desc,
        Object.hasOwn(b, 'avatarUrl') ? avatar : t.avatar_data,
        Date.now(),
        id,
      ),
      this.s.audit('space.update', this.p.userId, this.a.requestId, {
        space: id,
        summary: 'profile updated; version=' + String(t.version + 1),
      }),
    ])
    return this.view(await this.team(id))
  }
  async archive(id: string, b: Record<string, unknown>) {
    fields(b, ['archived', 'version'])
    ok(typeof b.archived === 'boolean' && Number.isSafeInteger(b.version))
    await this.team(id)
    await this.s.batch([
      this.guard(id, ['OWNER'], false),
      this.s.guard('EXISTS(SELECT 1 FROM auth_space WHERE id=? AND version=?)', [
        id,
        b.version as number,
      ]),
      this.s.statement(
        'UPDATE auth_space SET status=?,version=version+1,updated_at=? WHERE id=?',
        b.archived ? 'ARCHIVED' : 'ACTIVE',
        Date.now(),
        id,
      ),
      this.s.audit(
        b.archived ? 'space.archive' : 'space.restore',
        this.p.userId,
        this.a.requestId,
        { space: id },
      ),
    ])
    return this.view(await this.team(id))
  }
  async members(id: string, url: URL) {
    await this.team(id)
    const q = url.searchParams.get('q') ?? '',
      sort = url.searchParams.get('sort') ?? 'role',
      order = url.searchParams.get('order') ?? 'desc'
    ok(q.length <= 254 && ['name', 'role'].includes(sort) && ['asc', 'desc'].includes(order))
    const sql = `SELECT u.id,u.display_name displayName,u.status,u.avatar_data avatarUrl,m.role,
      (SELECT json_group_array(canonical_email) FROM auth_user_email WHERE user_id=u.id) emails
      FROM auth_membership m JOIN auth_user u ON u.id=m.user_id WHERE m.space_id=? AND
      (instr(lower(u.display_name),lower(?))>0 OR EXISTS(SELECT 1 FROM auth_user_email e WHERE e.user_id=u.id AND instr(e.canonical_email,lower(?))>0))`
    const sorting =
      sort === 'name'
        ? `displayName COLLATE NOCASE ${order},id`
        : `CASE role WHEN 'OWNER' THEN 4 WHEN 'ADMIN' THEN 3 WHEN 'MEMBER' THEN 2 ELSE 1 END ${order},displayName COLLATE NOCASE,id`
    const result = await paginate<{ emails: string; role: string }>(
      this.s,
      url,
      sql,
      [id, q, q],
      sorting,
    )
    return {
      ...result,
      items: result.items.map((x) => ({
        ...x,
        emails: JSON.parse(x.emails),
        permissions: {
          actions: [],
          invite: ['OWNER', 'ADMIN'].includes(x.role),
          editableRoles:
            x.role === 'OWNER'
              ? ['ADMIN', 'MEMBER', 'VIEWER']
              : x.role === 'ADMIN'
                ? ['MEMBER', 'VIEWER']
                : [],
          removableRoles:
            x.role === 'OWNER'
              ? ['ADMIN', 'MEMBER', 'VIEWER']
              : x.role === 'ADMIN'
                ? ['MEMBER', 'VIEWER']
                : [],
        },
      })),
    }
  }
  async memberChange(id: string, target: string, role: string | null, self = false) {
    const t = await this.team(id)
    const targetRow = await this.s.one<{ role: string }>(
      'SELECT role FROM auth_membership WHERE space_id=? AND user_id=?',
      id,
      target,
    )
    ok(targetRow && targetRow.role !== 'OWNER' && t.space_type === 'TEAM', 403, 'ROLE_FORBIDDEN')
    if (role !== null) ok(['ADMIN', 'MEMBER', 'VIEWER'].includes(role))
    const allowed = self ? ['ADMIN', 'MEMBER', 'VIEWER'] : ['OWNER', 'ADMIN']
    if (!self)
      ok(
        t.role === 'OWNER' ||
          (t.role === 'ADMIN' &&
            ['MEMBER', 'VIEWER'].includes(targetRow.role) &&
            (role === null || ['MEMBER', 'VIEWER'].includes(role))),
        403,
        'ROLE_FORBIDDEN',
      )
    await this.s.batch([
      this.guard(id, allowed, role !== null),
      this.s.guard(
        'EXISTS(SELECT 1 FROM auth_membership WHERE space_id=? AND user_id=? AND role=?)',
        [id, target, targetRow.role],
      ),
      ...(!self
        ? [
            this.s.guard(
              'EXISTS(SELECT 1 FROM auth_membership WHERE space_id=? AND user_id=? AND role=?)',
              [id, this.p.userId, t.role!],
            ),
          ]
        : []),
      role === null
        ? this.s.statement('DELETE FROM auth_membership WHERE space_id=? AND user_id=?', id, target)
        : this.s.statement(
            'UPDATE auth_membership SET role=? WHERE space_id=? AND user_id=?',
            role,
            id,
            target,
          ),
      this.s.audit(
        self ? 'space.member.leave' : role === null ? 'space.member.remove' : 'space.member.role',
        this.p.userId,
        this.a.requestId,
        {
          space: id,
          target,
          summary: role ? targetRow.role + '->' + role : 'membership removed; data retained',
        },
      ),
    ])
    return { updated: true, removed: role === null, left: self }
  }
  async candidates(id: string, b: Record<string, unknown>) {
    fields(b, ['query'])
    const t = await this.team(id)
    ok(['OWNER', 'ADMIN'].includes(t.role ?? '') && t.status === 'ACTIVE', 403, 'SPACE_FORBIDDEN')
    const query = str(b.query, 254).trim()
    ok(query.length >= 2)
    const items = await this.s.all<{ joined: number; invited: number }>(
      `SELECT u.id,u.display_name displayName,e.canonical_email email,
      EXISTS(SELECT 1 FROM auth_membership WHERE user_id=u.id AND space_id=?) joined,
      EXISTS(SELECT 1 FROM auth_invitation WHERE recipient_user_id=u.id AND space_id=? AND status='PENDING' AND expires_at>?) invited
      FROM auth_user u JOIN auth_user_email e ON e.user_id=u.id WHERE u.status='ACTIVE' AND (instr(lower(u.display_name),lower(?))>0 OR instr(e.canonical_email,lower(?))>0) ORDER BY u.display_name LIMIT 10`,
      id,
      id,
      Date.now(),
      query,
      query,
    )
    return items.map((x) => ({ ...x, joined: !!x.joined, invited: !!x.invited }))
  }
  async invite(id: string, b: Record<string, unknown>) {
    fields(b, ['email', 'locale'])
    const address = email(b.email)
    ok(['zh-CN', 'en'].includes(str(b.locale)))
    await this.team(id)
    const recipient = await this.s.one<{ id: string }>(
      "SELECT u.id FROM auth_user u JOIN auth_user_email e ON e.user_id=u.id WHERE e.canonical_email=? AND u.status='ACTIVE'",
      address,
    )
    ok(recipient, 400, 'INVITEE_NOT_REGISTERED')
    const invitation = crypto.randomUUID(),
      now = Date.now()
    await this.s.batch([
      this.guard(id, ['OWNER', 'ADMIN']),
      this.s.guard(
        "NOT EXISTS(SELECT 1 FROM auth_invitation WHERE space_id=? AND recipient_user_id=? AND status='PENDING' AND expires_at>?)",
        [id, recipient.id, now],
      ),
      this.s.statement(
        "INSERT INTO auth_invitation VALUES (?,?,?,?,?,'PENDING',?,?)",
        invitation,
        id,
        address,
        recipient.id,
        this.p.userId,
        now,
        now + 7 * 86400000,
      ),
      this.s.audit('space.invitation.create', this.p.userId, this.a.requestId, {
        space: id,
        target: recipient.id,
      }),
    ])
    return { id: invitation, spaceId: id, status: 'PENDING' }
  }
  async invitations(url: URL, id?: string) {
    if (id) await this.team(id, true)
    const sql =
      `SELECT i.id,i.space_id spaceId,s.name spaceName,i.invited_email invitedEmail,u.display_name inviterName,
      CASE WHEN i.status='PENDING' AND i.expires_at<=${Date.now()} THEN 'EXPIRED' ELSE i.status END status,i.expires_at expiresAt,i.created_at createdAt
      FROM auth_invitation i JOIN auth_space s ON s.id=i.space_id JOIN auth_user u ON u.id=i.inviter_user_id WHERE ` +
      (id
        ? 'i.space_id=?'
        : "i.recipient_user_id=? AND i.status='PENDING' AND i.expires_at>? AND s.status='ACTIVE'")
    const result = await paginate<{ expiresAt: number; createdAt: number }>(
      this.s,
      url,
      sql,
      id ? [id] : [this.p.userId, Date.now()],
      'createdAt DESC,id DESC',
    )
    return {
      ...result,
      items: result.items.map((x) => ({
        ...x,
        expiresAt: iso(x.expiresAt),
        createdAt: iso(x.createdAt),
      })),
    }
  }
  async answer(id: string, accept: boolean) {
    const i = await this.s.one<{ space_id: string; recipient_user_id: string }>(
      'SELECT * FROM auth_invitation WHERE id=?',
      id,
    )
    ok(i && i.recipient_user_id === this.p.userId, 403, 'INVITATION_FORBIDDEN')
    const now = Date.now()
    const statements = [
      this.s.guard(
        "EXISTS(SELECT 1 FROM auth_invitation i JOIN auth_space s ON s.id=i.space_id WHERE i.id=? AND i.recipient_user_id=? AND i.status='PENDING' AND i.expires_at>? AND s.status='ACTIVE')",
        [id, this.p.userId, now],
      ),
    ]
    if (accept)
      statements.push(
        this.s.statement(
          "INSERT INTO auth_membership VALUES (?,?,'MEMBER',?) ON CONFLICT(space_id,user_id) DO NOTHING",
          i.space_id,
          this.p.userId,
          now,
        ),
      )
    statements.push(
      this.s.statement(
        'UPDATE auth_invitation SET status=? WHERE id=?',
        accept ? 'ACCEPTED' : 'DECLINED',
        id,
      ),
      this.s.audit(
        accept ? 'space.invitation.accept' : 'space.invitation.decline',
        this.p.userId,
        this.a.requestId,
        { space: i.space_id },
      ),
    )
    await this.s.batch(statements, 'INVITATION_NOT_AVAILABLE')
    return { accepted: accept, declined: !accept, spaceId: i.space_id }
  }
  async invitation(id: string) {
    const row = await this.s.one<{ recipientUserId: string; expiresAt: number; status: string }>(
      `SELECT i.id,i.recipient_user_id recipientUserId,i.space_id spaceId,s.name spaceName,i.invited_email invitedEmail,i.inviter_user_id inviterUserId,u.display_name inviterName,i.status,i.expires_at expiresAt FROM auth_invitation i JOIN auth_space s ON s.id=i.space_id JOIN auth_user u ON u.id=i.inviter_user_id WHERE i.id=?`,
      id,
    )
    ok(row && row.recipientUserId === this.p.userId, 403, 'INVITATION_FORBIDDEN')
    const { recipientUserId, ...view } = row
    return {
      ...view,
      status: row.status === 'PENDING' && row.expiresAt <= Date.now() ? 'EXPIRED' : row.status,
      expiresAt: iso(row.expiresAt),
    }
  }
  async revoke(space: string, id: string) {
    await this.team(space)
    await this.s.batch([
      this.guard(space, ['OWNER', 'ADMIN'], false),
      this.s.guard(
        "EXISTS(SELECT 1 FROM auth_invitation WHERE id=? AND space_id=? AND status='PENDING')",
        [id, space],
      ),
      this.s.statement(
        "UPDATE auth_invitation SET status='REVOKED' WHERE id=? AND space_id=?",
        id,
        space,
      ),
      this.s.audit('space.invitation.revoke', this.p.userId, this.a.requestId, { space }),
    ])
    return { revoked: true }
  }
  async audit(id: string, url: URL) {
    await this.team(id, true)
    const result = await paginate<{ occurredAt: number }>(
      this.s,
      url,
      `SELECT e.id,e.action,e.outcome,e.request_id requestId,e.occurred_at occurredAt,e.change_summary changeSummary,e.denial_reason denialReason,u.display_name actorName,t.display_name targetName FROM auth_audit_event e LEFT JOIN auth_user u ON u.id=e.actor_user_id LEFT JOIN auth_user t ON t.id=e.target_user_id WHERE e.space_id=?`,
      [id],
      'occurredAt DESC,id DESC',
    )
    return { ...result, items: result.items.map((x) => ({ ...x, occurredAt: iso(x.occurredAt) })) }
  }
}
