# Molis Auth — TypeScript / Cloudflare Workers

Vue 页面保持原样；新后端使用 TypeScript、Workers 和 D1。运行新版本不需要 Java、MySQL、Redis 或 Docker。
旧 Java 源码及其构建配置已移出当前工程；没有删除或覆盖旧 MySQL 数据。当前模块边界见 `../docs/architecture.md`。

## 本地启动

需要 Node.js 22.18 或更新版本。在仓库根目录执行：

```sh
npm run setup
npm run dev
```

打开 **http://127.0.0.1:8787/login**，可以直接注册新账号。
请保持 `127.0.0.1`，不要替换成 `localhost`：OAuth 回调地址采用精确匹配。
`npm run dev` 会构建现有 Vue 前端、应用本地数据库迁移、初始化 Console 应用，再启动本地 Workers。
前端修改后重新执行该命令；后端修改由 Wrangler 自动重载。

数据库持久保存在 `worker/.wrangler/`，不提交到 Git。现有 8080 Java 服务和数据与此版本隔离。

## 开发管理员

另开终端，在仓库根目录运行：

```sh
npm run admin
```

创建 `admin@example.com`，随机密码仅显示一次。可通过 `LOCAL_ADMIN_EMAIL` 和
`LOCAL_ADMIN_PASSWORD` 环境变量指定本地开发账号。这个命令仅使用本地数据库；若账号已存在，拒绝覆盖密码或接管账号。
管理员身份通过 `PLATFORM_ADMIN_IDS` 配置，不能通过普通注册自行获得。
不要将开发密码用于正式环境，也不要提交 `.dev.vars` 或实际密钥。

## 当前实现

- 邮箱、密码、确认密码注册；密码登录；独立 Console 登录和应用登录事务。
- PKCE、一次性授权码、访问令牌、刷新令牌轮换/重放撤销、会话恢复和退出。
- 个人资料、头像解码与重新编码、登录方式、登录会话和安全事件。
- 团队资料、成员、角色变更、站内邀请、待处理、归档及操作日志；搜索和分页。
- 平台管理员、应用与客户端、服务凭证、应用级角色权限矩阵及 HTTP 鉴权接口。
- Google/Apple OAuth 回调、签名与 nonce 校验、浏览器绑定、已有登录账号主动绑定身份。
- D1 事务保护、一次性状态、限流和过期临时数据清理。

继续保留本期约定：邮箱不验证、不发送邮件、不能通过邮件找回密码；仅支持站内邀请。
第三方返回已被其他账号使用的邮箱时不自动合并，需先用原有方式登录，再在账号安全中绑定。
第三方不提供可信邮箱时不创建账号；邮箱补录/验证续接流程暂不可用。

## 验证

```sh
npm run check                      # TS 类型检查及隔离 D1 / 密码 / 回调测试
npm --prefix web test              # 原 Vue 前端测试
npm run test:e2e                   # 需要本地 8787 正在运行
npm --prefix worker run test:smoke # 页面、静态资源和接口保护检查
npm run build:web
npm --prefix worker run build      # Workers 打包 dry-run，不部署
```

E2E 仅在本地生成标有 synthetic 的账号和团队，会保留在本地 D1，不读取或修改旧用户。
第三方回调测试使用模拟签名密钥和响应，不访问真实 Google/Apple 账号。

## Cloudflare 上线前仍需完成

本地可运行不等于已验证免费线上额度：当前没有部署正式 Worker，没有开通任何付费资源。

1. 在自己的 Cloudflare 账号创建独立 D1，替换本地占位 `database_id`，配置正式 `AUTH_ORIGIN`。
2. 正式环境重新初始化 Console 应用及精确 HTTPS 回调地址；不要导入本地测试账号和开发管理员。
3. 使用 Secrets 配置 `PROVIDER_STATE_KEY`（随机 32 字节的 base64url）、Google/Apple 客户端凭证；Apple 客户端 secret 需按有效期更新。
4. 在隔离预览环境验证注册、密码校验和头像处理的真实 Workers CPU/免费额度。密码仍保留原 PBKDF2-SHA256 600,000 次，没有为跑通而降低强度。
5. Google/Apple 配置正式回调并进行真实联调；测试跨应用登录、刷新、退出和角色撤销。
6. 决定是否迁移旧 MySQL 用户/团队；当前没有自动导入。确认后再做备份、转换和校验。
7. 最后再接 `auth.adeptify.me` 并切换下游应用。

密码基准 `npm run test:password` 测量的是本机 Node 时间，不是 Cloudflare CPU 计费指标。
在上述线上验证通过前，不应宣称免费 Workers 已具备生产运行保证。
