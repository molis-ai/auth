import type { Role } from './space-policy'
export type MemberPermissions = { actions: string[]; invite: boolean; editableRoles: Role[]; removableRoles: Role[] }
export function memberListPath(space: string, query: string, page: number, size: number, sort: 'name' | 'role' = 'role', order: 'asc' | 'desc' = 'desc') {
  const encoded = encodeURIComponent(query.trim()).replace(/[!'()*\.]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return '/spaces/' + space + '/members?page=' + page + '&limit=' + size + '&q=' + encoded + '&sort=' + sort + '&order=' + order
}
const labels: Record<string, [string,string]> = {
  'space.read':['查看团队','View team'], 'space.member.read':['查看成员','View members'], 'role.read':['查看角色','View roles'],
  'space.update':['编辑团队资料','Edit team profile'], 'space.archive':['归档团队','Archive team'], 'space.restore':['恢复团队','Restore team'],
  'project.read':['查看项目','View projects'], 'project.create':['创建项目','Create projects'], 'project.update':['编辑项目','Edit projects'], 'project.delete':['删除项目','Delete projects'],
  'goal.read':['查看目标','View goals'], 'goal.advance':['推进目标','Advance goals'], 'goal.approve':['审批目标','Approve goals'],
  'session.read':['查看会话','View sessions'], 'session.manage':['管理会话','Manage sessions'],
  'feed.read':['查看 Feed','View feed'], 'feed.manage':['管理 Feed 数据源','Manage feed sources'],
  'planning.read':['查看规划','View planning'], 'planning.update':['编辑规划','Edit planning'],
}
export function memberPermissionSummary(p: MemberPermissions, en: boolean): string {
  // Describe granted capabilities, not the role name: archive state can remove writes.
  const managesTeam = p.invite || p.editableRoles.length > 0 || p.removableRoles.length > 0 || p.actions.some(a => ['space.update','space.archive','space.restore'].includes(a))
  const writesBusiness = p.actions.some(a => ['project.create','project.update','project.delete','goal.advance','goal.approve','session.manage','feed.manage','planning.update'].includes(a))
  if (managesTeam && writesBusiness) return en ? 'Team management & collaboration' : '团队管理与业务操作'
  if (managesTeam) return en ? 'Team management & read access' : '团队管理与只读访问'
  if (writesBusiness) return en ? 'Business collaboration' : '业务协作'
  if (p.actions.length && p.actions.every(a => !!labels[a] && a.endsWith('.read'))) return en ? 'Read-only access' : '只读访问'
  return p.actions.length ? (en ? 'Custom access' : '其他权限') : (en ? 'No granted permissions' : '暂无可用权限')
}
export function memberPermissionLines(p: MemberPermissions, en: boolean): string[] {
  const roleName = (r: Role) => (en ? {OWNER:'Owner',ADMIN:'Administrator',MEMBER:'Member',VIEWER:'Viewer'} : {OWNER:'所有者',ADMIN:'管理员',MEMBER:'成员',VIEWER:'只读成员'})[r]
  return [
    ...(p.invite ? [en ? 'Invite members' : '邀请成员'] : []),
    ...(p.editableRoles.length ? [(en ? 'Change roles of: ' : '调整角色：') + p.editableRoles.map(roleName).join(en ? ', ' : '、')] : []),
    ...(p.removableRoles.length ? [(en ? 'Remove: ' : '移除成员：') + p.removableRoles.map(roleName).join(en ? ', ' : '、')] : []),
    ...p.actions.map(a => labels[a]?.[en ? 1 : 0] ?? a),
  ]
}
