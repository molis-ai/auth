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

要求 Node 22.18+、npm、Rust/WASM 构建工具。开发使用 `config/dev.properties` 和被 Git 忽略的 `secrets/dev.properties`。也可显式选择 test。准备本地 D1、配置凭据和登记客户端的步骤见 [Cloudflare 部署](docs/cloudflare-deployment.md)。

```sh
npm run setup
npm start -- --env dev
```

本地 dev 数据库准备好后，首次启动 Auth 会创建共享的普通预览账号。邮箱 `PREVIEW_ACCOUNT_EMAIL` 和初始密码 `PREVIEW_ACCOUNT_PASSWORD` 都从 `secrets/dev.properties` 读取。新成员从 `secrets.example/dev.properties` 复制模板后，填入团队共享的 dev 账号、密码和其余凭据。升级已有配置时，将邮箱从 `config/dev.properties` 移到密钥文件，与初始密码放在一起。每位开发者用相同账号密码登录本机的 Auth、Club 和 Work，数据各自保存在本机。重复启动会保留已有密码。test 的同名字段可记录由平台单独创建的测试账号凭据。本地启动和部署 test 均不会用它们创建或重置账号。测试账号登录仍需满足 test 白名单。prod 不读取预览账号凭据。

Auth 和产品客户端必须使用同一版 `contracts/unified-account`。开发、测试和部署的状态见 [三环境方案](docs/environment-unification-plan.md)。

## 验证

```sh
npm test
npm run build
npm run contracts:check
```

`npm test` 包含合同校验、Rust 单测、真实 workerd/D1 的认证/租户/商业/管理集成与数据库约束、Web 和 SDK 用例。测试只创建临时数据。旧测试的职责迁移见 [V2 回归范围](docs/unified-account/v2-test-transition.md)。

真实页面专项在构建 Auth 与 Work 后运行 `MOLIS_WORK_SOURCE=/absolute/path/to/molis-work npm run test:browser`。它借用 Work 的公开 Chrome test-kit 和机器测试槽，创建临时 D1、随机端口与独立浏览器 profile，验证注册登录、租户创建、资料、再次验证、绑定邮箱、改密、会话撤销后重新登录及退出；投递明确为 mock。截图默认写临时目录，可用 `AUTH_BROWSER_EVIDENCE_DIR` 指定。该命令不访问已有浏览器或数据库，不计为 LIVE 供应商验收。

[接入手册](docs/unified-account/integration-guide.md) · [统一方案](docs/unified-account/v2-consolidation.md) · [部署](docs/cloudflare-deployment.md)
