export const DAY = 86400000
export const alive =
  "a.revoked_at IS NULL AND a.activity_at+2592000000>? AND a.created_at+7776000000>? AND u.status='ACTIVE'"
