# Molis Auth

统一账号、团队与权限服务。后端为 **Rust → WebAssembly → Cloudflare Workers / D1**；前端仍为 Vue，浏览器 SDK 仍为 TypeScript。不需要 Java、MySQL、Redis 或 Docker。

## 启动

安装 Node.js 22.18+，在仓库根目录执行（首次 setup 会下载固定版本 Rust 工具链和构建工具，需要联网）：

```sh
npm run setup
npm run dev
```

访问 **http://127.0.0.1:8787/login**。同一服务提供前端静态文件和后端接口。
本地数据库位于 `worker/.wrangler/`；启动不会连接线上 D1，也不会清空已存在的本地数据。
前端修改后重新启动，Rust 后端修改后自动编译、重载。完整登录验收使用 8787，不是独立 Vite 的 5173。

开发管理员初始化：`npm run admin`。默认账号 `admin@example.com`，新建时生成一次性展示的随机密码，也可通过 `LOCAL_ADMIN_PASSWORD` 环境变量指定。已有账号不会被覆盖。

## Cloudflare 部署

预览和正式环境已提供独立配置及初始化脚本，云端数据库 ID 需要创建后填写。完整步骤见 [部署手册](docs/cloudflare-deployment.md)。

```sh
npm run cloudflare -- preview check
npm run build:web
npm run cloudflare -- preview dry-run  # 仅打包，不发布
```

本地开发仍使用 `npm run dev`，不连接线上数据库。

## 目录说明

```text
web/                    Vue 前端（只负责页面和接口调用）
worker/
  rust/
    src/lib.rs          Worker 入口与定时清理
    src/app.rs          HTTP 路由、安全响应头、静态资源
    src/identity.rs     登录事务、根会话、授权码
    src/tokens.rs       令牌签发、刷新、撤销、请求身份
    src/account.rs     个人资料、登录方式、会话、安全记录
    src/teams.rs       团队、成员、邀请、审计
    src/platform.rs    平台管理与应用权限矩阵
    src/authorization.rs 服务端鉴权
    src/federation.rs  Google / Apple OIDC
    src/store.rs       D1 查询、分页与原子写入守卫
    src/security.rs    密码策略与头像解码清洗
    src/runtime/       Workers 原生 Web Crypto / fetch 的轻量桥接
  migrations/           D1 数据库迁移
  rust-tests/           真实 WASM + 隔离 D1 集成测试
  tests/                数据库结构及部署约束测试
  scripts/              本地管理、端到端与冒烟检查
sdk/browser/            TypeScript 浏览器 SDK
docs/architecture.md    当前模块职责与依赖规则
docs/history/           历史设计资料，不作为当前启动/部署说明
```

## 验证与构建

```sh
npm test                # 后端、前端、浏览器 SDK 测试
npm run build           # 前端 + SDK + Workers dry-run 打包，不部署
npm run format:check    # 后端代码格式检查
npm run test:e2e        # 需要本地服务运行；生成模拟账号和团队
npm --prefix worker run test:smoke
```

新增后端代码统一使用 `npm run format` 格式化。

## 上线边界

本次 Rust 改造不自动发布线上，不修改远程 D1。沿用原 D1 表结构、PBKDF2 密码格式和 API；已有 TS 版本的数据不需要因语言切换重新注册。真实 Cloudflare 免费 CPU/额度、Google/Apple 正式凭证仍需在预览环境验证，不能用本地耗时替代线上验证。
当前不发送验证或找回密码邮件；第三方缺少可信邮箱时的邮箱验证续接不可用。
部署前检查清单和本地功能说明见 [worker/README.md](worker/README.md)。
