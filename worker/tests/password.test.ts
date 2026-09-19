import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pbkdf2Sync } from 'node:crypto'
import {
  derivePassword,
  matchesLegacyPassword,
  normalizePassword,
  PASSWORD_VERSION,
} from '../src/security/password.ts'

test('legacy layout: 16-byte salt followed by 32-byte PBKDF2 result', async () => {
  const salt = Uint8Array.from({ length: 16 }, (_, i) => i)
  const raw = 'migration-test-密码-e\u0301'
  const expected = pbkdf2Sync(raw.normalize('NFC'), salt, 600_000, 32, 'sha256')
  // Independently generated with JDK 21 SecretKeyFactory/PBEKeySpec, 2026-09-19.
  assert.equal(
    expected.toString('hex'),
    '08acf49901aaf21cdef94f9532bb327863e74f577a312f971f4e7098044612fe',
  )
  const encoded = PASSWORD_VERSION + Buffer.concat([salt, expected]).toString('hex')
  assert.deepEqual(Buffer.from(await derivePassword(raw, salt)), expected)
  assert.equal(await matchesLegacyPassword(raw, encoded), true)
  assert.equal(await matchesLegacyPassword('wrong-password', encoded), false)
  assert.equal(await matchesLegacyPassword(raw, encoded.replace('600k', '100k')), false)
  assert.equal(await matchesLegacyPassword(raw, PASSWORD_VERSION + '00'), false)
})
test('normalization preserves spaces and rejects malformed/oversized Unicode', () => {
  assert.equal(normalizePassword(' e\u0301 '), ' é ')
  assert.equal(normalizePassword('\ud800'), null)
  assert.equal(normalizePassword('😀'.repeat(128)), '😀'.repeat(128))
  assert.equal(normalizePassword('a'.repeat(129)), null)
})
