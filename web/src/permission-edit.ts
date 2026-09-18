export type PermissionLevel = 'none' | 'read' | 'edit' | 'custom'
export function permissionLevel(actions: string[], granted: string[]): PermissionLevel {
 const enabled=actions.filter(a=>granted.includes(a))
 if(!enabled.length)return 'none'
 if(enabled.every(a=>a.endsWith('.read')))return 'read'
 if(enabled.length===actions.length)return 'edit'
 return 'custom'
}
export function replaceResourceGrant(current:string[], actions:string[], level:PermissionLevel):string[] {
 if(level==='custom')return [...current]
 return [...current.filter(a=>!actions.includes(a)),...actions.filter(a=>level==='edit'||level==='read'&&a.endsWith('.read'))].sort()
}
