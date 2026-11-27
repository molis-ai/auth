// Native Workers primitives only; authentication decisions remain in Rust.
const dec = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const enc = (b) => {
  const bytes = new Uint8Array(b)
  const chunkSize = 8192
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const MAX_AES_KEYS = 4
const aesKeys = new Map()

async function aesKey(key, usage) {
  const cached = aesKeys.get(key)?.[usage]
  if (cached) return cached
  const raw = dec(key)
  if (raw.length !== 32) throw Error('key')
  // Publish only completed imports, so each pending operation belongs to its own request.
  const imported = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage])
  let keys = aesKeys.get(key)
  if (!keys) {
    if (aesKeys.size >= MAX_AES_KEYS) aesKeys.delete(aesKeys.keys().next().value)
    keys = {}
    aesKeys.set(key, keys)
  }
  keys[usage] = imported
  return imported
}

export async function authSeal(key, value) {
  const k = await aesKey(key, 'encrypt')
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
  const k = await aesKey(key, 'decrypt')
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dec(iv) }, k, dec(data)),
  )
}
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_CERTS_TIMEOUT_MS = 10_000
const GOOGLE_REFRESH_COOLDOWN_MS = 60_000
let googleSnapshot
const googleMissingKids = new Map()
const MAX_MISSING_KIDS = 64

function googleCacheTtl(headers) {
  const directives = headers.get('Cache-Control')?.split(',') ?? []
  let maxAge
  for (const directive of directives) {
    const name = directive.split('=', 1)[0].trim().toLowerCase()
    if (name === 'no-cache' || name === 'no-store') return 0
    if (name !== 'max-age') continue
    const match = /^max-age\s*=\s*(?:"(\d+)"|(\d+))$/i.exec(directive.trim())
    if (!match || maxAge !== undefined) return 0
    maxAge = Number(match[1] ?? match[2])
  }
  const ageHeader = headers.get('Age')
  if (ageHeader !== null && !/^\d+$/.test(ageHeader)) return 0
  const age = Number(ageHeader ?? 0)
  if (!Number.isSafeInteger(maxAge) || !Number.isSafeInteger(age)) return 0
  return Math.min(3600, Math.max(0, maxAge - age)) * 1000
}

async function fetchGoogleKeys() {
  const response = await fetch(GOOGLE_CERTS, {
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(GOOGLE_CERTS_TIMEOUT_MS),
  })
  const expiresAt = Date.now() + googleCacheTtl(response.headers)
  const jwks = JSON.parse(await boundedJson(response))
  if (!Array.isArray(jwks?.keys)) throw Error('google jwks')
  const rsaKeys = new Map()
  for (const jwk of jwks.keys) {
    if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) throw Error('google jwks')
    if (jwk.kty !== 'RSA' || jwk.alg !== 'RS256' || jwk.use !== 'sig') continue
    if (typeof jwk.kid !== 'string' || !jwk.kid || rsaKeys.has(jwk.kid)) {
      throw Error('google jwks')
    }
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    rsaKeys.set(jwk.kid, key)
  }
  return { keys: rsaKeys, expiresAt }
}

export async function googleVerify(kid, input, signature) {
  const now = Date.now()
  const snapshot = googleSnapshot?.expiresAt > now ? googleSnapshot : undefined
  let key = snapshot?.keys.get(kid)
  if (!key) {
    if (snapshot && googleMissingKids.get(kid) > now) return false
    // Only completed keys are shared. Fetch and import belong to this request.
    const refreshed = await fetchGoogleKeys()
    if (refreshed.expiresAt > Date.now()) {
      googleSnapshot = refreshed
      if (!refreshed.keys.has(kid)) {
        if (googleMissingKids.size >= MAX_MISSING_KIDS)
          googleMissingKids.delete(googleMissingKids.keys().next().value)
        googleMissingKids.set(kid, Math.min(refreshed.expiresAt, now + GOOGLE_REFRESH_COOLDOWN_MS))
      }
    } else {
      googleSnapshot = undefined
      googleMissingKids.clear()
    }
    key = refreshed.keys.get(kid)
  }
  if (!key) return false
  try {
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      dec(signature),
      new TextEncoder().encode(input),
    )
  } catch {
    return false
  }
}

export async function authFetchJson(url, form) {
  const r = await fetch(url, {
    method: form ? 'POST' : 'GET',
    body: form || undefined,
    headers: form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  })
  return boundedJson(r)
}

async function boundedJson(r) {
  if (!r.ok) {
    void r.body?.cancel().catch(() => {})
    throw Error('upstream')
  }
  if (!r.body) throw Error('upstream')
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

export async function githubUser(form) {
  const request = { redirect: 'manual', signal: AbortSignal.timeout(10000) }
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    ...request,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  })
  const token = JSON.parse(await boundedJson(tokenResponse))
  if (
    typeof token.access_token !== 'string' ||
    !/^[A-Za-z0-9_-]{1,1024}$/.test(token.access_token) ||
    token.token_type?.toLowerCase() !== 'bearer'
  ) {
    throw Error('github exchange')
  }
  return boundedJson(
    await fetch('https://api.github.com/user', {
      ...request,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token.access_token,
        'User-Agent': 'Molis-Auth',
      },
    }),
  )
}
