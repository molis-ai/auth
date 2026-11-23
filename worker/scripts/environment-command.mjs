import { createHmac } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPortAvailable, selectEnvironment } from '../../scripts/environment-properties.mjs'
import { sessionGeneration } from '../../scripts/environment-session.mjs'
import { authEnvironment, port, root } from './environment.mjs'
import { verifyDeploymentDatabase } from './deployment-readiness.mjs'

const [operation, ...args] = process.argv.slice(2)
if (!['start', 'deploy'].includes(operation)) throw new Error('Choose start or deploy')
const local = operation === 'start'
const name = selectEnvironment(args, operation, local ? [] : ['--dry-run'])
const settings = authEnvironment(name, local)
if (local) await assertPortAvailable(port)
const staging = mkdtempSync(join(tmpdir(), 'molis-auth-'))
const config = join(staging, 'wrangler.json')
const secretFile = join(staging, local ? '.dev.vars' : 'bindings.json')
const wranglerEnv = {
  ...process.env,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
  WRANGLER_LOG_SANITIZE: 'true',
}
const wranglerOverrides = [
  'CLOUDFLARE_ENV',
  'CLOUDFLARE_ACCOUNT_ID',
  'CF_ACCOUNT_ID',
  'CLOUDFLARE_COMPLIANCE_REGION',
  'CLOUDFLARE_API_BASE_URL',
  'CF_API_BASE_URL',
  'WRANGLER_API_ENVIRONMENT',
  'WRANGLER_CI_OVERRIDE_NAME',
  'WRANGLER_CI_GENERATE_PREVIEW_ALIAS',
]
for (const key of wranglerOverrides) delete wranglerEnv[key]
const cwd = fileURLToPath(root)
function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, env: wranglerEnv, stdio: 'inherit' })
    const stop = () => child.kill('SIGTERM')
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${signal ?? code}`))
    })
  })
}
try {
  await run('npm', ['run', 'build:web'])
  await run('npm', ['--prefix', 'worker', 'run', local ? 'build:rust' : 'build:rust:production'])
  const db = settings.platform.d1_databases[0]
  console.log(
    `Auth ${name}: ${settings.platform.vars.AUTH_ORIGIN}; D1 ${local && name === 'dev' ? 'local' : 'remote'} ${db.database_name} (${db.database_id})`,
  )
  if (local) {
    const generation = sessionGeneration('auth', name)
    settings.platform.vars.MOLIS_LOCAL_GENERATION = generation
    const bindings = { ...settings.bindings }
    for (const key of ['AUTH_WEB_SESSION_KEY', 'PROVIDER_STATE_KEY'])
      bindings[key] = createHmac('sha256', bindings[key]).update(generation).digest('base64url')
    writeFileSync(config, JSON.stringify(settings.platform), { mode: 0o600 })
    writeFileSync(
      secretFile,
      Object.entries(bindings)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`)
        .join(''),
      { mode: 0o600 },
    )
    for (const key of wranglerOverrides) delete process.env[key]
    Object.assign(process.env, wranglerEnv)
    const { startAuthWorker } = await import('./dev-server.mjs')
    await startAuthWorker(config, name, settings)
  } else {
    writeFileSync(config, JSON.stringify(settings.platform), { mode: 0o600 })
    const deploy = ['worker/node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', config]
    if (args.includes('--dry-run')) deploy.push('--dry-run')
    else {
      const {
        d1_databases: [database],
        vars,
      } = settings.platform
      verifyDeploymentDatabase(
        (sql) =>
          execFileSync(
            process.execPath,
            [
              'worker/node_modules/wrangler/bin/wrangler.js',
              'd1',
              'execute',
              database.database_id,
              '--remote',
              '--config',
              config,
              '--command',
              sql,
              '--json',
            ],
            { cwd, env: wranglerEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          ),
        vars,
        database.migrations_dir,
      )
      writeFileSync(secretFile, JSON.stringify(settings.bindings), { mode: 0o600 })
      deploy.push('--secrets-file', secretFile)
    }
    await run(process.execPath, deploy)
  }
} finally {
  rmSync(staging, { force: true, recursive: true })
}
