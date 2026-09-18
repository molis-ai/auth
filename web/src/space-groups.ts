import type { Role } from './space-policy.ts'
export function groupSpaces<T extends { spaceType: 'PERSONAL' | 'TEAM'; role: Role }>(spaces: T[]) {
  return {
    owned: spaces.filter(space => space.spaceType === 'TEAM' && space.role === 'OWNER'),
    managed: spaces.filter(space => space.spaceType === 'TEAM' && space.role === 'ADMIN'),
    joined: spaces.filter(space => space.spaceType === 'TEAM' && ['MEMBER', 'VIEWER'].includes(space.role)),
  }
}
