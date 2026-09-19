export class Failure extends Error {
  readonly status: number
  constructor(status: number, code: string) {
    super(code)
    this.status = status
  }
}
export function requireThat(
  condition: unknown,
  status = 400,
  code = 'INVALID_REQUEST',
): asserts condition {
  if (!condition) throw new Failure(status, code)
}
export function str(value: unknown, max = 1024): string {
  requireThat(typeof value === 'string' && value.length <= max)
  return value
}
export async function boundedText(request: Request, limit: number): Promise<string> {
  const reader = request.body?.getReader()
  requireThat(reader)
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.length
    if (size > limit) {
      await reader.cancel()
      throw new Failure(413, 'INVALID_REQUEST')
    }
    parts.push(chunk.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return new TextDecoder().decode(bytes)
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  requireThat(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', 415)
  const text = await boundedText(request, 200_000)
  let result: unknown
  try {
    result = JSON.parse(text)
  } catch {
    throw new Failure(400, 'INVALID_REQUEST')
  }
  requireThat(result && typeof result === 'object' && !Array.isArray(result))
  return result as Record<string, unknown>
}
export function fields(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  requireThat(
    required.every((k) => Object.hasOwn(value, k)) &&
      Object.keys(value).every((k) => [...required, ...optional].includes(k)),
  )
}
export function secret(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)))
}
export function b64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
export async function hash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (x) => x.toString(16).padStart(2, '0'),
  ).join('')
}
export async function challenge(value: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/
export const iso = (n: number) => new Date(n).toISOString()
export function email(value: unknown): string {
  const v = str(value, 320).trim().toLowerCase()
  requireThat(
    v.length <= 254 &&
      /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
        v,
      ) &&
      v.indexOf('@') <= 64 &&
      v
        .split('@')[1]
        .split('.')
        .every((l) => l.length <= 63),
    400,
    'INVALID_EMAIL',
  )
  return v
}
export function name(value: unknown, max = 120): string {
  const s = str(value, max * 2).trim()
  requireThat(
    s && [...s].length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(s),
    400,
    'INVALID_DISPLAY_NAME',
  )
  return s
}
export function cookie(request: Request, key: string): string | null {
  const found = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(key + '='))
  return found.length === 1 ? found[0].slice(key.length + 1) : null
}
export function cookieHeader(origin: string, key: string, value: string, maxAge: number): string {
  return `${key}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`
}
export function rootCookie(origin: string): string {
  return origin.startsWith('https:') ? '__Host-auth_session' : 'auth_session_dev'
}
