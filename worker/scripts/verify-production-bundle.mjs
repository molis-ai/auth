import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { compatibilityDate } from './environment.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixtureWasm = join(root, 'worker/rust/build/index_bg.wasm')
const contract = readFileSync(join(root, 'contracts/unified-account/openapi.json'))
const mockPage = 'Molis 提供方模拟授权'
const mockDeliveryStatements = [
  'INSERT INTO auth_mock_delivery',
  'INSERT INTO auth_mock_notification',
]

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function report(label, bytes) {
  const hash = sha256(bytes)
  const gzip = gzipSync(bytes, { level: 9 }).length
  console.log(`${label} WASM: ${bytes.length} bytes raw, ${gzip} bytes gzip-9, SHA-256 ${hash}`)
  return hash
}

const fixture = readFileSync(fixtureWasm)
assert(fixture.includes(mockPage), 'Default WASM is missing the mock provider page')
for (const statement of mockDeliveryStatements)
  assert(fixture.includes(statement), `Default WASM is missing ${statement}`)
assert(!fixture.includes(contract), 'Default WASM embeds the entire OpenAPI document')
const fixtureHash = report('Default', fixture)

const staging = mkdtempSync(join(tmpdir(), 'molis-auth-production-'))
try {
  const build = join(staging, 'rust-build')
  const productionWasm = join(build, 'index_bg.wasm')
  execFileSync(
    'npm',
    ['--prefix', 'worker', 'run', 'build:rust:production', '--', '--out-dir', build],
    {
      cwd: root,
      stdio: 'inherit',
    },
  )
  const production = readFileSync(productionWasm)
  const mod = new WebAssembly.Module(production)
  assert(
    WebAssembly.Module.exports(mod).some(
      (entry) => entry.name === 'fetch' && entry.kind === 'function',
    ),
    'Production WASM must export a fetch function',
  )
  assert(!production.includes(mockPage), 'Production WASM includes the mock provider page')
  assert(!production.includes('/api/v2/auth/mock/'), 'Production WASM includes the mock API path')
  for (const statement of mockDeliveryStatements)
    assert(!production.includes(statement), `Production WASM includes ${statement}`)
  assert(!production.includes(contract), 'Production WASM embeds the entire OpenAPI document')
  const productionHash = report('Production', production)
  execFileSync(process.execPath, ['--test', 'worker/tests/test-admission.test.ts'], {
    cwd: root,
    env: { ...process.env, AUTH_PRODUCTION_WASM_BUILD_DIR: build },
    stdio: 'inherit',
  })

  const config = join(staging, 'wrangler.json')
  const outdir = join(staging, 'bundle')
  // Use the verified production files directly, without a custom build command.
  writeFileSync(
    config,
    JSON.stringify({
      name: 'molis-auth-production-dry-run',
      main: join(build, 'index.js'),
      compatibility_date: compatibilityDate,
      workers_dev: false,
      preview_urls: false,
      assets: {
        directory: join(root, 'web/dist'),
        binding: 'ASSETS',
        run_worker_first: true,
        html_handling: 'none',
        not_found_handling: 'none',
      },
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'auth-production-dry-run',
          database_id: '00000000-0000-0000-0000-000000000000',
          migrations_dir: join(root, 'worker/migrations'),
        },
      ],
      durable_objects: { bindings: [{ name: 'PASSWORD_KDF', class_name: 'PasswordKdf' }] },
      migrations: [{ tag: 'password-kdf-v1', new_sqlite_classes: ['PasswordKdf'] }],
    }),
  )

  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(CLOUDFLARE|CF|WRANGLER)_/i.test(key)) delete env[key]
  }
  Object.assign(env, {
    CI: 'true',
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_HIDE_BANNER: 'true',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    WRANGLER_NO_SKILLS_UPDATE_PROMPTS: 'true',
    XDG_CONFIG_HOME: staging,
  })
  execFileSync(
    process.execPath,
    [
      join(root, 'worker/node_modules/wrangler/bin/wrangler.js'),
      'deploy',
      '--dry-run',
      '--config',
      config,
      '--outdir',
      outdir,
    ],
    { cwd: staging, env, stdio: 'inherit' },
  )
  const outputs = readdirSync(outdir, { recursive: true, withFileTypes: true }).filter(
    (file) => file.isFile() && file.name.endsWith('.wasm'),
  )
  assert.equal(outputs.length, 1, 'Expected exactly one WASM module in the Wrangler bundle')
  const [output] = outputs
  const bundledHash = sha256(readFileSync(join(output.parentPath, output.name)))
  assert.equal(bundledHash, productionHash, 'Wrangler bundled a different WASM module')
  assert.equal(
    sha256(readFileSync(productionWasm)),
    productionHash,
    'Wrangler overwrote the production WASM',
  )
  assert.equal(sha256(readFileSync(fixtureWasm)), fixtureHash, 'Default WASM was overwritten')
  console.log(`Wrangler bundle and production WASM SHA-256 match: ${bundledHash}`)
  console.log(`Default WASM SHA-256 unchanged: ${fixtureHash}`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
