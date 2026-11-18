import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { authEnvironment } from '../scripts/environment.mjs'

function fixtureSecrets(env: string) {
  return readFileSync(new URL(`../../secrets.example/${env}.properties`, import.meta.url), 'utf8')
    .replace(/^previewAccountEmail=$/mu, 'previewAccountEmail=fixture-user@example.test')
    .replace(/^previewAccountPassword=$/mu, 'previewAccountPassword=fixture-only-password')
    .replace(/^([A-Z_]+)=$/gmu, (_, key: string) =>
      key === 'AUTH_WEB_SESSION_KEY' || key === 'PROVIDER_STATE_KEY'
        ? `${key}=${'A'.repeat(43)}`
        : `${key}=${key}-fixture`,
    )
    .replace(
      /^(mailAccount|smsSignName|(?:google|github|localGoogle|localGithub)ClientId)=$/gmu,
      '$1=$1-fixture',
    )
}

test('V2-01: the Auth test deployment pins account, Worker, route and D1 independently of properties', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'auth-targets-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = pathToFileURL(directory + '/')
  mkdirSync(new URL('config', root))
  mkdirSync(new URL('secrets', root))
  const testConfig = readFileSync(new URL('../../config/test.properties', import.meta.url), 'utf8')
  const privateValues = fixtureSecrets('test')
    .replace('allowedEmails=', 'allowedEmails=Allowed@Example.test')
    .replace('allowedPhones=', 'allowedPhones=+8613800000000')
  writeFileSync(new URL('secrets/test.properties', root), privateValues)
  const configPath = new URL('config/test.properties', root)
  const wrongTargets = {
    workerName: 'molis-auth-production',
    authOrigin: 'https://molis-auth-production.sparkling-silence-0a49.workers.dev',
    databaseName: 'molis-auth-production',
    databaseId: '33c19147-0f55-441d-af1b-8d334d064c51',
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
  assert.equal(platform.name, 'molis-auth-staging')
  assert.deepEqual(platform.routes, [{ pattern: 'auth.test.molis.ai', custom_domain: true }])
  assert.equal(platform.d1_databases[0].database_id, 'de8dc585-1d73-401d-8f4c-37e8e227702d')
  assert.equal(platform.d1_databases[0].remote, undefined)
  assert.equal(platform.vars.AUTH_TEST_ADMISSION, undefined)
  assert.equal(platform.vars.ALIYUN_SMS_TEST_ALLOWLIST, undefined)
  assert.deepEqual(JSON.parse(bindings.AUTH_TEST_ADMISSION), {
    emails: ['allowed@example.test'],
    phones: ['+8613800000000'],
  })
  assert.equal(authEnvironment('test', true, root).platform.d1_databases[0].remote, true)
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
    const providerBindings = settings.bindings
    assert.equal(providerBindings.ALIYUN_MAIL_REGION, 'cn-hangzhou')
    assert.equal(providerBindings.ALIYUN_MAIL_ACCOUNT_NAME, 'mailAccount-fixture')
    assert.equal(providerBindings.ALIYUN_SMS_SIGN_NAME, 'smsSignName-fixture')
    for (const provider of ['google', 'github']) {
      const upper = provider.toUpperCase()
      const clientId =
        env === 'test'
          ? 'local' + provider[0].toUpperCase() + provider.slice(1) + 'ClientId'
          : provider + 'ClientId'
      assert.equal(providerBindings[`UNIFIED_${upper}_CLIENT_ID`], clientId + '-fixture')
      assert.equal(
        providerBindings[`UNIFIED_${upper}_CLIENT_SECRET`],
        `${env === 'test' ? 'LOCAL' : 'UNIFIED'}_${upper}_CLIENT_SECRET-fixture`,
      )
      if (env === 'test') {
        const deployed = authEnvironment(env, false, root).bindings
        assert.equal(deployed[`UNIFIED_${upper}_CLIENT_ID`], provider + 'ClientId-fixture')
        assert.equal(
          deployed[`UNIFIED_${upper}_CLIENT_SECRET`],
          `UNIFIED_${upper}_CLIENT_SECRET-fixture`,
        )
      }
    }
    assert.ok(!Object.keys(settings.platform.vars).some((key) => /ALIYUN|GOOGLE|GITHUB/.test(key)))
    writeFileSync(ordinary, config + '\ngoogleClientId=public-copy\n')
    assert.throws(() => authEnvironment(env, env !== 'prod', root), /Invalid configuration/)
    writeFileSync(ordinary, config)
    if (env === 'dev') {
      assert.equal(providerBindings.ALIYUN_SMS_TEST_ALLOWLIST, '')
      const withList = (value: string) =>
        writeFileSync(
          privateFile,
          secrets.replace('smsDeliveryAllowlist=[]', 'smsDeliveryAllowlist=' + value),
        )
      withList('["+8613800000000", "+8613800000001"]')
      assert.equal(
        authEnvironment(env, true, root).bindings.ALIYUN_SMS_TEST_ALLOWLIST,
        '+8613800000000,+8613800000001',
      )
      for (const invalid of ['', 'null', '{}', '["+123"]', '[123]', 'not-json']) {
        withList(invalid)
        assert.throws(() => authEnvironment(env, true, root), /invalid field smsDeliveryAllowlist/)
      }
      writeFileSync(privateFile, secrets)
      assert.equal(settings.previewAccount.email, 'fixture-user@example.test')
      assert.ok(settings.previewAccount.password)
      const bindings = JSON.stringify([settings.platform, settings.bindings])
      assert.ok(!bindings.includes(settings.previewAccount.email))
      assert.ok(!bindings.includes(settings.previewAccount.password))
    } else {
      assert.equal(settings.previewAccount, undefined)
    }
    for (const field of [
      'previewAccountEmail=preview@example.test',
      'previewAccountPassword=example',
    ]) {
      writeFileSync(ordinary, config + '\n' + field)
      assert.throws(() => authEnvironment(env, env !== 'prod', root), /Invalid configuration/)
      writeFileSync(ordinary, config)
      if (env !== 'dev') {
        writeFileSync(privateFile, secrets + '\n' + field)
        assert.throws(() => authEnvironment(env, env !== 'prod', root), /Invalid configuration/)
        writeFileSync(privateFile, secrets)
      }
    }
  }
})
