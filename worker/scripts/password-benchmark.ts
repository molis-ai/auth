import { performance } from 'node:perf_hooks'
import { derivePassword } from '../src/security/password.ts'

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
