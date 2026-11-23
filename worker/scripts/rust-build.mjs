import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { rustEnvironment } from './rust-toolchain.mjs'

const cwd = fileURLToPath(new URL('../rust/', import.meta.url))
const binary = join(
  cwd,
  '.tools',
  'bin',
  process.platform === 'win32' ? 'worker-build.exe' : 'worker-build',
)
if (!existsSync(binary))
  throw new Error('Run npm run setup first to install the pinned Rust toolchain and worker-build')
const { values } = parseArgs({
  options: {
    'no-mock-provider': { type: 'boolean' },
    'out-dir': { type: 'string' },
  },
})
const args = ['--release', '--no-opt']
const outDir = values['out-dir']
if (outDir !== undefined) {
  if (!outDir) throw new Error('--out-dir requires a directory path')
  args.push('--out-dir', resolve(outDir))
}
args.push('.', '--locked')
if (values['no-mock-provider']) args.push('--no-default-features')
execFileSync(binary, args, {
  cwd,
  stdio: 'inherit',
  env: rustEnvironment(),
})
