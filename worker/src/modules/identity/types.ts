export interface AuthEnv {
  DB: D1Database
  AUTH_ORIGIN: string
  PLATFORM_ADMIN_IDS?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  APPLE_CLIENT_ID?: string
  APPLE_CLIENT_SECRET?: string
  PROVIDER_STATE_KEY?: string
}
export interface Client {
  id: string
  client_id: string
  application_id: string
  client_type: string
  status: string
  scopes: string
  redirects: string
  app_status: string
  version: number
}
export interface Context {
  id: string
  clientId: string
  clientType: string
  redirectUri: string
  challenge: string
  state: string
  scopes: string[]
  forceLogin: boolean
}
export interface Transaction {
  token_hash: string
  context: string
  status: string
  expires_at: number
  authentication_id: string | null
  proof_hash: string | null
  browser_hash: string | null
}
export interface Principal {
  userId: string
  applicationId: string
  clientId: string
  sessionId: string
  authenticationId: string
  scopes: string[]
  displayName: string
  avatarUrl: string | null
  platformAdmin: boolean
}
