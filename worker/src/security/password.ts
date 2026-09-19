// Password codec preserves the deployed 16-byte salt / 32-byte hash format.
export const PASSWORD_VERSION = '{pbkdf2-sha256-600k-v1}'
export const PASSWORD_ITERATIONS = 600_000

export function normalizePassword(raw: string): string | null {
  if (
    raw.length > 512 ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(raw)
  )
    return null
  const normalized = raw.normalize('NFC')
  return [...normalized].length <= 128 ? normalized : null
}

export async function derivePassword(
  raw: string,
  salt: Uint8Array,
  iterations = PASSWORD_ITERATIONS,
): Promise<Uint8Array> {
  const value = normalizePassword(raw)
  if (value === null || salt.length !== 16 || !Number.isSafeInteger(iterations) || iterations < 1)
    throw new Error('INVALID_PASSWORD_INPUT')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(value),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations },
      key,
      256,
    ),
  )
}

export async function matchesLegacyPassword(raw: string, encoded: string): Promise<boolean> {
  if (!encoded.startsWith(PASSWORD_VERSION)) return false
  const hex = encoded.slice(PASSWORD_VERSION.length)
  if (!/^[0-9a-f]{96}$/.test(hex) || normalizePassword(raw) === null) return false
  const bytes = Uint8Array.from(hex.match(/../g)!, (value) => parseInt(value, 16))
  const actual = await derivePassword(raw, bytes.slice(0, 16))
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= actual[i] ^ bytes[16 + i]
  return diff === 0
}
// The login service also pays dummy-KDF cost for unknown accounts;
// this parser alone is NOT an authentication endpoint or an enumeration defense.
