import { performance } from 'node:perf_hooks'
import { webcrypto } from 'node:crypto'

// Diagnostic comparison only; production derives with RustCrypto inside a Durable Object.
async function derivePassword(raw: string, salt: Uint8Array, iterations: number) {
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(raw.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  )
}

console.log(
  'Local Node WebCrypto elapsed time ONLY — not Cloudflare CPU or deployment compatibility.',
)
const salt = new Uint8Array(16)
for (const iterations of [5_000, 100_000, 600_000]) {
  await derivePassword('synthetic-benchmark-not-a-user-password', salt, iterations)
  const samples: number[] = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    await derivePassword('synthetic-benchmark-not-a-user-password', salt, iterations)
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  console.log(
    JSON.stringify({
      iterations,
      samples: 5,
      medianElapsedMs: +samples[2].toFixed(2),
      maxElapsedMs: +samples[4].toFixed(2),
    }),
  )
}
