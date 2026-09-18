export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER'
export function editableRoles(actor: Role | null, target: Role, personal: boolean, archived: boolean): Role[] {
  if (personal || archived || target === 'OWNER') return []
  if (actor === 'OWNER') return ['ADMIN', 'MEMBER', 'VIEWER']
  if (actor === 'ADMIN' && (target === 'MEMBER' || target === 'VIEWER')) return ['MEMBER', 'VIEWER']
  return []
}
export function removable(actor: Role | null, target: Role, personal: boolean) {
  return !personal && target !== 'OWNER' && (actor === 'OWNER' || actor === 'ADMIN' && (target === 'MEMBER' || target === 'VIEWER'))
}
