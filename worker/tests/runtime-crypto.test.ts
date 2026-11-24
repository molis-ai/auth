import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import test from 'node:test'
import { authOpen, authSeal } from '../rust/src/runtime/federation.js'
import { signSyncReadProof } from '../rust/src/runtime/sync-read-proof.js'

test('AES-GCM reuses keys per usage, bounds cached keys and seals 192,000 UTF-8 bytes', async (t) => {
  const imports = t.mock.method(crypto.subtle, 'importKey')
  const key = () => randomBytes(32).toString('base64url')
  const first = key(),
    rotated = key()
  const payload = '汉🙂é'.repeat(21_333) + 'abc'
  assert.equal(Buffer.byteLength(payload), 192_000)
  const stored = await authSeal(first, payload)
  const [iv, ciphertext] = stored.split('.')
  assert.match(stored, /^[\w-]+\.[\w-]+$/)
  assert.equal(Buffer.from(iv, 'base64url').length, 12)
  assert.equal(Buffer.from(ciphertext, 'base64url').length, 192_016)
  const another = await authSeal(first, 'another payload')
  assert.equal(imports.mock.callCount(), 1)
  assert.equal(await authOpen(first, stored), payload)
  assert.equal(await authOpen(first, another), 'another payload')
  assert.equal(imports.mock.callCount(), 2)

  const updated = await authSeal(rotated, payload)
  await assert.rejects(authOpen(rotated, stored))
  assert.equal(await authOpen(rotated, updated), payload)
  await assert.rejects(authSeal('dGhpcw', payload), /key/)
  assert.equal(imports.mock.callCount(), 4)

  for (let i = 0; i < 3; i++) await authSeal(key(), 'rotate again')
  assert.equal(imports.mock.callCount(), 7)
  assert.equal(await authOpen(first, stored), payload)
  assert.equal(imports.mock.callCount(), 8)
})

test('sync read proofs cache the exact JWK configuration and rotate key bytes and kid', async (t) => {
  const imports = t.mock.method(crypto.subtle, 'importKey')
  const first = generateKeyPairSync('ed25519')
  const rotated = generateKeyPairSync('ed25519')
  const config = (key: typeof first, kid: string) =>
    JSON.stringify({ ...key.privateKey.export({ format: 'jwk' }), kid })
  const payload = JSON.stringify({ scope: 'molis-sync:read' })
  const original = config(first, 'fixture')
  const renamed = config(first, 'fixture-new')
  const replacement = config(rotated, 'fixture-new')
  const assertProof = (proof: string, key: typeof first, kid: string) => {
    const [header, body, signature] = proof.split('.')
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {
      alg: 'EdDSA',
      typ: 'molis-sync-read+jwt',
      kid,
    })
    assert.equal(Buffer.from(body, 'base64url').toString(), payload)
    assert.ok(
      verify(
        null,
        Buffer.from(`${header}.${body}`),
        key.publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    )
  }

  const proof = await signSyncReadProof(original, payload)
  assertProof(proof, first, 'fixture')
  assert.equal(await signSyncReadProof(original, payload), proof)
  assert.equal(imports.mock.callCount(), 1)
  assertProof(await signSyncReadProof(renamed, payload), first, 'fixture-new')
  assertProof(await signSyncReadProof(replacement, payload), rotated, 'fixture-new')
  await assert.rejects(signSyncReadProof('{', payload), SyntaxError)
  assert.equal(imports.mock.callCount(), 3)
  assertProof(await signSyncReadProof(original, payload), first, 'fixture')
  assert.equal(imports.mock.callCount(), 4)
})
