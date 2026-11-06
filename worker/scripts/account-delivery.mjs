// AUTH12-01/02: source provenance and evidence completeness, never a test-pass oracle.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, sourceRevision } from './account-source-revision.mjs'

const auth = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const [mode, work, club, ...extra] = process.argv.slice(2)
assert.ok(
  ['snapshot', 'check'].includes(mode) && work && club && !extra.length,
  'Usage: node worker/scripts/account-delivery.mjs snapshot|check /absolute/work /absolute/club',
)
assert.ok(isAbsolute(work) && isAbsolute(club), 'Explicit absolute source checkouts required')
const roots = { A: auth, W: work, C: club }
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const manifest = join(auth, 'docs/unified-account/delivery-manifest.json')
const recorded = mode === 'check' ? json(manifest) : null
const matrix = readFileSync(join(auth, 'docs/unified-account/acceptance-matrix.md'), 'utf8')
const uas = [...matrix.matchAll(/^\| (UAS-\d{2}) \|/gm)].map((m) => m[1])
const required = [
  ...readFileSync(join(auth, 'docs/unified-account/requirements.md'), 'utf8').matchAll(
    /^\| (UAS-\d{2}) \|/gm,
  ),
].map((m) => m[1])
assert.deepEqual(uas, required, 'The matrix must match the current requirements')
assert.deepEqual(
  uas,
  Array.from({ length: 42 }, (_, i) => `UAS-${String(i + 1).padStart(2, '0')}`),
  '42 unique ordered UAS rows required',
)
const evidenceIds = [...matrix.matchAll(/^\| (E-[A-Z]\d+) \|/gm)].map((m) => m[1])
assert.equal(new Set(evidenceIds).size, evidenceIds.length, 'Evidence IDs must be unique')
for (const row of matrix.split('\n').filter((line) => /^\| UAS-/.test(line))) {
  const refs = row.match(/E-[A-Z]\d+/g) ?? []
  assert.ok(
    refs.length && refs.every((id) => evidenceIds.includes(id)),
    'Missing evidence reference: ' + row.split('|')[1],
  )
}
const evidencePaths = [...matrix.matchAll(/`([AWC]):([^`]+)`/g)].map(([, repo, path]) => {
  assert.ok(
    !path.includes('..') && !isAbsolute(path),
    'Repository-relative evidence paths required',
  )
  assert.ok(existsSync(join(roots[repo], path)), 'Missing evidence: ' + repo + ':' + path)
  return `${repo}:${path}`
})
const scopes = {
  A: [
    'contracts',
    'worker/rust/src',
    'worker/rust/Cargo.toml',
    'worker/rust/Cargo.lock',
    'worker/scripts',
    'worker/tests',
    'worker/rust-tests',
    'worker/migrations',
    'worker/package.json',
    'worker/package-lock.json',
    'worker/unified-account-local-seed.sql',
    'worker/mock-provider-local-seed.sql',
    'web/src',
    'web/tests',
    'web/package.json',
    'web/package-lock.json',
    'sdk/browser/src',
    'sdk/browser/tests',
    'sdk/browser/package.json',
    'sdk/browser/package-lock.json',
    'package.json',
  ],
  W: [
    'apps',
    'horizontal',
    'modules',
    'packages',
    'plugins',
    'server',
    'scripts',
    'tests',
    'examples',
    'tooling',
    'vendor',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
  ],
  C: [
    'app',
    'content',
    'db',
    'drizzle',
    'lib',
    'scripts',
    'tests',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vite.config.ts',
    'next.config.ts',
    '.oxlintrc.json',
    '.oxfmtrc.json',
  ],
}
// Only source/build inputs; no .env/.dev.vars, runtime databases, Home, images or generated output.
const extension =
  /\.(?:[cm]?[jt]sx?|jsonc?|sql|toml|lock|ya?ml|rs|py|sh|swift|css|grit|txt|tsv|tgz|sha256)$/
function sourceSnapshot(repo, root) {
  assert.ok(existsSync(join(root, 'package.json')), 'Missing repository package.json')
  const names = [
    ...new Set(
      git(
        root,
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        ...scopes[repo],
      )
        .split('\0')
        .filter((path) => path && extension.test(path)),
    ),
  ].sort()
  const entries = names.map((path) => {
    const file = join(root, path)
    if (!existsSync(file)) return [path, 'DELETED', null]
    const stat = lstatSync(file)
    assert.ok(stat.isFile() || stat.isSymbolicLink(), 'Unsupported source entry: ' + path)
    return [
      path,
      stat.isSymbolicLink() ? 'SYMLINK' : 'FILE',
      digest(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file)),
    ]
  })
  return {
    ...sourceRevision(root, scopes[repo], extension, recorded?.repositories[repo].baseCommit),
    branch: git(root, 'branch', '--show-current'),
    packageVersion: json(join(root, 'package.json')).version ?? null,
    sourceScope: scopes[repo],
    fileCount: entries.length,
    sourceSha256: digest(JSON.stringify(entries)),
  }
}
const snapshots = Object.fromEntries(
  Object.entries(roots).map(([id, root]) => [id, sourceSnapshot(id, root)]),
)
const files = [
  'schemas.json',
  'openapi.json',
  'policy.json',
  'validator-profile.json',
  'validate.ts',
  'fixtures.json',
]
const hashes = Object.fromEntries(
  files.map((file) => {
    const expected = digest(readFileSync(join(auth, 'contracts/unified-account', file)))
    for (const [root, path] of [
      [work, 'horizontal/account/src/upstream'],
      [club, 'lib/account/contracts'],
    ])
      assert.equal(
        digest(readFileSync(join(root, path, file))),
        expected,
        'Contract drift: ' + file,
      )
    assert.equal(
      json(join(work, 'horizontal/account/src/upstream/provenance.json')).sha256[file],
      expected,
    )
    assert.equal(json(join(club, 'lib/account/contracts/snapshot.json')).files[file], expected)
    return [file, expected]
  }),
)
const migrationSnapshot = (root, path) =>
  Object.fromEntries(
    git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', path)
      .split('\0')
      .filter((p) => p.endsWith('.sql'))
      .sort()
      .map((p) => [p, digest(readFileSync(join(root, p)))]),
  )
const state = {
  formatVersion: 1,
  purpose: 'LOCAL_SYNTHETIC_ACCEPTANCE_NOT_RELEASE',
  scopeNote:
    'SHA-256 of sorted [path, kind, byte-sha256] JSON in declared source scopes; excludes docs, ignored builds, runtime configuration/data and most media. Not a complete deployment image. Symlinks hash link text only. baseCommit pins an ancestor with the recorded source; uncommitted covers source inputs only. Later documentation commits do not invalidate this record.',
  repositories: snapshots,
  contractVersion: json(join(auth, 'contracts/unified-account/policy.json')).contractVersion,
  contractFiles: hashes,
  migrations: {
    A: migrationSnapshot(auth, 'worker/migrations'),
    C: migrationSnapshot(club, 'drizzle'),
  },
  evidence: {
    requirementCount: uas.length,
    pathCount: evidencePaths.length,
    matrixSha256: digest(matrix),
  },
}
if (mode === 'snapshot') {
  writeFileSync(
    manifest,
    JSON.stringify({ recordedAt: new Date().toISOString(), ...state }, null, 2) + '\n',
  )
} else {
  const { recordedAt, ...expected } = recorded
  assert.ok(Number.isFinite(Date.parse(recordedAt)))
  assert.deepEqual(state, expected, 'Delivery record is stale; review changes and rerun snapshot')
}
console.log(
  `PASS AUTH12-01/02: ${uas.length} UAS rows, ${evidenceIds.length} evidence groups, three matching contract copies and ${mode === 'check' ? 'unchanged' : 'recorded'} source fingerprints. Tests are recorded separately.`,
)
