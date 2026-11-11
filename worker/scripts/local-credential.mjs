import { randomBytes, createHash } from 'node:crypto'
import { getRustProxy, initializeLocalRuntime } from './local-runtime.mjs'

// Actual V2 verified signup in a disposable database; never writes the developer's Home/DB.
export async function localCredential(email, password) {
  email = email.trim().toLowerCase()
  const origin = 'http://127.0.0.1:8787'
  const proxy = await getRustProxy({
    AUTH_ORIGIN: origin,
    UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
      environmentId: 'unified-local',
      kind: 'LOCAL',
      authOrigin: origin,
      deliveryMode: 'MOCK',
      providerMode: 'MOCK',
    }),
  })
  try {
    await initializeLocalRuntime(proxy)
    const proof = randomBytes(32).toString('base64url')
    async function post(path, data, initiator) {
      const r = await proxy.fetch(
        new Request(origin + path, {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            ...(initiator ? { 'X-Auth-Initiator-Proof': proof } : {}),
          },
          body: JSON.stringify(data),
        }),
      )
      const value = await r.json()
      if (!r.ok) throw Error(value.error?.code || 'LOCAL_BOOTSTRAP_FAILED')
      return value.data
    }
    const digest = (value) => createHash('sha256').update(value).digest('base64url')
    const t = await post('/api/v2/auth/transactions', {
      clientId: 'molis-auth-web-local',
      redirectUri: origin + '/account/callback',
      state: randomBytes(32).toString('base64url'),
      purpose: 'EMAIL_SIGNUP',
      method: 'EMAIL_CODE',
      codeChallenge: digest(proof),
      codeChallengeMethod: 'S256',
      initiatorChallenge: digest(proof),
    })
    const path = '/api/v2/auth/transactions/' + t.transactionId
    const sent = await post(path + '/challenges', { channel: 'EMAIL', address: email }, true)
    const delivered = await proxy.env.DB.prepare(
      'SELECT credential FROM auth_mock_delivery WHERE delivery_id=(SELECT delivery_id FROM auth_verification_challenge WHERE id=?)',
    )
      .bind(sent.challengeId)
      .first()
    const verified = await post(
      path + '/challenges/' + sent.challengeId + '/verify',
      { credential: delivered.credential },
      true,
    )
    await post(
      path + '/email-signup',
      { email, password, verificationProof: verified.verificationProof },
      true,
    )
    const row = await proxy.env.DB.prepare(
      'SELECT e.canonical_email email,c.password_hash encoded FROM auth_user_email e JOIN auth_local_credential c ON c.user_id=e.user_id',
    ).first()
    if (!row) throw Error('LOCAL_BOOTSTRAP_FAILED')
    return row
  } finally {
    await proxy.dispose()
  }
}
