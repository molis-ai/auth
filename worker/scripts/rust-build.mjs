import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
execFileSync(binary, ['--release', '--locked', '--no-opt'], {
  cwd,
  stdio: 'inherit',
  env: rustEnvironment(),
})
