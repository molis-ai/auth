import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { rustEnvironment } from './rust-toolchain.mjs'

const cwd = fileURLToPath(new URL('../rust/', import.meta.url))
const env = rustEnvironment()
const action = process.argv[2] || 'check'
const commands = {
  check: ['check', '--locked', '--target', 'wasm32-unknown-unknown'],
  test: ['test', '--locked', '--lib'],
  format: ['fmt'],
  'format:check': ['fmt', '--check'],
}
if (!commands[action]) throw new Error('Unknown Rust action')
execFileSync('cargo', commands[action], { cwd, env, stdio: 'inherit' })
