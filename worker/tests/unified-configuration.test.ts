import test from 'node:test'
import assert from 'node:assert/strict'
import { validateUnifiedConfiguration } from '../scripts/unified-configuration.ts'

test('UAS-40: explicit isolated mock configuration; no production mock or unknown configuration', () => {
  const config = {
    environmentId: 'unified-local',
    kind: 'LOCAL',
    authOrigin: 'http://127.0.0.1:8787',
    deliveryMode: 'MOCK',
    providerMode: 'MOCK',
  }
  assert.equal(validateUnifiedConfiguration(config, config.authOrigin).kind, 'LOCAL')
  for (const change of [
    { kind: 'UNKNOWN' },
    { deliveryMode: 'AUTO' },
    { providerMode: 'fallback' },
    { actorUserId: 'injected' },
    { authOrigin: 'http://localhost:8787' },
  ])
    assert.throws(() => validateUnifiedConfiguration({ ...config, ...change }, config.authOrigin))
  const production = { ...config, kind: 'PRODUCTION', authOrigin: 'https://auth.example.test' }
  for (const modes of [
    { deliveryMode: 'MOCK', providerMode: 'LIVE' },
    { deliveryMode: 'LIVE', providerMode: 'MOCK' },
  ])
    assert.throws(() =>
      validateUnifiedConfiguration({ ...production, ...modes }, production.authOrigin),
    )
  assert.equal(
    validateUnifiedConfiguration(
      { ...production, deliveryMode: 'LIVE', providerMode: 'LIVE' },
      production.authOrigin,
    ).kind,
    'PRODUCTION',
  )
  for (const authOrigin of [
    'https://user@auth.example.test',
    'https://auth.example.test/path',
    'https://auth.example.test?x=1',
    'https://auth.example.test#x',
    'http://auth.example.test',
    'https://localhost',
    'https://127.0.0.2',
    'https://app.localhost',
  ]) {
    assert.throws(() =>
      validateUnifiedConfiguration(
        { ...production, authOrigin, deliveryMode: 'LIVE', providerMode: 'LIVE' },
        authOrigin,
      ),
    )
  }
})
