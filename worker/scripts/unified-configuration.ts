import { validateNamed } from '../../contracts/unified-account/validate.ts'

/** Environment selection is deployment configuration, never a request parameter. */
export function validateUnifiedConfiguration(value: unknown, authOrigin: string) {
  const invalid = () => new Error('UNIFIED_CONFIGURATION_INVALID')
  if (!validateNamed('EnvironmentConfig', value)) throw invalid()
  const config = value as {
    environmentId: string
    kind: 'LOCAL' | 'TEST' | 'PRODUCTION'
    authOrigin: string
    deliveryMode: 'MOCK' | 'LIVE'
    providerMode: 'MOCK' | 'LIVE'
  }
  let url: URL
  try {
    url = new URL(config.authOrigin)
  } catch {
    throw invalid()
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const loopback =
    local ||
    url.hostname.endsWith('.localhost') ||
    /^127\.[0-9]+\.[0-9]+\.[0-9]+$/.test(url.hostname)
  if (
    config.authOrigin !== authOrigin ||
    url.origin !== config.authOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && local)) ||
    (config.kind === 'LOCAL' && !local) ||
    (config.kind === 'PRODUCTION' &&
      (loopback || config.deliveryMode !== 'LIVE' || config.providerMode !== 'LIVE'))
  )
    throw invalid()
  return config
}
