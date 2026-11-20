import { fileURLToPath } from 'node:url'
import { id, loadProperties, oneOf, required } from '../../scripts/environment-properties.mjs'
import targets from '../../config/platform-targets.json' with { type: 'json' }

export const root = new URL('../../', import.meta.url)
export const port = Number(new URL(targets.dev.authOrigin).port)
const path = (relative) => fileURLToPath(new URL(relative, root))
const sessionKey = (value) => required(value) && /^[A-Za-z0-9_-]{43}$/u.test(value)
const optional = (value) => value === undefined || typeof value === 'string'
const email = (value) => required(value) && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u.test(value)
const phone = (value) => /^\+86\d{11}$/u.test(value)
function useLocalCredentials(localTest, provider, clientId, secret) {
  if (Boolean(clientId) !== Boolean(secret))
    throw new Error(`Configure both local ${provider} credentials or leave both empty`)
  return localTest && Boolean(clientId)
}

function contactList(validate) {
  return (value) => {
    try {
      const list = JSON.parse(value)
      return Array.isArray(list) && list.every((item) => typeof item === 'string' && validate(item.trim()))
    } catch {
      return false
    }
  }
}

function contacts(value) {
  return [...new Set(JSON.parse(value).map((item) => item.trim().toLowerCase()))]
}

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
      grafanaLogsDestination: (value) => value === undefined || (name !== 'dev' && id(value)),
    },
    {
      ALIYUN_MAIL_REGION: oneOf('cn-hangzhou'),
      ALIYUN_MAIL_ACCOUNT_NAME: required,
      ALIYUN_SMS_SIGN_NAME: required,
      UNIFIED_GOOGLE_CLIENT_ID: required,
      UNIFIED_GITHUB_CLIENT_ID: required,
      LOCAL_GOOGLE_CLIENT_ID: name === 'test' ? optional : oneOf(undefined),
      LOCAL_GITHUB_CLIENT_ID: name === 'test' ? optional : oneOf(undefined),
      ...(name !== 'prod'
        ? {
            PREVIEW_ACCOUNT_EMAIL: name === 'dev' ? email : (value) => !value || email(value),
            PREVIEW_ACCOUNT_PASSWORD: name === 'dev' ? required : optional,
          }
        : {}),
      ALIYUN_ACCESS_KEY_ID: required,
      ALIYUN_ACCESS_KEY_SECRET: required,
      AUTH_WEB_SESSION_KEY: sessionKey,
      PROVIDER_STATE_KEY: sessionKey,
      UNIFIED_GOOGLE_CLIENT_SECRET: required,
      UNIFIED_GITHUB_CLIENT_SECRET: required,
      AUTH_DEV_PROXY_URL: name === 'prod' ? oneOf(undefined) : optional,
      LOCAL_GOOGLE_CLIENT_SECRET: name === 'test' ? optional : oneOf(undefined),
      LOCAL_GITHUB_CLIENT_SECRET: name === 'test' ? optional : oneOf(undefined),
      TEST_ALLOWED_EMAILS: name !== 'prod' ? contactList(email) : oneOf(undefined),
      TEST_ALLOWED_PHONES: name !== 'prod' ? contactList(phone) : oneOf(undefined),
    },
  )
  const origin = local ? targets.dev.authOrigin : config.authOrigin
  const localTest = name === 'test' && local
  const localGoogle = useLocalCredentials(localTest, 'Google', secrets.LOCAL_GOOGLE_CLIENT_ID, secrets.LOCAL_GOOGLE_CLIENT_SECRET)
  const localGithub = useLocalCredentials(localTest, 'GitHub', secrets.LOCAL_GITHUB_CLIENT_ID, secrets.LOCAL_GITHUB_CLIENT_SECRET)
  const bindings = {
    AUTH_WEB_SESSION_KEY: secrets.AUTH_WEB_SESSION_KEY,
    PROVIDER_STATE_KEY: secrets.PROVIDER_STATE_KEY,
    ALIYUN_ACCESS_KEY_ID: secrets.ALIYUN_ACCESS_KEY_ID,
    ALIYUN_ACCESS_KEY_SECRET: secrets.ALIYUN_ACCESS_KEY_SECRET,
    ALIYUN_MAIL_REGION: secrets.ALIYUN_MAIL_REGION,
    ALIYUN_MAIL_ACCOUNT_NAME: secrets.ALIYUN_MAIL_ACCOUNT_NAME,
    ALIYUN_SMS_SIGN_NAME: secrets.ALIYUN_SMS_SIGN_NAME,
    UNIFIED_GOOGLE_CLIENT_ID: localGoogle ? secrets.LOCAL_GOOGLE_CLIENT_ID : secrets.UNIFIED_GOOGLE_CLIENT_ID,
    UNIFIED_GOOGLE_CLIENT_SECRET: localGoogle
      ? secrets.LOCAL_GOOGLE_CLIENT_SECRET
      : secrets.UNIFIED_GOOGLE_CLIENT_SECRET,
    UNIFIED_GITHUB_CLIENT_ID: localGithub ? secrets.LOCAL_GITHUB_CLIENT_ID : secrets.UNIFIED_GITHUB_CLIENT_ID,
    UNIFIED_GITHUB_CLIENT_SECRET: localGithub
      ? secrets.LOCAL_GITHUB_CLIENT_SECRET
      : secrets.UNIFIED_GITHUB_CLIENT_SECRET,
  }
  if (name !== 'prod') {
    const emails = contacts(secrets.TEST_ALLOWED_EMAILS)
    const phones = contacts(secrets.TEST_ALLOWED_PHONES)
    bindings.ALIYUN_MAIL_TEST_ALLOWLIST = emails.join(',')
    bindings.ALIYUN_SMS_TEST_ALLOWLIST = phones.join(',')
    if (name === 'test') bindings.AUTH_TEST_ADMISSION = JSON.stringify({ emails, phones })
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
    workers_dev: false,
    preview_urls: false,
    ...(!local && config.grafanaLogsDestination
      ? {
          observability: {
            enabled: true,
            redact_query_string: true,
            logs: {
              enabled: true,
              invocation_logs: false,
              head_sampling_rate: 1,
              persist: false,
              destinations: [config.grafanaLogsDestination],
            },
            traces: { enabled: false },
          },
        }
      : {}),
    ...(!local && name !== 'dev'
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
            email: secrets.PREVIEW_ACCOUNT_EMAIL.toLowerCase(),
            password: secrets.PREVIEW_ACCOUNT_PASSWORD,
          },
        }
      : {}),
  }
}
