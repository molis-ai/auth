import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../rust/src/', import.meta.url))
const domains = [
  'account',
  'app',
  'audit',
  'auth',
  'internal',
  'delivery',
  'platform',
  'tenants',
  'web',
]

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : [path]
  })
}

function refersToModule(content: string, modules: string[]): boolean {
  const directUse = new RegExp(`\\b(?:crate|super)\\s*::\\s*(?:${modules.join('|')})\\b`)
  if (directUse.test(content)) return true
  // Only the first path segment in each grouped import belongs to the crate
  // root. An identifier such as `core::http::billing` is a different path.
  for (const [, imports] of content.matchAll(/\b(?:crate|super)\s*::\s*\{([^;]+);/g)) {
    let depth = 0
    let atRoot = true
    for (const [token] of imports.matchAll(/\w+|[{},]/g)) {
      if (depth === 0 && atRoot && modules.includes(token)) return true
      if (token === '{') depth++
      else if (token === '}') depth--
      if (depth < 0) break
      atRoot = depth === 0 && token === ','
    }
  }
  return false
}

test('Rust source root contains only the Worker entry and router files', () => {
  const files = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  assert.deepEqual(files.sort(), ['app.rs', 'lib.rs'])
})

test('Auth backend source has no Billing modules', () => {
  const violations = sourceFiles(source)
    .map((file) => relative(source, file))
    .filter((file) => /billing/i.test(file))
  assert.deepEqual(violations, [])
})

test('Rust core does not reference the application or business domains', () => {
  const violations = sourceFiles(join(source, 'core'))
    .filter(
      (file) => extname(file) === '.rs' && refersToModule(readFileSync(file, 'utf8'), domains),
    )
    .map((file) => relative(source, file))
  assert.deepEqual(violations, [])
})

test('only the browser session loopback may call app from a domain', () => {
  const violations = sourceFiles(source)
    .filter((file) => extname(file) === '.rs')
    .map((file) => ({ path: relative(source, file), content: readFileSync(file, 'utf8') }))
    .filter(({ path, content }) => {
      const allowed =
        path === join('web', 'web_session.rs')
          ? content.replace('crate::app::handle_internal(', '')
          : content
      return refersToModule(allowed, ['app'])
    })
    .map(({ path }) => path)
  assert.deepEqual(violations, [])
})
