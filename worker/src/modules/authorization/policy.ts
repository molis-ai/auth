export const roles = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']
export const catalog = [
  'space.read',
  'space.member.read',
  'role.read',
  'space.update',
  'space.archive',
  'space.restore',
  'project.read',
  'project.create',
  'project.update',
  'project.delete',
  'goal.read',
  'goal.advance',
  'goal.approve',
  'session.read',
  'session.manage',
  'feed.read',
  'feed.manage',
  'planning.read',
  'planning.update',
]
export const capabilities = [
  'team.read',
  'team.update',
  'members.read',
  'members.invite',
  'members.role',
  'members.remove',
  'invitations.read',
  'invitations.revoke',
  'audit.read',
  'team.archive',
  'team.leave',
]
export function consoleActions(role: string) {
  return capabilities.filter((a) =>
    a === 'team.leave'
      ? role !== 'OWNER'
      : a === 'team.archive'
        ? role === 'OWNER'
        : ['team.read', 'members.read'].includes(a) || ['OWNER', 'ADMIN'].includes(role),
  )
}
export function defaultGrant(role: string, action: string) {
  if (!catalog.includes(action) || !roles.includes(role)) return false
  if (action === 'space.archive' || action === 'space.restore') return role === 'OWNER'
  if (action.endsWith('.read')) return true
  if (['space.update', 'project.delete', 'goal.approve', 'feed.manage'].includes(action))
    return ['OWNER', 'ADMIN'].includes(role)
  return role !== 'VIEWER'
}
export function decision(
  role: string | null,
  status: string,
  type: string,
  action: string,
  actions: string[],
  grants: Record<string, boolean>,
): string {
  if (!catalog.includes(action)) return 'UNKNOWN_ACTION'
  if (!actions.includes(action)) return 'APPLICATION_ACTION_FORBIDDEN'
  if (!role) return 'NO_MEMBERSHIP'
  if (!(grants[role + ':' + action] ?? defaultGrant(role, action))) return 'ROLE_FORBIDDEN'
  if (
    type === 'PERSONAL' &&
    (role !== 'OWNER' || ['space.archive', 'space.restore'].includes(action))
  )
    return 'PERSONAL_SPACE'
  if (status === 'ARCHIVED' && !action.endsWith('.read') && action !== 'space.restore')
    return 'ARCHIVED_SPACE'
  return 'NONE'
}
