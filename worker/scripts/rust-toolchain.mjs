import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'

export const toolchain = '1.96.0'
export const cargoBin = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'bin')
export const rustup = existsSync(join(cargoBin, 'rustup')) ? join(cargoBin, 'rustup') : 'rustup'
export function installedToolchain() {
  const manager = existsSync(join(cargoBin, 'rustup')) ? join(cargoBin, 'rustup') : rustup
  for (const name of [toolchain, 'stable']) {
    const located = spawnSync(manager, ['which', '--toolchain', name, 'rustc'], {
      encoding: 'utf8',
    })
    if (located.status !== 0) continue
    const version = spawnSync(located.stdout.trim(), ['--version'], { encoding: 'utf8' })
    if (version.status === 0 && version.stdout.startsWith(`rustc ${toolchain} `)) return name
  }
  return undefined
}
export function rustEnvironment() {
  const manager = existsSync(join(cargoBin, 'rustup')) ? join(cargoBin, 'rustup') : rustup
  const selected = installedToolchain()
  if (!selected) throw new Error(`Rust ${toolchain} is required. Run npm run setup first.`)
  const rustc = execFileSync(manager, ['which', '--toolchain', selected, 'rustc'], {
    encoding: 'utf8',
  }).trim()
  return {
    ...process.env,
    RUSTUP_TOOLCHAIN: selected,
    RUSTC: rustc,
    RUSTDOC: join(dirname(rustc), 'rustdoc'),
    PATH: [dirname(rustc), cargoBin, process.env.PATH].join(delimiter),
  }
}
