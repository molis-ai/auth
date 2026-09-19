# Molis Auth

统一账号、团队与权限服务。当前工程为 **TypeScript + Vue + Cloudflare Workers / D1**，不再包含 Java、Maven、MySQL、Redis 或 Docker 运行配置。

## 启动

安装 Node.js 22.18+，在仓库根目录执行：

```sh
npm run setup
npm run dev
```

访问 **http://127.0.0.1:8787/login**。同一服务提供前端静态文件和后端接口。
本地数据库位于 `worker/.wrangler/`；启动不会连接线上 D1，也不会清空已存在的本地数据。
前端修改后重新启动，后端修改自动重载。完整登录验收使用 8787，不是独立 Vite 的 5173。

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
  src/
    index.ts            Cloudflare 入口
    app.ts              HTTP、安全响应头、静态资源与定时任务
    http/               路由分发与认证边界
    modules/            按业务领域组织的接口与服务
    infrastructure/     D1 访问、事务守卫、限流与分页
    security/           密码策略、密码编码、头像校验
    shared/             通用请求校验与错误类型
  migrations/           D1 数据库迁移
  tests/                后端与模块边界测试
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

本地可运行和打包通过不代表已经完成线上迁移。真实 Cloudflare 免费 CPU/额度验证、正式 D1/域名/密钥配置、Google/Apple 联调以及旧数据迁入尚未完成。
当前不发送验证或找回密码邮件；第三方缺少可信邮箱时的邮箱验证续接不可用。
部署前检查清单和本地功能说明见 [worker/README.md](worker/README.md)。
