import { hash, requireThat as ok } from '../shared/http.ts'
import { blockedHashes } from './password-blocklist.ts'
import { derivePassword, normalizePassword, PASSWORD_VERSION } from './password.ts'
const common = new Set([
  'password',
  'password1',
  'password123',
  'password1234',
  'password!',
  'p@ssw0rd',
  'p@ssword',
  '12345678',
  '123456789',
  '1234567890',
  '12345678910',
  '87654321',
  'qwertyui',
  'qwertyuiop',
  'qwerty123',
  'qwerty12345',
  'abcdefgh',
  'abc12345',
  'abc123456',
  'iloveyou',
  'admin123',
  'admin1234',
  'admin12345',
  'adminadmin',
  'letmein1',
  'welcome1',
  'welcome123',
  'changeme',
  'changeme123',
  'asdfghjk',
  'asdfghjkl',
])
export async function encodePassword(raw: string): Promise<string> {
  const value = normalizePassword(raw)
  ok(value !== null && [...value].length >= 8, 400, 'INVALID_PASSWORD')
  ok(
    new Set(value).size > 1 &&
      !common.has(value.toLowerCase()) &&
      !blockedHashes.has(await hash(value.toLowerCase())),
    400,
    'PASSWORD_BLOCKED',
  )
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await derivePassword(value, salt)
  return PASSWORD_VERSION + [...salt, ...key].map((x) => x.toString(16).padStart(2, '0')).join('')
}
