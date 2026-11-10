import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
if (process.argv.length > 2)
  throw Error('Dev takes no environment overrides; test/prod use the deployment configurations')
await new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', () =>
    reject(Error('Auth dev port 8787 is occupied; stop its owner first. No process was killed.')),
  )
  server.listen(8787, '127.0.0.1', () => server.close(resolve))
})
async function run(command, args, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    const stop = (signal) => child.kill(signal)
    const term = () => stop('SIGTERM'),
      interrupt = () => stop('SIGINT')
    process.on('SIGTERM', term)
    process.on('SIGINT', interrupt)
    child.on('error', reject)
    child.on('exit', (code) => {
      process.off('SIGTERM', term)
      process.off('SIGINT', interrupt)
      code === 0 ? resolve() : reject(Error(command + ' exited: ' + code))
    })
  })
}
await run(process.execPath, ['worker/scripts/prepare-local.mjs'])
await run('npm', ['run', 'build:web'])
await run('npm', ['--prefix', 'worker', 'run', 'build:rust'])
await run('npm', ['--prefix', 'worker', 'run', 'db:migrate'])
await run('npm', ['--prefix', 'worker', 'run', 'db:seed'])
await run(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'd1',
    'execute',
    'auth-local',
    '--local',
    '--file',
    'unified-account-local-seed.sql',
  ],
  root + 'worker',
)
await run(process.execPath, ['worker/scripts/dev-account.mjs'])
console.log(
  'DEV: http://127.0.0.1:8787 — local mock services; preview@example.test / Molis-dev-2026! (initial password only)',
)
await run('npm', ['--prefix', 'worker', 'run', 'dev'])
