// Native Workers primitives only; authentication decisions remain in Rust.
export function authRandom(n) {
  return crypto.getRandomValues(new Uint8Array(n))
}
export function authUuid() {
  return crypto.randomUUID()
}
