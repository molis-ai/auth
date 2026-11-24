// One-time cutover for databases that already applied the historical Auth migrations.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import targets from '../../config/platform-targets.json' with { type: 'json' }
import { cleanWranglerEnv } from './environment.mjs'

const baseline = '0020_auth_baseline.sql'
const history = new URL('../migration-history/through-0020/', import.meta.url)
const catalog = `SELECT name, sql FROM sqlite_schema
  WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
    AND name <> 'd1_migrations' ORDER BY name`
const snapshot = `SELECT
  (SELECT json_group_array(json_array(name,sql)) FROM (${catalog})) AS objects,
  (SELECT json_group_array(name) FROM (SELECT name FROM d1_migrations ORDER BY name)) AS ledger`

// Compare the SQL tokens so comments/formatting introduced by a migration runner
// do not matter. Keep quoted values intact, including whitespace in string literals.
function tokens(sql) {
  const parts = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|[\w]+|[^\s]/g)
  return JSON.stringify(parts.filter((part) => !part.startsWith('--') && !part.startsWith('/*')))
}

function checkCatalog(objects) {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readFileSync(new URL('../migrations/' + baseline, import.meta.url), 'utf8'))
    const actual = new Map(JSON.parse(objects))
    for (const { name, sql } of db.prepare(catalog).all()) {
      if (!actual.has(name) || tokens(actual.get(name)) !== tokens(sql))
        throw new Error('Missing or different Auth schema object: ' + name)
      actual.delete(name)
    }
    if (actual.size) throw new Error('Unexpected schema object: ' + actual.keys().next().value)
  } finally {
    db.close()
  }
}

const literal = (value) => "'" + value.replaceAll("'", "''") + "'"

export function adoptBaseline(execute, apply = false) {
  const [before] = execute(snapshot)
  const applied = JSON.parse(before.ledger)
  if (applied.includes(baseline)) return 'Baseline already recorded'
  const expected = readdirSync(history)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  const missing = expected.filter((name) => !applied.includes(name))
  if (missing.length) throw new Error('Unapplied historical migrations: ' + missing.join(', '))
  if (expected.length !== applied.length) throw new Error('Unexpected migration history')
  checkCatalog(before.objects)
  if (!apply) return 'Historical ledger and schema match; ready for registration'

  // Compare the exact observed catalog and ledger again in the INSERT statement.
  // A concurrent DDL or migration change leaves the ledger untouched.
  const result = execute(`INSERT INTO d1_migrations(name) SELECT ${literal(baseline)}
    FROM (${snapshot}) WHERE objects=${literal(before.objects)} AND ledger=${literal(before.ledger)}
    RETURNING name`)
  if (result[0]?.name === baseline) return 'Baseline registered'
  if (JSON.parse(execute(snapshot)[0].ledger).includes(baseline)) return 'Baseline already recorded'
  throw new Error('Schema or migration history changed during registration; check again')
}

function main(args) {
  const [flag, env, ...options] = args
  if (
    flag !== '--env' ||
    !['dev', 'test', 'prod'].includes(env) ||
    (options.length && (options.length !== 1 || options[0] !== '--apply'))
  )
    throw new Error('Usage: db:baseline -- --env dev|test|prod [--apply]')
  const local = env === 'dev'
  const target = targets[env]
  const worker = fileURLToPath(new URL('../', import.meta.url))
  const staging = mkdtempSync(join(tmpdir(), 'auth-baseline-'))
  try {
    const config = local ? join(worker, 'wrangler.fixture.jsonc') : join(staging, 'wrangler.json')
    if (!local)
      writeFileSync(
        config,
        JSON.stringify({
          name: target.workerName,
          account_id: targets.platformAccountId,
          d1_databases: [
            { binding: 'DB', database_id: target.databaseId, database_name: target.databaseName },
          ],
        }),
      )
    const cliEnv = cleanWranglerEnv()
    const execute = (sql) => {
      const raw = execFileSync(
        process.execPath,
        [
          join(worker, 'node_modules/wrangler/bin/wrangler.js'),
          'd1',
          'execute',
          target.databaseName,
          local ? '--local' : '--remote',
          '--config',
          config,
          '--json',
          '--command',
          sql,
        ],
        { cwd: worker, env: cliEnv, encoding: 'utf8' },
      )
      const [statement] = JSON.parse(raw)
      if (!statement?.success || !Array.isArray(statement.results))
        throw new Error('D1 query failed')
      return statement.results
    }
    console.log(target.databaseName + ': ' + adoptBaseline(execute, options.includes('--apply')))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2))
