import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
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

const manifest = readFileSync(new URL('../rust/Cargo.toml', import.meta.url), 'utf8')
const workerVersion = manifest.match(
  /^\s*worker\s*=\s*\{[^}\r\n]*?\bversion\s*=\s*"=([^"\s]+)"/m,
)?.[1]
if (!workerVersion) throw new Error('worker/rust/Cargo.toml must pin an exact worker version')

// Workers Builds does not guarantee Rust is preinstalled. Bootstrap from rustup's
// official installer only when missing; do not change the user's default toolchain.
if (spawnSync(rustup, ['--version'], { stdio: 'ignore' }).status !== 0) {
  if (process.platform === 'win32')
    throw new Error('Install rustup from https://rustup.rs and rerun npm run setup')
  const installerDir = mkdtempSync(join(tmpdir(), 'molis-auth-rust-'))
  try {
    const installer = join(installerDir, 'rustup-init.sh')
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
  } finally {
    rmSync(installerDir, { recursive: true, force: true })
  }
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
const workerBuild = process.platform === 'win32' ? 'worker-build.exe' : 'worker-build'
const binary = join(root, 'bin', workerBuild)
function matchesWorkerVersion(path) {
  const version = spawnSync(path, ['--version'], { encoding: 'utf8' })
  return version.status === 0 && version.stdout.trim() === workerVersion
}

if (!matchesWorkerVersion(binary)) {
  const global = join(cargoBin, workerBuild)
  if (matchesWorkerVersion(global)) {
    const binDir = dirname(binary)
    mkdirSync(binDir, { recursive: true })
    const staging = mkdtempSync(join(binDir, 'worker-build-'))
    try {
      const stagedBinary = join(staging, workerBuild)
      copyFileSync(global, stagedBinary)
      renameSync(stagedBinary, binary)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  } else {
    const args = [
      'install',
      'worker-build',
      '--version',
      `=${workerVersion}`,
      '--locked',
      '--root',
      root,
    ]
    if (existsSync(binary)) args.push('--force')
    execFileSync('cargo', args, { stdio: 'inherit', env: rustEnvironment() })
  }
}
