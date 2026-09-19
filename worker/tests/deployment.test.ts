import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { validateDeployment, deploymentArgs } from '../scripts/deployment.ts'
const load = (env: string) =>
  JSON.parse(readFileSync(new URL('../deploy/' + env + '/wrangler.json', import.meta.url), 'utf8'))
const seed = (env: string) =>
  readFileSync(new URL('../deploy/' + env + '/seed.sql', import.meta.url), 'utf8')
test('cloud seeds are repeatable and create no users or credentials', () => {
  for (const env of ['preview', 'production']) {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('PRAGMA foreign_keys=ON')
      const directory = new URL('../migrations/', import.meta.url)
      for (const name of readdirSync(directory)
        .filter((name) => name.endsWith('.sql'))
        .sort()) {
        db.exec(readFileSync(new URL(name, directory), 'utf8'))
      }
      db.exec(seed(env))
      db.exec(seed(env))
      assert.equal(db.prepare('SELECT count(*) AS n FROM auth_client').get()!.n, 1)
      assert.equal(db.prepare('SELECT count(*) AS n FROM auth_user').get()!.n, 0)
      assert.equal(db.prepare('SELECT count(*) AS n FROM auth_local_credential').get()!.n, 0)
      assert.equal(
        db.prepare('SELECT redirects FROM auth_client').get()!.redirects,
        JSON.stringify([load(env).vars.AUTH_ORIGIN + '/console/callback']),
      )
    } finally {
      db.close()
    }
  }
})
test('deployment templates are isolated and valid for offline packaging', () => {
  for (const env of ['preview', 'production']) {
    const other = load(env === 'preview' ? 'production' : 'preview')
    validateDeployment(load(env), other, seed(env), env, true)
    const configured = load(env)
    configured.d1_databases[0].database_id = '11111111-1111-4111-8111-111111111111'
    validateDeployment(configured, other, seed(env), env)
    const unconfigured = load(env)
    unconfigured.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000'
    assert.throws(() => validateDeployment(unconfigured, other, seed(env), env), /真实 database_id/)
    other.d1_databases[0].database_id = configured.d1_databases[0].database_id
    assert.throws(() => validateDeployment(configured, other, seed(env), env), /共用 D1/)
  }
})
test('deployment rejects local origin, wrong callback and local administrator', () => {
  const config = load('preview'),
    other = load('production')
  config.vars.AUTH_ORIGIN = 'http://127.0.0.1:8787'
  assert.throws(
    () => validateDeployment(config, other, seed('preview'), 'preview', true),
    /AUTH_ORIGIN/,
  )
  config.vars.AUTH_ORIGIN = 'https://auth-preview.adeptify.me'
  assert.throws(
    () => validateDeployment(config, other, seed('production'), 'preview', true),
    /回调/,
  )
  config.vars.PLATFORM_ADMIN_IDS = '826b9c2a-f24a-4ca6-a747-411a5579b643'
  assert.throws(
    () => validateDeployment(config, other, seed('preview'), 'preview', true),
    /本地开发/,
  )
})
test('production workers.dev entry is enabled without stale custom domains', () => {
  const config = load('production'),
    other = load('preview')
  config.workers_dev = false
  assert.throws(
    () => validateDeployment(config, other, seed('production'), 'production', true),
    /workers.dev/,
  )
  config.workers_dev = true
  config.routes = [{ pattern: 'auth.adeptify.me', custom_domain: true }]
  assert.throws(
    () => validateDeployment(config, other, seed('production'), 'production', true),
    /workers.dev/,
  )
})
test('remote commands always select explicit environment; dry-run cannot deploy', () => {
  for (const env of ['preview', 'production']) {
    assert.ok(deploymentArgs('dry-run', env).includes('--dry-run'))
    for (const action of ['migrate', 'seed']) {
      const args = deploymentArgs(action, env)
      assert.ok(args.includes('--remote'))
      assert.ok(args.includes('deploy/' + env + '/wrangler.json'))
    }
  }
  assert.throws(() => deploymentArgs('delete', 'production'))
})
