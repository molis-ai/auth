import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cargoBin,
  rustup,
  toolchain,
  installedToolchain,
  rustEnvironment,
} from './rust-toolchain.mjs'

// Workers Builds does not guarantee Rust is preinstalled. Bootstrap from rustup's
// official installer only when missing; do not change the user's default toolchain.
if (spawnSync(rustup, ['--version'], { stdio: 'ignore' }).status !== 0) {
  if (process.platform === 'win32')
    throw new Error('Install rustup from https://rustup.rs and rerun npm run setup')
  const installer = join(mkdtempSync(join(tmpdir(), 'molis-auth-rust-')), 'rustup-init.sh')
  execFileSync(
    'curl',
    ['--proto', '=https', '--tlsv1.2', '-fsSL', 'https://sh.rustup.rs', '-o', installer],
    { stdio: 'inherit' },
  )
  execFileSync(
    'sh',
    [installer, '-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', 'none'],
    { stdio: 'inherit' },
  )
}
const manager = existsSync(join(cargoBin, 'rustup')) ? join(cargoBin, 'rustup') : rustup
const selected = installedToolchain()
if (!selected) {
  execFileSync(
    manager,
    [
      'toolchain',
      'install',
      toolchain,
      '--profile',
      'minimal',
      '--component',
      'rustfmt',
      '--target',
      'wasm32-unknown-unknown',
    ],
    { stdio: 'inherit' },
  )
} else {
  execFileSync(manager, ['target', 'add', '--toolchain', selected, 'wasm32-unknown-unknown'], {
    stdio: 'inherit',
  })
  execFileSync(manager, ['component', 'add', '--toolchain', selected, 'rustfmt'], {
    stdio: 'inherit',
  })
}
// A project-specific install root avoids replacing another project's worker-build.
const root = fileURLToPath(new URL('../rust/.tools/', import.meta.url))
const binary = join(root, 'bin', process.platform === 'win32' ? 'worker-build.exe' : 'worker-build')
if (!existsSync(binary)) {
  const global = join(cargoBin, process.platform === 'win32' ? 'worker-build.exe' : 'worker-build')
  const version = spawnSync(global, ['--version'], { encoding: 'utf8' })
  if (version.status === 0 && version.stdout.trim() === '0.8.6') {
    mkdirSync(dirname(binary), { recursive: true })
    copyFileSync(global, binary)
  } else {
    execFileSync(
      'cargo',
      ['install', 'worker-build', '--version', '0.8.6', '--locked', '--root', root],
      { stdio: 'inherit', env: rustEnvironment() },
    )
  }
}
