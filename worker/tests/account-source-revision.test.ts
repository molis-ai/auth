import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, sourceRevision } from '../scripts/account-source-revision.mjs'

function fixture(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'account-source-revision-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'Synthetic review fixture')
  git(root, 'config', 'user.email', 'fixture@example.test')
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'docs'))
  const write = (path: string, value: string) => writeFileSync(join(root, path), value)
  const commit = () => {
    git(root, 'add', 'src', 'docs')
    git(root, 'commit', '-qm', 'synthetic fixture')
    return git(root, 'rev-parse', 'HEAD')
  }
  write('src/main.ts', 'export const value = 1\n')
  const base = commit()
  const read = (pin?: string) => sourceRevision(root, ['src'], /\.ts$/, pin)
  return { root, write, commit, base, read }
}

test('T01-01 AUTH12-01: committing delivery documents keeps the tested source base usable', (t) => {
  const { write, commit, base, read } = fixture(t)
  const initial = read()
  write('docs/delivery.md', 'recorded synthetic acceptance\n')
  write('src/README.md', 'source documentation\n')
  assert.deepEqual(read(base), initial)
  assert.notEqual(commit(), base)
  assert.deepEqual(read(base), initial)
  assert.equal(initial.uncommitted, false)
})

test('T01-02 AUTH12-01: modified, staged, added and deleted source remains uncommitted', (t) => {
  const { root, write, base, read } = fixture(t)
  write('src/main.ts', 'export const value = 2\n')
  assert.equal(read(base).uncommitted, true)
  git(root, 'add', 'src/main.ts')
  assert.equal(read(base).uncommitted, true)
  write('src/main.ts', 'export const value = 1\n')
  assert.equal(read(base).uncommitted, true)
  git(root, 'add', 'src/main.ts')
  assert.equal(read(base).uncommitted, false)
  write('src/added.ts', 'export const added = true\n')
  assert.equal(read(base).uncommitted, true)
  rmSync(join(root, 'src/added.ts'))
  rmSync(join(root, 'src/main.ts'))
  assert.equal(read(base).uncommitted, true)
})

test('T01-03 AUTH12-01: changed source commits require byte checking and unrelated pins are rejected', (t) => {
  const { root, write, commit, base, read } = fixture(t)
  write('src/main.ts', 'export const value = 2\n')
  const changed = commit()
  assert.deepEqual(read(base), { baseCommit: base, uncommitted: false })
  assert.equal(read().baseCommit, changed)
  git(root, 'checkout', '-q', '-b', 'divergent', base)
  write('src/main.ts', 'export const value = 3\n')
  commit()
  assert.throws(() => read(changed), /not an ancestor/)
  assert.throws(() => read('--invalid'), /full source base/)
})
