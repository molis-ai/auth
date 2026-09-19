# Cloudflare 部署手册

## 当前采用的发布方式（优先按此执行）

用户已创建正式 Worker，使用 Cloudflare 免费网址：
https://molis-auth-production.sparkling-silence-0a49.workers.dev

正式配置和 seed 已匹配该地址，不需要购买域名、修改阿里云 DNS 或绑定 adeptify.me。预览配置保留备用，本轮先不创建预览资源。
下一步只需创建名为 molis-auth-production 的 D1，将其 database_id 填入正式配置，然后按本文 production 命令迁移、初始化、发布。
本文后续涉及 auth.adeptify.me 的网址是自定义域名方案说明；当前正式登录入口为上述 workers.dev 地址加 /login，回调为该地址加 /console/callback，第三方回调也使用当前正式地址。

本地代码准备完成不代表已上线。以下操作需要你自己的 Cloudflare 账户；本文不会自动创建资源、修改 DNS 或推送 Git。

## 环境与文件

| 环境 | Worker / D1 名称 | 域名 | 配置 |
| --- | --- | --- | --- |
| 本地 | molis-auth-local / auth-local | 127.0.0.1:8787 | worker/wrangler.jsonc |
| 预览 | molis-auth-preview | auth-preview.adeptify.me | worker/deploy/preview/wrangler.json |
| 正式 | molis-auth-production | auth.adeptify.me | worker/deploy/production/wrangler.json |

两个云端配置里的 D1 ID 暂为占位值，必须填写真实 ID。不要替换本地配置。前端与后端由同一 Worker 提供，不需要 Pages 或其他服务器。所有环境共享账户免费额度，并不是各自获得一份额度。

## 1. 账户与域名（一次性）

- 确认 Workers 使用 Free 计划。启用 Cloudflare 账户 MFA 并保存恢复码。
- 确认 adeptify.me 在 Cloudflare 为 Active。域名可以继续在阿里云续费；若尚未接管 DNS，先核对并保留现有解析，再按 Cloudflare 给出的 NS 更新阿里云域名服务器。
- 不改官网已有 Worker。两个新子域名通过配置的 Custom Domain 在部署时绑定；若已有同名解析或 Worker 绑定，先核对归属，不能直接删除。
- 预览环境只放测试数据。建议另外配置 Cloudflare Access 限制访问，并验证它不会拦截需要联调的 OAuth 回调/服务请求。关闭 workers.dev 和 preview_urls 不是访问控制。

## 2. 安装依赖、登录、创建 D1

使用 Node.js 22.18+，以下命令从仓库根目录开始：

```sh
npm run setup
cd worker
npx wrangler login
npx wrangler whoami
npx wrangler d1 create molis-auth-preview
npx wrangler d1 create molis-auth-production
cd ..
```

将两个命令返回的 database_id 分别填入对应配置。UUID 不是密码，可以提交。若账户有多个 Cloudflare account，在两个配置中显式添加正确的 account_id。

```sh
npm run cloudflare -- preview check
npm run cloudflare -- production check
```

检查会阻止占位数据库 ID、共用数据库、错误回调域名以及本地开发超管 ID。它是静态检查，不验证云端资源是否真的存在或账户权限是否足够。

## 3. 先发布预览

```sh
npm test
npm run build:web
npm run cloudflare -- preview dry-run
npm run cloudflare -- preview migrate
npm run cloudflare -- preview seed
npm run cloudflare -- preview deploy
```

`dry-run` 只打包，可以在未填写 D1 ID 时运行；其他命令必须配置真实 ID。
`migrate` 与 `seed` 明确操作远端；`deploy` 不自动迁移数据库。seed 只初始化内置应用和修正该环境的 Console 回调，不创建用户、不设置密码，可重复运行。不要对云端执行 local-seed.sql。

访问 https://auth-preview.adeptify.me/login。预览通过后，对 production 依次执行 check、dry-run、migrate、seed、deploy。不要把本地或预览数据库导入正式环境。

## 4. 设置正式超管

初始 PLATFORM_ADMIN_IDS 为空，注册账号不会自动成为超管。

1. 在正式站点注册自己的账号，设置独立强密码。
2. 在 Cloudflare 正式 D1 控制台中查询用户 ID，例如将下面示例邮箱替换为实际邮箱：

```sql
SELECT u.id, u.display_name, e.canonical_email
FROM auth_user u JOIN auth_user_email e ON e.user_id = u.id
WHERE e.canonical_email = 'your-email@example.com';
```

3. 核实邮箱和 UUID，将 UUID 写入正式配置的 PLATFORM_ADMIN_IDS；多个 ID 用逗号分隔。
4. 再执行 `npm run cloudflare -- production deploy`，退出再登录验证。

不要使用本地开发超管 ID 或开发密码。`npm run admin` 仅用于本地。

## 5. 可选 Google / Apple 登录

暂不配置即可先验收邮箱密码登录。系统当前没有邮件验证、邮件找回密码能力，上线不会自动获得发信服务。

第三方登录需在渠道控制台登记正式回调：

- https://auth.adeptify.me/oauth2/callback/google
- https://auth.adeptify.me/oauth2/callback/apple

预览使用对应预览域名及独立凭据。密钥通过交互输入，不写入 Git 或命令行参数：

```sh
cd worker
npx wrangler secret put PROVIDER_STATE_KEY --config deploy/production/wrangler.json
npx wrangler secret put GOOGLE_CLIENT_ID --config deploy/production/wrangler.json
npx wrangler secret put GOOGLE_CLIENT_SECRET --config deploy/production/wrangler.json
# 启用 Apple 时另外配置 APPLE_CLIENT_ID 和 APPLE_CLIENT_SECRET
```

PROVIDER_STATE_KEY 使用密码学安全随机 32 字节的 base64url 编码，每个环境独立保存。Apple client secret 有有效期，需要安排轮换。不要在日志中打印密码、令牌或密钥。

## 6. Git 自动部署（手动上线验证后再开）

先检查并提交迁移后的代码和锁文件，排除 .wrangler、.dev.vars、.env、日志和本地数据库。本手册不会替你 commit/push。

在已创建的 Worker 的 Settings → Builds 连接 GitHub。使用以下配置，让根目录中的 wrangler.json 名称与 Worker 名称一致：

| 设置 | 预览 | 正式 |
| --- | --- | --- |
| 根目录 | worker/deploy/preview | worker/deploy/production |
| 构建命令 | cd ../../.. && npm run setup && npm test && npm run build:web | 同左 |
| 部署命令 | cd ../../.. && npm run cloudflare -- preview deploy | cd ../../.. && npm run cloudflare -- production deploy |

固定构建 Node 版本，例如 NODE_VERSION=22.20.0。预览可使用现有 cloudflare 分支；正式选择你确认过的稳定分支，不要让两者未经审核同时跟随同一开发分支。关闭不需要的其他分支自动部署，避免使用正式数据库运行分支预览。

数据库迁移由明确的发布步骤执行，不藏进普通构建命令。更改表结构前备份并验证兼容性；回滚 Worker 代码不会回滚 D1 数据。Wrangler 配置作为域名、普通变量和绑定的来源，不要只在网页修改后又被下次发布覆盖。

## 7. 上线验收与免费额度

- 登录、注册、刷新恢复、退出、换用户数据隔离。
- 团队、成员、邀请接受与拒绝、权限边界、超管入口。
- 头像上传/读取；下游 PKCE 登录、刷新和服务鉴权。
- 在 Cloudflare 观察真实 CPU 时间、错误率、D1 读写量和存储量。当前 PBKDF2 为 60 万次，免费 Worker CPU 限制是否满足必须在线验证；本地测试不代表免费环境可承载。
- 当前所有静态请求也先经过 Worker，会消耗 Worker 调用额度；后续可在保持安全响应头和路由正确的前提下优化。
- 不要直接把现有 e2e/mock 脚本指向正式站点。预览验收用测试账号；正式验收只进行明确的小范围操作。

官方参考：
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/d1/reference/migrations/
- https://developers.cloudflare.com/workers/platform/limits/
