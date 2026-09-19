import { avatar } from '../../security/avatar.ts'
import { Failure, fields, str } from '../../shared/http.ts'
import type { Auth } from '../identity/service.ts'
import type { Principal } from '../identity/types.ts'
import { Teams } from './service.ts'
export async function teamRoutes(
  a: Auth,
  p: Principal,
  relative: string,
  method: string,
  url: URL,
  b: Record<string, unknown>,
) {
  const teams = new Teams(a, p)
  if (relative === '/spaces' && method === 'GET') return teams.list(url, false)
  if (relative === '/spaces/teams' && method === 'GET') return teams.list(url, true)
  if (relative === '/spaces' && method === 'POST') return teams.create(b, await avatar(b.avatarUrl))
  const space = relative.match(/^\/spaces\/([^/]+)(.*)$/)
  if (space) {
    const [, id, tail] = space
    if (!tail && method === 'GET') return teams.view(await teams.team(id))
    if (!tail && method === 'PUT') return teams.update(id, b, await avatar(b.avatarUrl))
    if (tail === '/archive' && method === 'PUT') return teams.archive(id, b)
    if (tail === '/members' && method === 'GET') return teams.members(id, url)
    if (tail === '/invite-candidates' && method === 'POST') return teams.candidates(id, b)
    if (tail === '/invitations' && method === 'GET') return teams.invitations(url, id)
    if (tail === '/invitations' && method === 'POST') return teams.invite(id, b)
    if (tail === '/audit' && method === 'GET') return teams.audit(id, url)
    if (tail === '/leave' && method === 'POST') {
      fields(b, [])
      return teams.memberChange(id, p.userId, null, true)
    }
    const member = tail.match(/^\/members\/([^/]+)\/(role|remove)$/)
    if (member && method === (member[2] === 'role' ? 'PUT' : 'POST')) {
      fields(b, member[2] === 'role' ? ['role'] : [])
      return teams.memberChange(id, member[1], member[2] === 'role' ? str(b.role) : null)
    }
    const revoke = tail.match(/^\/invitations\/([^/]+)\/revoke$/)
    if (revoke && method === 'POST') {
      fields(b, [])
      return teams.revoke(id, revoke[1])
    }
  }
  if (relative === '/invitations' && method === 'GET') return teams.invitations(url)
  const invitationDetail = relative.match(/^\/invitations\/([^/]+)$/)
  if (invitationDetail && method === 'GET') return teams.invitation(invitationDetail[1])
  const invitation = relative.match(/^\/invitations\/([^/]+)\/(accept|decline)$/)
  if (invitation && method === 'POST') {
    fields(b, [])
    return teams.answer(invitation[1], invitation[2] === 'accept')
  }
  throw new Failure(404, 'NOT_FOUND')
}
