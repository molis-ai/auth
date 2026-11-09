# Molis Auth

统一账号服务：Cloudflare Worker（Rust/WASM）与 D1，Vue 管理界面，以及面向同源 Host/BFF 的浏览器 SDK。中央 API 只使用 `/api/v2`；Auth 自己的页面使用 `/api/account`，和 Work 一样不在浏览器保存 access/refresh token 或身份验证证明。

## 当前模型

- 用户、已验证邮箱/手机、Google/GitHub 身份、密码与账号安全版本由 Auth 持有。
- 每个产品独立登录会话；刷新轮换、当前登录退出、所有产品退出均使用 V2。
- 租户使用 OWNER / ADMIN / MEMBER，与平台权限独立。`TENANT_CREATION_POLICY=SELF_SERVICE` 默认允许登录用户创建并成为所有者；`PLATFORM_ONLY` 关闭自助创建，平台仍须独立的 `TENANT_CREATE` 权限。
- 应用、登录客户端、用户可用状态、平台权限管理均有明确的平台能力、版本与幂等键，不使用部署环境里的超管用户白名单。
- 订阅、套餐、租户席位与权益继续使用现有 V2 商业模型。创建租户不附送付费权限。

V1 API、OAuth2 用户授权入口、Team/VIEWER、按应用角色排列的权限矩阵、Apple 登录、浏览器持有 Token 的 SDK 及双栈迁移工具已退出当前实现。不支持旧客户端或旧会话恢复。历史 SQL 编号与设计材料保留为历史记录，不作为另一套运行时读取或授权路径。

## 本地开发

要求 Node 22.18+、npm、Rust/WASM 构建工具（安装方式见 worker/scripts/rust-setup.mjs）。

```sh
npm run setup
npm run dev
```

`npm run dev` 只为当前检出的本地环境生成未入库的 `worker/.dev.vars` 会话加密密钥，然后构建页面、应用本地迁移和无用户种子，再启动 `http://127.0.0.1:8787`。不会连接远端 D1。MOCK 只能在明确配置的隔离环境使用；GitHub LIVE 适配沿用主线实现；Google LIVE、真实邮件和短信按外部依赖验收推进。配置或服务失败不会回退到 MOCK。本轮回归使用隔离投递和提供方夹具，不代替正式环境实测。

首次管理员可以先通过 V2 注册，再运行：

```sh
node worker/scripts/bootstrap-platform.ts <registered-v2-user-id>
```

此命令只操作本地 Wrangler D1，只允许在权限表完全为空时初始化一次。`npm run admin` 使用隔离的真实 V2 邮箱注册验证密码策略，再创建一个本地管理员；已有账号和凭据不会被覆盖。不要对已经投入使用的环境随意重建数据库。

Work 的本地客户端登记在 `worker/unified-account-local-seed.sql`，需要明确在本地数据库执行，再使用 Work 的 `MOLIS_WORK_ACCOUNT_CONFIG`。Auth 和 Work 必须使用同一版 `contracts/unified-account`；当前未发布合同的来源记录不能冒充已发布提交。

## 验证

```sh
npm test
npm run build
npm run contracts:check
```

`npm test` 包含合同校验、Rust 单测、真实 workerd/D1 的认证/租户/商业/管理集成与数据库约束、Web 和 SDK 用例。测试只创建临时数据。旧测试的职责迁移见 [V2 回归范围](docs/unified-account/v2-test-transition.md)。

真实页面专项在构建 Auth 与 Work 后运行 `MOLIS_WORK_SOURCE=/absolute/path/to/molis-work npm run test:browser`。它借用 Work 的公开 Chrome test-kit 和机器测试槽，创建临时 D1、随机端口与独立浏览器 profile，验证注册登录、租户创建、资料、再次验证、绑定邮箱、改密、会话撤销后重新登录及退出；投递明确为 mock。截图默认写临时目录，可用 `AUTH_BROWSER_EVIDENCE_DIR` 指定。该命令不访问已有浏览器或数据库，不计为 LIVE 供应商验收。

[接入手册](docs/unified-account/integration-guide.md) · [统一方案](docs/unified-account/v2-consolidation.md) · [部署](docs/cloudflare-deployment.md)
