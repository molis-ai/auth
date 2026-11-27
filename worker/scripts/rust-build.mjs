import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
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
    production: { type: 'boolean' },
    'out-dir': { type: 'string' },
  },
})
const optimizer = fileURLToPath(new URL('../node_modules/binaryen/bin/wasm-opt', import.meta.url))
if (values.production && !existsSync(optimizer))
  throw new Error('Run npm run setup first to install the pinned production WASM optimizer')
const args = ['--release', '--no-opt']
const outDir = values['out-dir']
const output = outDir === undefined ? join(cwd, 'build') : resolve(outDir)
if (outDir !== undefined) {
  if (!outDir) throw new Error('--out-dir requires a directory path')
  args.push('--out-dir', output)
}
args.push('.', '--locked')
if (values.production) args.push('--no-default-features')
else args.push('--features', 'mock-provider,mock-delivery')
execFileSync(binary, args, {
  cwd,
  stdio: 'inherit',
  env: rustEnvironment(),
})

if (values.production) {
  // Optimize after wasm-bindgen and enable the features used by its generated module.
  const wasm = join(output, 'index_bg.wasm')
  const staging = mkdtempSync(join(output, '.wasm-opt-'))
  const optimized = join(staging, 'index_bg.wasm')
  try {
    execFileSync(
      process.execPath,
      [
        optimizer,
        '-Os',
        '--enable-reference-types',
        '--enable-multivalue',
        '--enable-bulk-memory',
        '--enable-mutable-globals',
        '--enable-sign-ext',
        '--enable-nontrapping-float-to-int',
        '--enable-exception-handling',
        wasm,
        '-o',
        optimized,
      ],
      { cwd, stdio: 'inherit' },
    )
    renameSync(optimized, wasm)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
