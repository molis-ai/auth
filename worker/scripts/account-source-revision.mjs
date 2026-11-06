import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

export const git = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()

// The recorded source base must remain an ancestor. Later documentation commits
// do not invalidate it; the delivery checker separately compares all source bytes.
export function sourceRevision(root, scopes, extension, recordedBase) {
  const head = git(root, 'rev-parse', 'HEAD')
  const baseCommit = recordedBase ?? head
  assert.match(baseCommit, /^[a-f0-9]{40}$/, 'A full source base commit is required')
  assert.equal(
    git(root, 'merge-base', baseCommit, head),
    baseCommit,
    'Recorded source base is not an ancestor; review and refresh the delivery record',
  )
  const changed = [
    ...git(root, 'diff', '--name-only', '-z', 'HEAD', '--', ...scopes).split('\0'),
    ...git(root, 'diff', '--cached', '--name-only', '-z', 'HEAD', '--', ...scopes).split('\0'),
    ...git(root, 'ls-files', '-z', '--others', '--exclude-standard', '--', ...scopes).split('\0'),
  ]
  return { baseCommit, uncommitted: changed.some((file) => file && extension.test(file)) }
}
