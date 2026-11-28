import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { authEnvironment, cleanWranglerEnv, compatibilityDate } from '../scripts/environment.mjs'

function fixtureSecrets(env: string) {
  return readFileSync(new URL(`../../secrets.example/${env}.properties`, import.meta.url), 'utf8')
    .replace(/^PREVIEW_ACCOUNT_EMAIL=$/mu, 'PREVIEW_ACCOUNT_EMAIL=fixture-user@example.test')
    .replace(/^PREVIEW_ACCOUNT_PASSWORD=$/mu, 'PREVIEW_ACCOUNT_PASSWORD=fixture-only-password')
    .replace(/^([A-Z_]+)=$/gmu, (_, key: string) => {
      const value = [
        'AUTH_WEB_SESSION_KEY',
        'PROVIDER_STATE_KEY',
        'MOLIS_INTERNAL_SECRET',
      ].includes(key)
        ? 'A'.repeat(43)
        : key + '-fixture'
      return `${key}=${value}`
    })
}

test('secret property names use upper snake case in every environment template', () => {
  for (const env of ['dev', 'test', 'prod']) {
    const template = readFileSync(
      new URL(`../../secrets.example/${env}.properties`, import.meta.url),
      'utf8',
    )
    for (const line of template.split(/\r?\n/u)) {
      if (line.trim() && !line.trimStart().startsWith('#'))
        assert.match(line, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*=/u, env)
    }
  }
})

test('Wrangler commands keep credentials and explicit flags while stripping target overrides', () => {
  const base = Object.freeze({
    CLOUDFLARE_ENV: 'staging',
    CLOUDFLARE_ACCOUNT_ID: 'wrong-account',
    CF_ACCOUNT_ID: 'wrong-account',
    CLOUDFLARE_COMPLIANCE_REGION: 'wrong-region',
    CLOUDFLARE_API_BASE_URL: 'https://wrong.invalid',
    CF_API_BASE_URL: 'https://wrong.invalid',
    WRANGLER_API_ENVIRONMENT: 'staging',
    WRANGLER_CI_OVERRIDE_NAME: 'wrong-worker',
    WRANGLER_CI_GENERATE_PREVIEW_ALIAS: 'true',
    WRANGLER_LOG_SANITIZE: 'false',
    CLOUDFLARE_API_TOKEN: 'fixture-token',
    PATH: '/fixture/bin',
  })
  assert.deepEqual(
    cleanWranglerEnv(base, {
      WRANGLER_LOG_SANITIZE: 'true',
      CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
      CLOUDFLARE_ACCOUNT_ID: 'also-wrong',
    }),
    {
      WRANGLER_LOG_SANITIZE: 'true',
      CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
      CLOUDFLARE_API_TOKEN: 'fixture-token',
      PATH: '/fixture/bin',
    },
  )
})

test('ENV-U-01: the Auth test deployment pins account, Worker, route and D1 independently of properties', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'auth-targets-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = pathToFileURL(directory + '/')
  mkdirSync(new URL('config', root))
  mkdirSync(new URL('secrets', root))
  const testConfig = readFileSync(new URL('../../config/test.properties', import.meta.url), 'utf8')
  const privateValues = fixtureSecrets('test')
    .replace(
      'TEST_ALLOWED_EMAILS=[]',
      'TEST_ALLOWED_EMAILS=["Allowed@Example.test","allowed@example.test"]',
    )
    .replace('TEST_ALLOWED_PHONES=[]', 'TEST_ALLOWED_PHONES=["+8613800000000","+8613800000000"]')
  writeFileSync(new URL('secrets/test.properties', root), privateValues)
  const configPath = new URL('config/test.properties', root)
  const wrongTargets = {
    workerName: 'molis-auth-production',
    authOrigin: 'https://auth.molis.ai',
    databaseName: 'molis-auth-prod',
    databaseId: '03dba427-ffc6-4f01-a57b-9b504f206237',
    accountId: 'f'.repeat(32),
  }
  for (const [key, wrong] of Object.entries(wrongTargets)) {
    writeFileSync(
      configPath,
      testConfig.replace(new RegExp(`^${key}=.*$`, 'mu'), `${key}=${wrong}`),
    )
    assert.throws(
      () => authEnvironment('test', false, root),
      new RegExp(`invalid field ${key}`, 'u'),
    )
  }

  writeFileSync(configPath, testConfig)
  const { platform, bindings } = authEnvironment('test', false, root)
  assert.equal(platform.name, 'molis-auth-test')
  assert.equal(platform.compatibility_date, compatibilityDate)
  assert.deepEqual(platform.routes, [{ pattern: 'auth.test.molis.ai', custom_domain: true }])
  assert.equal(platform.d1_databases[0].database_name, 'molis-auth-test')
  assert.equal(platform.d1_databases[0].database_id, 'aebe90fc-2c8d-4e73-b318-d5fa5c376c84')
  assert.equal(platform.d1_databases[0].remote, undefined)
  assert.equal(platform.vars.AUTH_TEST_ADMISSION, undefined)
  assert.equal(platform.vars.ALIYUN_SMS_TEST_ALLOWLIST, undefined)
  assert.equal(platform.vars.MOLIS_INTERNAL_SECRET, undefined)
  assert.equal(bindings.MOLIS_INTERNAL_SECRET, 'A'.repeat(43))
  assert.deepEqual(platform.services, [
    { binding: 'BILLING', service: 'molis-billing-test', entrypoint: 'BillingInternal' },
  ])
  assert.equal(bindings.ALIYUN_MAIL_TEST_ALLOWLIST, 'allowed@example.test')
  assert.equal(bindings.ALIYUN_SMS_TEST_ALLOWLIST, '+8613800000000')
  assert.deepEqual(JSON.parse(bindings.AUTH_TEST_ADMISSION), {
    emails: ['allowed@example.test'],
    phones: ['+8613800000000'],
  })
  assert.equal(authEnvironment('test', true, root).platform.d1_databases[0].remote, true)
  assert.equal(authEnvironment('test', true, root).platform.services, undefined)
  assert.equal(authEnvironment('test', true, root).platform.observability, undefined)
  assert.deepEqual(platform.observability, {
    enabled: true,
    redact_query_string: true,
    logs: {
      enabled: true,
      invocation_logs: false,
      head_sampling_rate: 1,
      persist: false,
      destinations: ['molis-grafana-logs'],
    },
    traces: { enabled: false },
  })

  writeFileSync(configPath, testConfig.replace(/^grafanaLogsDestination=.*\n?/mu, ''))
  assert.equal(authEnvironment('test', false, root).platform.observability, undefined)
})

test('only local dev reads the shared account and keeps both credentials out of Worker bindings', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'auth-preview-account-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = pathToFileURL(directory + '/')
  mkdirSync(new URL('config', root))
  mkdirSync(new URL('secrets', root))
  for (const env of ['dev', 'test', 'prod']) {
    const config = readFileSync(new URL(`../../config/${env}.properties`, import.meta.url), 'utf8')
    const secrets = fixtureSecrets(env)
    const ordinary = new URL(`config/${env}.properties`, root)
    const privateFile = new URL(`secrets/${env}.properties`, root)
    writeFileSync(ordinary, config)
    writeFileSync(privateFile, secrets)
    const settings = authEnvironment(env, env !== 'prod', root)
    if (env === 'prod') {
      assert.deepEqual(settings.platform.routes, [
        { pattern: 'auth.molis.ai', custom_domain: true },
      ])
      assert.equal(settings.platform.workers_dev, false)
      assert.equal(settings.platform.preview_urls, false)
      assert.equal(settings.platform.vars.AUTH_ORIGIN, 'https://auth.molis.ai')
      assert.equal(settings.platform.d1_databases[0].database_name, 'molis-auth-prod')
      assert.equal(
        settings.platform.d1_databases[0].database_id,
        '03dba427-ffc6-4f01-a57b-9b504f206237',
      )
      assert.throws(() => authEnvironment('prod', true, root), /deploy only/u)
      assert.deepEqual(settings.platform.services, [
        { binding: 'BILLING', service: 'molis-billing-production', entrypoint: 'BillingInternal' },
      ])
    }
    if (env === 'dev') assert.equal(settings.platform.services, undefined)
    const providerBindings = settings.bindings
    assert.equal(providerBindings.ALIYUN_MAIL_REGION, 'cn-hangzhou')
    assert.equal(providerBindings.ALIYUN_MAIL_ACCOUNT_NAME, 'ALIYUN_MAIL_ACCOUNT_NAME-fixture')
    assert.equal(providerBindings.ALIYUN_SMS_SIGN_NAME, 'ALIYUN_SMS_SIGN_NAME-fixture')
    for (const [provider, localIdKey] of [
      ['google', 'LOCAL_GOOGLE_CLIENT_ID'],
      ['github', 'LOCAL_GITHUB_CLIENT_ID'],
    ]) {
      const upper = provider.toUpperCase()
      const idBinding = `UNIFIED_${upper}_CLIENT_ID`
      const secretBinding = `UNIFIED_${upper}_CLIENT_SECRET`
      const defaultId = idBinding + '-fixture'
      const defaultSecret = secretBinding + '-fixture'
      assert.equal(providerBindings[idBinding], defaultId)
      assert.equal(providerBindings[secretBinding], defaultSecret)
      if (env !== 'test') continue

      const localId = `\n${localIdKey}=`
      const localSecret = `\nLOCAL_${upper}_CLIENT_SECRET=`
      writeFileSync(privateFile, secrets + localId + localSecret)
      const blank = authEnvironment(env, true, root).bindings
      assert.equal(blank[idBinding], defaultId)
      assert.equal(blank[secretBinding], defaultSecret)
      for (const partial of [localId, localSecret]) {
        writeFileSync(privateFile, secrets + partial + 'fixture')
        assert.throws(() => authEnvironment(env, true, root), /both local .* credentials/)
      }
      writeFileSync(privateFile, secrets + localId + 'local-id' + localSecret + 'local-secret')
      const local = authEnvironment(env, true, root).bindings
      assert.equal(local[idBinding], 'local-id')
      assert.equal(local[secretBinding], 'local-secret')
      const remote = authEnvironment(env, false, root).bindings
      assert.equal(remote[idBinding], defaultId)
      assert.equal(remote[secretBinding], defaultSecret)
      writeFileSync(privateFile, secrets)
    }
    assert.ok(!Object.keys(settings.platform.vars).some((key) => /ALIYUN|GOOGLE|GITHUB/.test(key)))
    writeFileSync(ordinary, config + '\nUNIFIED_GOOGLE_CLIENT_ID=public-copy\n')
    assert.throws(() => authEnvironment(env, env !== 'prod', root), /Invalid configuration/)
    writeFileSync(ordinary, config)
    if (env !== 'prod') {
      assert.equal(providerBindings.ALIYUN_SMS_TEST_ALLOWLIST, '')
      assert.equal(providerBindings.ALIYUN_MAIL_TEST_ALLOWLIST, '')
      if (env === 'dev') assert.equal(providerBindings.AUTH_TEST_ADMISSION, undefined)
      else
        assert.deepEqual(JSON.parse(providerBindings.AUTH_TEST_ADMISSION), {
          emails: [],
          phones: [],
        })
      for (const [key, invalidItem] of [
        ['TEST_ALLOWED_PHONES', '+123'],
        ['TEST_ALLOWED_EMAILS', 'invalid'],
      ]) {
        for (const invalid of ['', 'null', '{}', JSON.stringify([invalidItem]), '[123]', 'a,b']) {
          writeFileSync(privateFile, secrets.replace(key + '=[]', key + '=' + invalid))
          assert.throws(() => authEnvironment(env, true, root), new RegExp('invalid field ' + key))
        }
      }
      writeFileSync(privateFile, secrets)
    }
    if (env === 'dev') {
      assert.equal(settings.previewAccount.email, 'fixture-user@example.test')
      assert.ok(settings.previewAccount.password)
      const bindings = JSON.stringify([settings.platform, settings.bindings])
      assert.ok(!bindings.includes(settings.previewAccount.email))
      assert.ok(!bindings.includes(settings.previewAccount.password))
    } else {
      assert.equal(settings.previewAccount, undefined)
      if (env === 'test') {
        const remote = authEnvironment(env, false, root)
        assert.equal(remote.previewAccount, undefined)
        for (const target of [settings, remote]) {
          assert.ok(!JSON.stringify(target).includes('fixture-only-password'))
          assert.ok(!JSON.stringify(target).includes('fixture-user@example.test'))
        }
      }
    }
    for (const field of [
      'PREVIEW_ACCOUNT_EMAIL=preview@example.test',
      'PREVIEW_ACCOUNT_PASSWORD=example',
    ]) {
      writeFileSync(ordinary, config + '\n' + field)
      assert.throws(() => authEnvironment(env, env !== 'prod', root), /Invalid configuration/)
      writeFileSync(ordinary, config)
      if (env === 'prod') {
        writeFileSync(privateFile, secrets + '\n' + field)
        assert.throws(() => authEnvironment(env, env !== 'prod', root), /Invalid configuration/)
        writeFileSync(privateFile, secrets)
      }
    }
  }
})
