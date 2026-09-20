import { randomBytes, createHash } from 'node:crypto'
import { getRustProxy, initializeLocalRuntime } from './local-runtime.mjs'

// Bootstrap credentials through the actual Rust signup handler, not a second
// implementation of password/email policy. This database is isolated and discarded.
export async function localCredential(email, password) {
  const origin = 'http://127.0.0.1:8787'
  const proxy = await getRustProxy({ AUTH_ORIGIN: origin })
  try {
    await initializeLocalRuntime(proxy)
    async function post(path, data, transaction) {
      const response = await proxy.fetch(
        new Request(origin + path, {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            ...(transaction ? { 'X-Auth-Transaction': transaction } : {}),
          },
          body: JSON.stringify(data),
        }),
      )
      const result = await response.json()
      if (!response.ok) throw new Error(result.error?.code || 'LOCAL_BOOTSTRAP_FAILED')
      return result.data
    }
    const flow = await post('/api/v1/auth/transactions', {
      clientId: 'molis-auth-console',
      redirectUri: origin + '/console/callback',
      codeChallenge: createHash('sha256').update(randomBytes(32)).digest('base64url'),
      codeChallengeMethod: 'S256',
      state: randomBytes(32).toString('base64url'),
      scopes: ['account', 'profile'],
    })
    await post(
      '/api/v1/auth/transactions/signup',
      { email, password, confirmPassword: password },
      flow.transaction,
    )
    const row = await proxy.env.DB.prepare(
      'SELECT e.canonical_email email,c.password_hash encoded FROM auth_user_email e JOIN auth_local_credential c ON c.user_id=e.user_id',
    ).first()
    if (!row) throw new Error('LOCAL_BOOTSTRAP_FAILED')
    return row
  } finally {
    await proxy.dispose()
  }
}
