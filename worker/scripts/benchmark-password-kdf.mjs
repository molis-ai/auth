import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { challenge, secret } from '../tests/fixtures.ts'
import { getRustProxy, initializeLocalRuntime } from './local-runtime.mjs'

// Compare two compiled Workers through the real password-login path. The fixture
// only observes the namespace and records when each request enters the real DO.
const fixtureEntrypoint = `
import worker, { PasswordKdf as RustPasswordKdf } from './index.js'

export class PasswordKdf {
  constructor(state, env) {
    this.kdf = new RustPasswordKdf(state, env)
  }
  async fetch(request) {
    const entered = Date.now()
    const response = await this.kdf.fetch(request)
    response.headers.set('X-Fixture-Kdf-Entered', String(entered))
    return response
  }
}

export default {
  async fetch(request, env, ctx) {
    const namespace = env.PASSWORD_KDF
    const calls = []
    const PASSWORD_KDF = {
      constructor: namespace.constructor,
      newUniqueId: () => namespace.newUniqueId(),
      idFromName: (name) => namespace.idFromName(name),
      get(id) {
        const stub = namespace.get(id)
        return { async fetch(request) {
          const started = Date.now()
          const response = await stub.fetch(request)
          const entered = response.headers.get('X-Fixture-Kdf-Entered')
          calls.push({
            name: id.name ?? null,
            id: String(id),
            kdfStatus: response.status,
            entryMs: entered === null ? null : Number(entered) - started,
            roundTripMs: Date.now() - started,
          })
          return response
        } }
      },
    }
    const response = await worker.prototype.fetch.call({ env: { ...env, PASSWORD_KDF }, ctx }, request)
    response.headers.set('X-Fixture-Kdf-Calls', JSON.stringify(calls))
    return response
  },
}
`

const [baseline, pooled] = process.argv.slice(2)
assert.ok(baseline && pooled, 'Pass the baseline and pooled Worker build directories')
const origin = 'http://127.0.0.1:8787'
const concurrency = 8
const bursts = 3
const password = 'synthetic-password-密码-é'
const config = JSON.stringify({
  environmentId: 'unified-local',
  kind: 'LOCAL',
  authOrigin: origin,
  deliveryMode: 'MOCK',
  providerMode: 'MOCK',
})

async function sample(buildDirectory) {
  const proxy = await getRustProxy(
    { AUTH_ORIGIN: origin, UNIFIED_ACCOUNT_CONFIG: config },
    undefined,
    undefined,
    { buildDirectory: resolve(buildDirectory), fixtureEntrypoint, handleStructuredLogs: () => {} },
  )
  try {
    await initializeLocalRuntime(proxy)
    const transactionPath = '/api/v1/auth/transactions'
    const post = (path, body, proof) =>
      proxy.fetch(
        new Request(origin + path, {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            ...(proof ? { 'X-Auth-Initiator-Proof': proof } : {}),
          },
          body: JSON.stringify(body),
        }),
      )
    const transactions = []
    for (let index = 0; index < concurrency * bursts; index++) {
      const proof = secret()
      const response = await post(transactionPath, {
        clientId: 'molis-auth-web-local',
        redirectUri: origin + '/account/callback',
        codeChallenge: secret(),
        codeChallengeMethod: 'S256',
        state: secret(),
        purpose: 'LOGIN',
        method: 'EMAIL_PASSWORD',
        initiatorChallenge: challenge(proof),
      })
      const result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result))
      transactions.push({ proof, id: result.data.transactionId, index })
    }
    const samples = []
    for (let offset = 0; offset < transactions.length; offset += concurrency) {
      const burst = transactions.slice(offset, offset + concurrency)
      samples.push(
        ...(await Promise.all(
          burst.map(async ({ proof, id, index }) => {
            const started = performance.now()
            try {
              const response = await post(
                `${transactionPath}/${id}/password`,
                { email: `kdf-${index}@example.test`, password },
                proof,
              )
              const result = await response.json()
              const httpStatus = response.status
              const httpCode = result.error?.code
              const calls = JSON.parse(response.headers.get('X-Fixture-Kdf-Calls')) ?? []
              // An unknown synthetic email uses the real dummy derivation, then returns 401.
              const ok =
                httpStatus === 401 &&
                httpCode === 'INVALID_CREDENTIALS' &&
                calls.length === 1 &&
                calls[0].entryMs >= 0 &&
                calls[0].entryMs !== null &&
                calls[0].kdfStatus === 200
              return {
                elapsedMs: performance.now() - started,
                ok,
                httpStatus,
                httpCode,
                ...calls[0],
              }
            } catch (error) {
              return { elapsedMs: performance.now() - started, ok: false, error: String(error) }
            }
          }),
        )),
      )
    }
    return samples
  } finally {
    await proxy.dispose()
  }
}

function quantiles(samples, field) {
  const numbers = samples
    .map((entry) => entry[field])
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  const percentile = (p) => Number(numbers[Math.ceil(numbers.length * p) - 1]?.toFixed(1))
  return { p50: percentile(0.5), p95: percentile(0.95) }
}

const results = { baseline: [], pooled: [] }
for (const [mode, build] of [
  ['baseline', baseline],
  ['pooled', pooled],
  ['pooled', pooled],
  ['baseline', baseline],
]) {
  results[mode].push(await sample(build))
}
for (const [mode, runs] of Object.entries(results)) {
  const samples = runs.flat()
  const failures = samples.filter((entry) => !entry.ok)
  const distinctObjectsPerRun = runs.map((run) => new Set(run.map((entry) => entry.id)).size)
  const names = [...new Set(samples.map((entry) => entry.name))].sort()
  let repeatedDestinationsInBursts = 0
  for (const run of runs) {
    for (let offset = 0; offset < run.length; offset += concurrency) {
      const burst = run.slice(offset, offset + concurrency).filter((entry) => entry.id)
      repeatedDestinationsInBursts += burst.length - new Set(burst.map((entry) => entry.id)).size
    }
  }
  console.log(
    JSON.stringify({
      mode,
      concurrency,
      bursts,
      runs: runs.length,
      requests: samples.length,
      errors: failures.length,
      distinctObjectsPerRun,
      repeatedDestinationsInBursts,
      names,
      requestMs: quantiles(samples, 'elapsedMs'),
      kdfRoundTripMs: quantiles(samples, 'roundTripMs'),
      kdfEntryMs: quantiles(samples, 'entryMs'),
    }),
  )
  assert.deepEqual(failures, [])
  if (mode === 'baseline') {
    assert.deepEqual(names, [null])
    assert.ok(distinctObjectsPerRun.every((count) => count === concurrency * bursts))
  } else {
    assert.ok(names.every((name) => /^password-kdf-pool-(?:[0-9]|1[0-5])$/.test(name)))
    assert.ok(distinctObjectsPerRun.every((count) => count <= 16))
  }
}
