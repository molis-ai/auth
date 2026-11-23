import { readdirSync, readFileSync } from 'node:fs'

const schemaProbes = readFileSync(
  new URL('../rust/src/schema-readiness.sql', import.meta.url),
  'utf8',
)
const notReady = 'Auth deployment D1 schema or browser client registration is not ready'

export function verifyDeploymentDatabase(execute, vars, migrationsDir) {
  const expected = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort()
  if (expected.length === 0) throw new Error('No Auth D1 migration files found')

  const { environmentId, authOrigin, kind } = JSON.parse(vars.UNIFIED_ACCOUNT_CONFIG)
  const literal = (value) => "'" + value.replaceAll("'", "''") + "'"
  const sql = `SELECT name FROM d1_migrations;
    SELECT EXISTS (
      SELECT 1 FROM auth_environment e JOIN auth_client_policy p ON p.environment_id=e.id
      JOIN auth_client c ON c.client_id=p.client_id
      JOIN auth_application app ON app.id=c.application_id
      WHERE e.id=${literal(environmentId)} AND e.auth_origin=${literal(authOrigin)}
      AND e.kind=${literal(kind)} AND e.status='ACTIVE' AND c.status='ACTIVE'
      AND c.client_id=${literal(vars.AUTH_WEB_CLIENT_ID)}
      AND app.status='ACTIVE' AND p.policy_profile='unified-account-v2'
      AND EXISTS (SELECT 1 FROM json_each(p.allowed_origins) WHERE value=${literal(authOrigin)})
      AND EXISTS (SELECT 1 FROM json_each(c.redirects) WHERE value=${literal(authOrigin + '/account/callback')})
      AND e.delivery_mode='LIVE' AND e.provider_mode='LIVE'
    ) AS ready;
    ${schemaProbes}`
  let result
  try {
    result = JSON.parse(execute(sql))
  } catch {
    throw new Error(notReady)
  }
  const probeCount = sql.split(';').filter((statement) => statement.trim()).length
  if (
    !Array.isArray(result) ||
    result.length !== probeCount ||
    result.some((statement) => statement?.success !== true || !Array.isArray(statement.results))
  ) {
    throw new Error(notReady)
  }
  const applied = new Set(result[0].results.map((row) => row?.name))
  const missing = expected.filter((name) => !applied.has(name))
  if (missing.length > 0) throw new Error('Unapplied Auth D1 migrations: ' + missing.join(', '))
  if (result[1].results[0]?.ready !== 1) throw new Error(notReady)
}
