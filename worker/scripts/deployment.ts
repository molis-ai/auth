import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const worker = fileURLToPath(new URL('../', import.meta.url))
const zero = '00000000-0000-0000-0000-000000000000'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateDeployment(
  config: any,
  other: any,
  seed: string,
  environment: string,
  offline = false,
) {
  if (!['preview', 'production'].includes(environment))
    throw new Error('环境必须是 preview 或 production')
  const name = 'molis-auth-' + environment
  const host =
    environment === 'preview'
      ? 'auth-preview.adeptify.me'
      : 'molis-auth-production.sparkling-silence-0a49.workers.dev'
  const db = config.d1_databases?.[0]
  const require = (ok: unknown, message: string) => {
    if (!ok) throw new Error(message)
  }
  require(config.name === name, 'Worker 名称与环境不匹配')
  require(config.vars?.AUTH_ORIGIN === 'https://' + host, 'AUTH_ORIGIN 与环境不匹配')
  if (environment === 'production') {
    require(config.workers_dev === true &&
      !config.routes?.length &&
      !config.route, '正式环境必须使用 workers.dev，不能绑定其他域名')
  } else {
    require(config.routes?.length === 1 &&
      config.routes[0].pattern === host &&
      config.routes[0].custom_domain === true, '自定义域名与环境不匹配')
    require(config.workers_dev === false, '预览环境仅允许配置的域名入口')
  }
  require(config.preview_urls === false, '禁止额外的版本预览入口')
  require(config.d1_databases?.length === 1 &&
    db.binding === 'DB' &&
    db.database_name === name, 'D1 绑定与环境不匹配')
  require(uuid.test(db.database_id), 'D1 database_id 必须是有效 UUID')
  require(offline || db.database_id !== zero, '请先创建云端 D1，并填写真实 database_id')
  require(db.database_id === zero ||
    db.database_id !== other.d1_databases?.[0]?.database_id, '预览和正式环境不能共用 D1')
  const admins = config.vars.PLATFORM_ADMIN_IDS
  require(typeof admins === 'string' &&
    admins
      .split(',')
      .every(
        (id: string) => !id.trim() || uuid.test(id.trim()),
      ), '超管白名单必须填写用户 UUID，不是邮箱')
  require(!admins.includes('826b9c2a-f24a-4ca6-a747-411a5579b643'), '不能复用本地开发超管 ID')
  require(Object.keys(config.vars).every((k) =>
    ['AUTH_ORIGIN', 'PLATFORM_ADMIN_IDS'].includes(k),
  ), '敏感配置请使用 Wrangler secret put，不要写入 vars')
  require(seed.includes('https://' + host + '/console/callback') &&
    !/localhost|127\.0\.0\.1/.test(seed), '初始化回调地址不正确')
}

export function deploymentArgs(action: string, environment: string): string[] {
  const config = 'deploy/' + environment + '/wrangler.json'
  const name = 'molis-auth-' + environment
  switch (action) {
    case 'dry-run':
      return ['deploy', '--dry-run', '--config', config]
    case 'migrate':
      return ['d1', 'migrations', 'apply', name, '--remote', '--config', config]
    case 'seed':
      return [
        'd1',
        'execute',
        name,
        '--remote',
        '--file',
        'deploy/' + environment + '/seed.sql',
        '--config',
        config,
      ]
    case 'deploy':
      return ['deploy', '--config', config]
    default:
      throw new Error('操作必须是 check、dry-run、migrate、seed 或 deploy')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [environment, action = 'check', ...extra] = process.argv.slice(2)
    if (!['preview', 'production'].includes(environment) || extra.length)
      throw new Error(
        '用法：npm run cloudflare -- preview|production check|dry-run|migrate|seed|deploy',
      )
    const load = (env: string) =>
      JSON.parse(readFileSync(resolve(worker, 'deploy', env, 'wrangler.json'), 'utf8'))
    validateDeployment(
      load(environment),
      load(environment === 'preview' ? 'production' : 'preview'),
      readFileSync(resolve(worker, 'deploy', environment, 'seed.sql'), 'utf8'),
      environment,
      action === 'dry-run',
    )
    console.log('环境检查通过：' + environment)
    if (action !== 'check') {
      const args = deploymentArgs(action, environment)
      console.log('wrangler ' + args.join(' '))
      const result = spawnSync(
        process.execPath,
        [resolve(worker, 'node_modules/wrangler/bin/wrangler.js'), ...args],
        { cwd: worker, stdio: 'inherit' },
      )
      if (result.error) throw result.error
      process.exitCode = result.status ?? 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
