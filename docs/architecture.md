# Rust 后端工程边界

## 请求流向

产品 Host/BFF → Workers JS/WASM 加载器 → `worker/rust/src/lib.rs` → `app.rs` → 领域模块 → `store.rs` → D1。

Auth 自身的 Vue 页面 → 同源 `/api/account` BFF → 当前 `/api/v2` 处理器。页面使用 HttpOnly Cookie 与 CSRF，不导入服务端实现、不接触 D1、中央 Token 或服务端证明。Work 的安装身份与 Home 管理共用 Host 内的 V2 会话；业务内容仍归 Work 的原 owner。

Wrangler 本地、预览、正式入口均为 `worker/rust/build/index.js`，由 worker-build 生成并加载同目录 WASM。Cloudflare 不运行原生 Rust 二进制。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| lib / app / identity / http | fetch 入口、过期临时数据清理、路由、安全响应头、请求上下文、限流及输入处理 |
| unified_contracts / unified_policy | 现行结构、环境、客户端与精确来源/回调登记；不读取旧协议策略 |
| auth/{login_capabilities, login_commands, login_sessions, management_handoff} | 登录能力、命令、会话、换码、刷新轮换、活动、范围化退出、撤销与管理交接 |
| auth/registration | 挑战生命周期、验证、事务及投递前后有效性守卫 |
| delivery / delivery/{mail_delivery, sms_auth} | 统一投递路由、阿里云邮件和短信适配；LIVE 失败不回退 MOCK |
| delivery/mail_templates | 注册、重置、绑定、更换、再次验证的邮件文案唯一来源 |
| auth/{external_login, external_login_mock, google_login, github_login, external_profile} | 外部授权、提供方适配及资料同步；不按同邮箱合并身份 |
| account_management / sensitive_transactions | 资料、再次验证、绑定/换绑/解绑、密码及安全撤销 |
| tenants / tenants/{protocol, invitations, membership, transfers} | 租户、三角色、邀请、交接与启停；成员退出通过同一事务释放席位 |
| tenants/creation | SELF_SERVICE / PLATFORM_ONLY 受信部署策略；自行创建的所有者固定为当前用户 |
| platform/{platform_management, platform_accounts} | 应用/客户端、用户状态、明确的平台能力授予/回收与审计；不是旧权限矩阵 |
| billing / billing/{catalog, subscriptions, seats, entitlements} | 套餐、订阅、库存、分配历史及按真实成员/来源判定权益 |
| web/{web_session, web_auth} | Auth 同源 Cookie/CSRF、加密 BFF 会话、认证事务与敏感证明；中央写入绑定 BFF revision |
| store | 参数化 D1、原子 batch、最终写入守卫与审计 |
| security / runtime/*.js | 密码策略与编码校验、头像实际解码清洗、Web Crypto 和受限外部 HTTP；JS 桥接不决定业务授权 |
| password_kdf | 私有、无状态的 `PasswordKdf` Durable Object，通过 RustCrypto 执行密码派生 |

中央事实仍在同一 D1，通过领域函数与原子 batch 协作。平台能力来自 `auth_platform_permission` 的明确授权，不因租户 OWNER 身份自动获得。付费权益不代替资源访问授权。V1 路由、根会话、OAuth2 用户授权、独立 Team 与权限矩阵实现已删除。

## 会话与安全

- Auth Vue 使用 `web/src/lib/account-client.ts` 导出的 `AccountClient`，只调用固定同源 BFF，不自动重放写操作。Work 保留满足本机边界的 Host 请求助手。
- BFF Cookie 只保存随机引用；`auth_web_session` 的 Token 和临时证明使用稳定的 `AUTH_WEB_SESSION_KEY` 加密并绑定记录 ID。写入要求 Origin/CSRF；退出提高 revision 并先清持久恢复材料，迟到的中央提交与会话保存拒绝。
- 中央 Access/Refresh Token、授权码和一次性状态只保存摘要。刷新结果不确定时不重发旧 refresh；读取或刷新不计用户活动。
- 密码派生由私有 `PASSWORD_KDF` 绑定调用 `PasswordKdf` Durable Object，由 RustCrypto 执行 PBKDF2-HMAC-SHA256 600,000 次，使用 16 字节随机盐和 32 字节派生值。Durable Object 使用独立的 CPU 预算，且不持久化密码、盐或派生值。派生不可用时拒绝请求，无重试或本地回退。无旧密码编码读取或用户映射兼容。线上 Durable Object 的 CPU 耗时需单独观测。
- 头像实际解码再编码；外部身份不按同邮箱自动合并。外部请求不跟随任意重定向，带超时与大小限制。
- SQL 文件只创建现行 V2 所需表；V1 会话、授权、成员、邀请及服务表已移除，BFF 表包含在[当前迁移基线](../worker/migrations/0020_auth_baseline.sql)中。新库直接应用基线，已有库按[部署手册](cloudflare-deployment.md#d1-迁移基线)核对并登记。

## 构建与验证

`npm run setup` 安装固定 Rust 1.96.0、wasm32-unknown-unknown 与 worker-build；不改变已有默认工具链。worker-build 使用 `worker/rust/Cargo.toml` 中 `worker` 依赖锁定的精确版本，安装在忽略的 `worker/rust/.tools/`，Cargo.lock 纳入版本管理。

`npm test` 包括可执行合同、两种 Cargo feature 配置的 Rust 单元测试、真实 WASM + workerd + 隔离 D1，以及包含 `AccountClient` 的 Web 回归。旧协议专属用例随实现删除，现行安全断言及替代覆盖见 [V2 回归迁移记录](history/unified-account/v2-test-transition.md)。Auth 与 Work 真实页面验证、联合专项、固定基线与当前全量结果见 [V2 整合方案](unified-account/v2-consolidation.md)。

`npm run build` 构建页面，并使用本地夹具对 Worker 执行 dry-run。部署入口使用 `build:rust:production`，编译时关闭 `mock-provider` 和 `mock-delivery`，保留线上 `test` 白名单准入。正式环境配置与授权步骤见[部署说明](cloudflare-deployment.md)。

## 浏览器认证流程边界

Vue 由 `web/src/main.ts` 和 `web/src/App.vue` 启动。界面组件、共用逻辑和样式分别位于 `web/src/components/`、`web/src/lib/` 和 `web/src/styles/`。

`web/src/lib/auth-flow.ts` 统一拥有认证面板的请求代次、弹窗与轮询定时器。取消或卸载后，迟到成功和错误均不交付给页面；迟到创建的事务通过清理回调取消。界面只编排同源 BFF 请求，不实现供应商验证码规则。Work 通过自己的账号层调用 V2，不能导入 Auth 实现或自行发送短信、邮件。

Auth 与 Work 的账号管理只提供绑定、解绑；更换账号按解绑后重新绑定完成。中央已有 REPLACE 协议尚未删除，删除需要连同公开合同及所有消费者另行核对，不能仅因界面移除就静默改变接口。
