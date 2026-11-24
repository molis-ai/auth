const encoder = new TextEncoder()
const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

let signingKey

async function loadSigningKey(configuration) {
  if (signingKey?.configuration === configuration) return signingKey
  const { kid, kty, crv, x, d } = JSON.parse(configuration)
  const key = await crypto.subtle.importKey('jwk', { kty, crv, x, d }, { name: 'Ed25519' }, false, [
    'sign',
  ])
  signingKey = { configuration, kid, key }
  return signingKey
}

export async function signSyncReadProof(configuration, payload) {
  const { kid, key } = await loadSigningKey(configuration)
  const header = b64url(
    encoder.encode(JSON.stringify({ alg: 'EdDSA', typ: 'molis-sync-read+jwt', kid })),
  )
  const message = header + '.' + b64url(encoder.encode(payload))
  const signature = await crypto.subtle.sign('Ed25519', key, encoder.encode(message))
  return message + '.' + b64url(new Uint8Array(signature))
}
