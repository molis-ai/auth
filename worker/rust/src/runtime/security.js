// Native Workers primitives only; authentication decisions remain in Rust.
export function authRandom(n) {
  return crypto.getRandomValues(new Uint8Array(n))
}
export function authUuid() {
  return crypto.randomUUID()
}
export async function authDerive(password, salt) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 },
      key,
      256,
    ),
  )
}
