# Auth 工程架构

## 请求流向

产品 Host/BFF → Workers JS/WASM 加载器 → `worker/rust/src/lib.rs` → `app.rs` → 领域模块 → `core/store.rs` → D1。

Auth 自身的 Vue 页面 → 同源 `/api/account` BFF → 当前 `/api/v1` 处理器。页面使用 HttpOnly Cookie 与 CSRF，不导入服务端实现、不接触 D1、中央 Token 或服务端证明。Work 的安装身份与 Home 管理共用 Host 内的 V2 会话；业务内容仍归 Work 的原 owner。

Wrangler 本地、预览、正式入口均为 `worker/rust/build/index.js`，由 worker-build 生成并加载同目录 WASM。Cloudflare 不运行原生 Rust 二进制。

## Worker 模块职责

`worker/rust/src/` 根目录保留 `lib.rs` 和 `app.rs`。带子模块的目录使用各自的 `mod.rs` 作为入口，由 `clippy::self_named_module_files` 检查。`app.rs` 分发请求并维护请求生命周期，普通业务路由由对应域匹配与处理。HTTP 通用工具放在 `core/http.rs`。

| 路径 | 职责 |
| --- | --- |
| `core/` | HTTP、请求上下文、D1、事务守卫、加密、密码派生、就绪检查及定时清理 |
| `core/contracts/` | 公共合同结构与环境策略校验 |
| `core/management_protocol.rs` | 管理列表的参数、筛选与游标格式，排序列和可接受的筛选值由调用方传入 |
| `auth/` | 认证能力、登录注册、外部登录、中央会话、管理交接和敏感操作二次验证 |
| `auth/management_access.rs` | 管理请求的会话、平台权限及团队成员资格检查，绑定授权快照、游标和幂等写入 |
| `auth/{sync_read_proof,test_admission}.rs` | 依赖当前中央会话的同步读证明，以及依赖已验证身份的测试环境准入 |
| `account/` | 个人资料、登录方式、密码及账号会话管理 |
| `team/` | 团队、角色、创建策略、成员、邀请和所有权交接 |
| `internal/` | 私有服务入口的中央会话、团队成员和平台审计权限核验 |
| `platform/` | 平台用户和权限、团队治理、应用及登录客户端管理 |
| `audit/` | 统一管理审计写入与平台、团队审计查询 |
| `delivery/` | 邮件与短信投递、供应商适配和模板 |
| `web/` | 同源 Cookie/CSRF、浏览器会话、网页认证事务、账号 BFF |
| `web/upstream.rs` | 同源上游挂载、会话转发和响应校验，订阅与账单挂载到独立 Billing Worker |
| `runtime/internal-transport.js` | 命名入口鉴权、固定服务绑定与安全请求头 |
| `web/assets.rs` | 网页入口、规范域名跳转、静态资源和缓存 |
| `web/readiness.rs` | 存活响应与就绪探针，核对 D1 结构和 Web 客户端环境配置 |
| `web/http.rs` | HTTP 请求日志标签、错误响应和响应后置处理 |
| `runtime/*.js` | WASM 调用的运行时适配层。模块路径同时供 wasm_bindgen 和 Worker 测试引用 |

`core/` 不引用入口或业务域。 浏览器会话用 `app::handle_internal` 在同一 Worker 调用中央 v1 API，并传递会话访问约束和原请求 ID。业务域的通用请求体和响应头处理使用 `core/http.rs`。跨域调用使用明确的领域入口，如 `audit/mod.rs` 导出的审计读写接口及 `auth/` 下的会话和管理授权模块。业务数据的访问规则由对应领域维护，新增跨域协作时复用其接口和事务守卫。

中央事实仍在同一 D1，通过领域函数与原子 batch 协作。平台能力来自 `auth_platform_permission` 的明确授权，不因团队 OWNER 身份自动获得。付费权益不代替资源访问授权。旧版根会话、OAuth2 用户授权、团队 API 与权限矩阵已退役。

## 会话与安全

- Auth Vue 使用 `web/src/shared/api/account-client.ts` 导出的 `AccountClient`，只调用固定同源 BFF，不自动重放写操作。Work 保留满足本机边界的 Host 请求助手。
- 无 Cookie 时读取会话状态不访问 D1。浏览器发起认证写入时才创建会话行。HTTPS BFF Cookie 使用 `__Host-` 前缀并只保存随机引用。`auth_web_session` 的 Token 和临时证明使用稳定的 `AUTH_WEB_SESSION_KEY` 加密并绑定记录 ID。写入要求 Origin/CSRF；退出提高 revision 并先清持久恢复材料，迟到的中央提交与会话保存拒绝。
- 中央 Access/Refresh Token、授权码和一次性状态只保存摘要。刷新结果不确定时不重发旧 refresh；读取或刷新不计用户活动。
- 密码派生由私有 `PASSWORD_KDF` 绑定调用 `PasswordKdf` Durable Object，由 RustCrypto 执行 PBKDF2-HMAC-SHA256 600,000 次，使用 16 字节随机盐和 32 字节派生值。Durable Object 使用独立的 CPU 预算，且不持久化密码、盐或派生值。派生不可用时拒绝请求，无重试或本地回退。无旧密码编码读取或用户映射兼容。线上 Durable Object 的 CPU 耗时需单独观测。
- 头像实际解码再编码；外部身份不按同邮箱自动合并。外部请求不跟随任意重定向，带超时与大小限制。
- Auth D1 保存身份、会话、团队和平台管理等 Auth 数据。新库通过 [D1 单基线](cloudflare-deployment.md#d1-迁移基线)创建。账务数据与接口归独立 Billing Worker，见[同源转发说明](account-billing-bff.md)。

## 构建与验证

`npm run setup` 安装固定 Rust 1.96.0、wasm32-unknown-unknown 与 worker-build；不改变已有默认工具链。worker-build 使用 `worker/rust/Cargo.toml` 中 `worker` 依赖锁定的精确版本，安装在忽略的 `worker/rust/.tools/`，Cargo.lock 纳入版本管理。

`npm test` 包括可执行合同、两种 Cargo feature 配置的 Rust 单元测试、真实 WASM + workerd + 隔离 D1，以及包含 `AccountClient` 的 Web 回归。旧协议专属用例随实现删除，现行安全断言及替代覆盖见 [V2 回归迁移记录](https://github.com/molis-ai/auth/blob/bfcc70c70cf7dd54761f245c86fdc48d323006f7/docs/history/unified-account/v2-test-transition.md)。Auth 与 Work 真实页面验证、联合专项、固定基线与当前全量结果见 [V2 整合方案](https://github.com/molis-ai/auth/blob/bfcc70c70cf7dd54761f245c86fdc48d323006f7/docs/unified-account/v2-consolidation.md)。

`npm run build` 构建页面，并使用本地夹具对 Worker 执行 dry-run。部署入口使用 `build:rust:production`，编译时关闭 `mock-provider` 和 `mock-delivery`，保留线上 `test` 白名单准入。正式环境配置与授权步骤见[部署说明](cloudflare-deployment.md)。

## Web 模块职责

`web/src/main.ts` 启动 Vue。`App.vue` 组装工作台壳子、导航和全局提示，`app/use-account-session.ts` 管理会话代次、账号刷新及跨页写入反馈。

| 路径 | 职责 |
| --- | --- |
| `shared/` | 同源 API 客户端、游标集合、幂等提交、共享组件和基础样式 |
| `features/auth-entry/` | 登录、注册、找回密码、语言偏好及认证流程 |
| `features/account/` | 个人资料、账号安全、登录方式、密码及登录会话 |
| `features/team/` | 我的团队、成员与待处理 |
| `features/billing/` | 订阅与账单、账本详情及账单类型 |
| `features/platform/` | 平台用户与权限、团队、应用与客户端、审计 |

领域专属组件、工具、类型和样式随领域放置。依赖方向为入口 → 领域 → 共享层。跨领域复用从对方的 `index.ts` 获取明确导出的入口，经架构测试登记。目前账号安全复用认证流程，团队复用账单面板。多个领域共享且没有领域规则的代码才移入共享层。前后端目录与依赖守卫由 `npm test` 执行。

`features/auth-entry/auth-flow.ts` 拥有认证面板的请求代次、弹窗与轮询定时器。取消或卸载后，迟到成功和错误均不交付给页面，迟到创建的事务通过清理回调取消。Work 通过自己的账号层调用 V2。

Auth 与 Work 的账号管理只提供绑定、解绑；更换账号按解绑后重新绑定完成。中央已有 REPLACE 协议尚未删除，删除需要连同公开合同及所有消费者另行核对，不能仅因界面移除就静默改变接口。
