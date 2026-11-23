import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { rustEnvironment } from './rust-toolchain.mjs'

const cwd = fileURLToPath(new URL('../rust/', import.meta.url))
const env = rustEnvironment()
const action = process.argv[2] || 'check'
const commands = {
  check: ['check', '--locked', '--target', 'wasm32-unknown-unknown'],
  clippy: ['clippy', '--locked', '--lib', '--target', 'wasm32-unknown-unknown'],
  test: ['test', '--locked', '--lib'],
  format: ['fmt'],
  'format:check': ['fmt', '--check'],
}
if (!commands[action]) throw new Error('Unknown Rust action')
const featureConfigs = ['check', 'clippy', 'test'].includes(action)
  ? [[], ['--no-default-features']]
  : [[]]
const clippyArgs = action === 'clippy' ? ['--', '-D', 'warnings'] : []
for (const features of featureConfigs)
  execFileSync('cargo', [...commands[action], ...features, ...clippyArgs], {
    cwd,
    env,
    stdio: 'inherit',
  })
