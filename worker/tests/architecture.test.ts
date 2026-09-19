import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../src/', import.meta.url))
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })
}
test('module boundaries: infrastructure cannot import business, modules cannot import HTTP composition', () => {
  for (const file of files(root)) {
    const name = relative(root, file)
    const source = readFileSync(file, 'utf8')
    for (const [, specifier] of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = relative(root, resolve(dirname(file), specifier))
      assert.ok(!target.startsWith('..'), `${name} imports outside backend: ${target}`)
      if (/^(infrastructure|shared|security)\//.test(name)) {
        assert.ok(
          !/^(modules|http)\//.test(target) && !['app.ts', 'index.ts'].includes(target),
          `${name} reverses dependency: ${target}`,
        )
      }
      if (name.startsWith('modules/')) {
        assert.ok(
          !target.startsWith('http/') && !['app.ts', 'index.ts'].includes(target),
          `${name} imports composition: ${target}`,
        )
      }
      if (/^modules\/(account|platform)\//.test(name)) {
        assert.ok(
          !target.startsWith('modules/teams/'),
          `${name} must use shared pagination, not team internals`,
        )
      }
    }
  }
})
