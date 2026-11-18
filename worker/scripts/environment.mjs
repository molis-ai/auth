import { fileURLToPath } from 'node:url'
import { id, loadProperties, oneOf, required } from '../../scripts/environment-properties.mjs'
import targets from '../../config/platform-targets.json' with { type: 'json' }

export const root = new URL('../../', import.meta.url)
export const port = Number(new URL(targets.dev.authOrigin).port)
const path = (relative) => fileURLToPath(new URL(relative, root))
const sessionKey = (value) => required(value) && /^[A-Za-z0-9_-]{43}$/u.test(value)
const optional = (value) => value === undefined || typeof value === 'string'
const phones = (value) =>
  value === '' ||
  (typeof value === 'string' &&
    value.split(',').every((phone) => /^\+86\d{11}$/u.test(phone.trim())))
function phoneList(value) {
  try {
    const list = JSON.parse(value)
    return (
      Array.isArray(list) &&
      list.every((phone) => typeof phone === 'string' && /^\+86\d{11}$/u.test(phone))
    )
  } catch {
    return false
  }
}
const emails = (value) =>
  value === '' ||
  (typeof value === 'string' &&
    value.split(',').every((email) => /^[^\s@]+@[^\s@]+$/u.test(email.trim())))

export function authEnvironment(name, local, configRoot = root) {
  if (name === 'prod' && local) throw new Error('Auth prod is deploy only')
  const kind = { dev: 'LOCAL', test: 'TEST', prod: 'PRODUCTION' }[name]
  const target = targets[name]
  const { config, secrets } = loadProperties(
    configRoot,
    name,
    {
      workerName: oneOf(target?.workerName),
      accountId: oneOf(name === 'dev' ? undefined : targets.platformAccountId),
      databaseName: oneOf(target?.databaseName),
      databaseId: oneOf(target?.databaseId),
      authOrigin: oneOf(target?.authOrigin),
      environmentId: id,
      webClientId: id,
      localEnvironmentId: name === 'test' ? id : oneOf(undefined),
      localWebClientId: name === 'test' ? id : oneOf(undefined),
      tenantCreationPolicy: oneOf('SELF_SERVICE', 'PLATFORM_ONLY'),
    },
    {
      mailRegion: oneOf('cn-hangzhou'),
      mailAccount: required,
      smsSignName: required,
      smsDeliveryAllowlist: name === 'dev' ? phoneList : oneOf(undefined),
      googleClientId: required,
      githubClientId: required,
      localGoogleClientId: name === 'test' ? required : oneOf(undefined),
      localGithubClientId: name === 'test' ? required : oneOf(undefined),
      ...(name === 'dev'
        ? {
            previewAccountEmail: (value) => required(value) && /^[^\s@]+@[^\s@]+$/u.test(value),
            previewAccountPassword: required,
          }
        : {}),
      ALIYUN_ACCESS_KEY_ID: required,
      ALIYUN_ACCESS_KEY_SECRET: required,
      AUTH_WEB_SESSION_KEY: sessionKey,
      PROVIDER_STATE_KEY: sessionKey,
      UNIFIED_GOOGLE_CLIENT_SECRET: required,
      UNIFIED_GITHUB_CLIENT_SECRET: required,
      AUTH_DEV_PROXY_URL: name === 'prod' ? oneOf(undefined) : optional,
      LOCAL_GOOGLE_CLIENT_SECRET: name === 'test' ? required : oneOf(undefined),
      LOCAL_GITHUB_CLIENT_SECRET: name === 'test' ? required : oneOf(undefined),
      allowedEmails: name === 'test' ? emails : oneOf(undefined),
      allowedPhones: name === 'test' ? phones : oneOf(undefined),
    },
  )
  const origin = local ? targets.dev.authOrigin : config.authOrigin
  const localTest = name === 'test' && local
  const bindings = {
    AUTH_WEB_SESSION_KEY: secrets.AUTH_WEB_SESSION_KEY,
    PROVIDER_STATE_KEY: secrets.PROVIDER_STATE_KEY,
    ALIYUN_ACCESS_KEY_ID: secrets.ALIYUN_ACCESS_KEY_ID,
    ALIYUN_ACCESS_KEY_SECRET: secrets.ALIYUN_ACCESS_KEY_SECRET,
    ALIYUN_MAIL_REGION: secrets.mailRegion,
    ALIYUN_MAIL_ACCOUNT_NAME: secrets.mailAccount,
    ALIYUN_SMS_SIGN_NAME: secrets.smsSignName,
    UNIFIED_GOOGLE_CLIENT_ID: localTest ? secrets.localGoogleClientId : secrets.googleClientId,
    UNIFIED_GOOGLE_CLIENT_SECRET: localTest
      ? secrets.LOCAL_GOOGLE_CLIENT_SECRET
      : secrets.UNIFIED_GOOGLE_CLIENT_SECRET,
    UNIFIED_GITHUB_CLIENT_ID: localTest ? secrets.localGithubClientId : secrets.githubClientId,
    UNIFIED_GITHUB_CLIENT_SECRET: localTest
      ? secrets.LOCAL_GITHUB_CLIENT_SECRET
      : secrets.UNIFIED_GITHUB_CLIENT_SECRET,
  }
  if (name === 'dev')
    bindings.ALIYUN_SMS_TEST_ALLOWLIST = JSON.parse(secrets.smsDeliveryAllowlist).join(',')
  if (name === 'test') {
    bindings.ALIYUN_SMS_TEST_ALLOWLIST = secrets.allowedPhones
    bindings.AUTH_TEST_ADMISSION = JSON.stringify({
      emails: secrets.allowedEmails
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
      phones: secrets.allowedPhones
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    })
  }
  if (
    localTest &&
    (config.localEnvironmentId === config.environmentId ||
      config.localWebClientId === config.webClientId)
  )
    throw new Error('Auth test needs distinct remote and loopback registrations')
  const account = {
    environmentId: localTest ? config.localEnvironmentId : config.environmentId,
    kind,
    authOrigin: origin,
    providerMode: 'LIVE',
    deliveryMode: 'LIVE',
  }
  const vars = {
    MOLIS_ENVIRONMENT: name,
    AUTH_ORIGIN: origin,
    AUTH_WEB_CLIENT_ID: localTest ? config.localWebClientId : config.webClientId,
    UNIFIED_ACCOUNT_CONFIG: JSON.stringify(account),
    TENANT_CREATION_POLICY: config.tenantCreationPolicy,
  }

  const platform = {
    name: config.workerName,
    ...(config.accountId ? { account_id: config.accountId } : {}),
    main: path('worker/rust/build/index.js'),
    compatibility_date: '2026-09-19',
    workers_dev: name === 'prod',
    preview_urls: false,
    ...(name === 'test' && !local
      ? { routes: [{ pattern: new URL(origin).hostname, custom_domain: true }] }
      : {}),
    assets: {
      directory: path('web/dist'),
      binding: 'ASSETS',
      run_worker_first: true,
      html_handling: 'none',
      not_found_handling: 'none',
    },
    vars,
    triggers: { crons: ['0 * * * *'] },
    d1_databases: [
      {
        binding: 'DB',
        database_name: config.databaseName,
        database_id: config.databaseId,
        migrations_dir: path('worker/migrations'),
        ...(localTest ? { remote: true } : {}),
      },
    ],
    durable_objects: { bindings: [{ name: 'PASSWORD_KDF', class_name: 'PasswordKdf' }] },
    migrations: [{ tag: 'password-kdf-v1', new_sqlite_classes: ['PasswordKdf'] }],
  }
  return {
    platform,
    bindings: Object.freeze(bindings),
    outboundProxy: secrets.AUTH_DEV_PROXY_URL,
    ...(local && name === 'dev'
      ? {
          previewAccount: {
            email: secrets.previewAccountEmail.toLowerCase(),
            password: secrets.previewAccountPassword,
          },
        }
      : {}),
  }
}
