import type { AuthEnv } from '../identity/types.ts'
export function providers(env: AuthEnv) {
  return env.AUTH_ORIGIN.startsWith('https:') && env.PROVIDER_STATE_KEY
    ? ['google', 'apple'].filter((p) =>
        p === 'google'
          ? env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          : env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET,
      )
    : []
}
