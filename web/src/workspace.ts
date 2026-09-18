export const workspacePages = ['account', 'security', 'pending', 'spaces', 'team-create', 'permissions', 'applications', 'users', 'audit', 'mail'] as const
export type WorkspacePage = typeof workspacePages[number]
export function workspacePage(hash: string): WorkspacePage {
  if (workspaceTeam(hash)) return 'spaces'
  const value = hash.replace(/^#\//, '')
  return workspacePages.includes(value as WorkspacePage) ? value as WorkspacePage : 'account'
}
export function workspaceTeam(hash: string): string | undefined {
  return /^#\/spaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(hash)?.[1]
}
export function isPlatformPage(page: WorkspacePage) { return ['permissions', 'applications', 'users', 'audit', 'mail'].includes(page) }

type SelectionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export function rememberedTeam(storage: SelectionStorage, userId: string): string | undefined {
  try { return workspaceTeam('#/spaces/' + storage.getItem('molis.auth.workspace-team:' + userId)) } catch { return undefined }
}
export function rememberTeam(storage: SelectionStorage, userId: string, teamId?: string) {
  try {
    const key = 'molis.auth.workspace-team:' + userId
    if (teamId && workspaceTeam('#/spaces/' + teamId)) storage.setItem(key, teamId)
    else storage.removeItem(key)
  } catch { /* Selection persistence is optional. */ }
}

/** Clear only this console's account navigation, never SDK logout-pause markers. */
export function clearAccountWorkspace(storage: SelectionStorage, userId?: string): boolean {
  let cleared = true
  for (const key of ['molis.auth.workspace-page', 'molis.auth.workspace-team', 'molis.auth.provider-restart.v1', 'molis.auth.completion-intent.v1',
    ...(userId ? ['molis.auth.workspace-team:' + userId] : [])]) {
    try { storage.removeItem(key) } catch { cleared = false }
  }
  return cleared
}
