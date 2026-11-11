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
| login_sessions | 登录会话、换码、刷新轮换、活动、范围化退出与撤销 |
| registration / delivery / external_login | 邮箱手机验证、投递适配与 Google/GitHub 授权 |
| account_management / sensitive_transactions | 资料、再次验证、绑定/换绑/解绑、密码及安全撤销 |
| tenants / tenant_protocol / tenant_invitations / tenant_membership / tenant_transfers | 租户、三角色、邀请、交接与启停；成员退出通过同一事务释放席位 |
| tenant_creation | SELF_SERVICE / PLATFORM_ONLY 受信部署策略；自行创建的所有者固定为当前用户 |
| platform_management / platform_accounts | 应用/客户端、用户状态、明确的平台能力授予/回收与审计；不是旧权限矩阵 |
| billing / billing_catalog / billing_subscriptions / billing_seats / entitlements | 套餐、订阅、库存、分配历史及按真实成员/来源判定权益 |
| web_session / web_auth | Auth 同源 Cookie/CSRF、加密 BFF 会话、认证事务与敏感证明；中央写入绑定 BFF revision |
| store | 参数化 D1、原子 batch、最终写入守卫与审计 |
| security / runtime/*.js | 现行密码策略与 PBKDF2、头像实际解码清洗、Web Crypto 和受限外部 HTTP；JS 桥接不决定业务授权 |

中央事实仍在同一 D1，通过领域函数与原子 batch 协作。平台能力来自 `auth_platform_permission` 的明确授权，不因租户 OWNER 身份自动获得。付费权益不代替资源访问授权。V1 路由、根会话、OAuth2 用户授权、独立 Team 与权限矩阵实现已删除。

## 会话与安全

- 浏览器 SDK 现行导出 `AccountClient`，只调用固定同源 BFF，不自动重放写操作。Auth Vue 使用该 SDK；Work 保留满足本机边界的 Host 请求助手。
- BFF Cookie 只保存随机引用；`auth_web_session` 的 Token 和临时证明使用稳定的 `AUTH_WEB_SESSION_KEY` 加密并绑定记录 ID。写入要求 Origin/CSRF；退出提高 revision 并先清持久恢复材料，迟到的中央提交与会话保存拒绝。
- 中央 Access/Refresh Token、授权码和一次性状态只保存摘要。刷新结果不确定时不重发旧 refresh；读取或刷新不计用户活动。
- 密码使用 PBKDF2-SHA256 600,000 次，由 Workers Web Crypto 执行。无旧密码编码读取或用户映射兼容。
- 头像实际解码再编码；外部身份不按同邮箱自动合并。外部请求不跟随任意重定向，带超时与大小限制。
- SQL 文件只创建现行 V2 所需表；V1 会话、授权、成员、邀请及服务表已移除，BFF 表由 `0012_web_sessions.sql` 创建。本次只验证全新临时库，不对已有实验库升级或清理；本地体验须使用独立空库。

## 构建与验证

`npm run setup` 安装固定 Rust 1.96.0、wasm32-unknown-unknown 与 worker-build 0.8.6；不改变已有默认工具链。worker-build 位于忽略的 `worker/rust/.tools/`，Cargo.lock 纳入版本管理。

`npm test` 包括可执行合同、Rust 单元、真实 WASM + workerd + 隔离 D1、Web 与 SDK 回归。旧协议专属用例随实现删除，现行安全断言及替代覆盖见 [V2 回归范围变更](unified-account/v2-test-transition.md)。Auth 与 Work 真实页面验证、联合专项、固定基线与当前全量结果见 [V2 整合方案](unified-account/v2-consolidation.md)。

`npm run build` 构建页面和 SDK，并对 Worker 执行 dry-run。它不部署，也不证明 LIVE 邮件、短信、提供方、线上 CPU 配额或真实环境初始化已验收。正式环境配置与授权步骤见[部署说明](cloudflare-deployment.md)。
