// Native Workers primitives only; authentication decisions remain in Rust.
const dec = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const enc = (b) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
export async function authSeal(key, value) {
  const raw = dec(key)
  if (raw.length !== 32) throw Error('key')
  const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  return (
    enc(iv) +
    '.' +
    enc(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(value)))
  )
}
export async function authOpen(key, value) {
  const [iv, data, ...extra] = value.split('.')
  if (extra.length) throw Error('format')
  const raw = dec(key)
  if (raw.length !== 32) throw Error('key')
  const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dec(iv) }, k, dec(data)),
  )
}
export async function authVerify(jwk, input, signature) {
  const key = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(jwk),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    dec(signature),
    new TextEncoder().encode(input),
  )
}
export async function authFetchJson(url, form) {
  const r = await fetch(url, {
    method: form ? 'POST' : 'GET',
    body: form || undefined,
    headers: form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw Error('upstream')
  const reader = r.body.getReader()
  let n = 0,
    chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > 131072) {
      await reader.cancel()
      throw Error('size')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(n)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.length
  }
  return new TextDecoder().decode(bytes)
}
