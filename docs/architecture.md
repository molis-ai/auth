# Rust 后端工程边界

## 请求流向

浏览器 → Workers JS/WASM 加载器 → `rust/src/lib.rs` → `app.rs` → 业务模块 → `store.rs` → D1。

Vue 和 Browser SDK 不变，不导入服务端实现、不接触 D1 绑定或服务端密钥。Wrangler 的本地、预览、正式入口均为 `rust/build/index.js`，由 worker-build 生成，加载同目录的 WASM。Cloudflare 不运行原生 Rust 二进制。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| lib | fetch 入口、过期临时数据定时清理 |
| app | HTTP 方法、路由、CORS、安全响应头、静态资源 |
| identity | 请求上下文、登录事务、密码登录注册、根会话恢复、确认与授权码 |
| tokens | code exchange、Access/Refresh Token、轮换重放撤销、请求身份 |
| account | 个人资料、头像、关联方式、个人会话、安全日志 |
| teams | 团队资料、成员角色、邀请、分页搜索、团队审计 |
| platform | 超管、应用、客户端、服务凭证、用户状态、权限矩阵 |
| federation | OIDC 浏览器绑定、nonce/签名/时间校验、明确绑定外部身份 |
| authorization | 应用绑定鉴权、角色规则、资源约束、空间与动作查询 |
| store | 参数化 D1、原子 batch、写入守卫、分页和审计写入 |
| http | 输入校验、表单解析、错误码、Cookie、时间转换 |
| security | 兼容密码编码、密码策略、头像实际解码与清洗 |
| runtime/*.js | Web Crypto、随机数、受限外部 HTTP 请求桥接，不包含业务授权决策 |

## 安全与数据兼容

- 继续使用现有 D1 SQL 迁移，不重新建库或重置用户。
- 保持 URL、JSON、错误码、PKCE、Cookie 名称与令牌存储格式；密码继续 PBKDF2-SHA256 600,000 次，由 Workers 原生 Web Crypto 执行。
- Access Token、Refresh Token、授权码和一次性状态只保存摘要；刷新轮换与重放撤销由 D1 原子写入守卫保护。
- 平台超管跨团队查看不等于拥有团队成员写权限；现有边界不因换语言放宽。
- 头像由 Rust PNG 解码再编码，不信任 data URL 声称的格式。
- OIDC 不因邮箱相同自动合并账号；外部请求不跟随重定向，有超时与响应大小限制。

## 构建与验证

`npm run setup` 安装 Rust 1.96.0、wasm32-unknown-unknown、worker-build 0.8.6。不会改变已有 Rust 默认工具链；worker-build 安装在忽略的 `worker/rust/.tools/`。首次编译需要网络，后续使用 Cargo 缓存。Cargo.lock 纳入版本管理。

`npm test` 包括 Rust 单元测试、真实 WASM + workerd + 隔离 D1 集成测试、历史密码格式兼容测试，以及前端和 SDK 回归。`test:e2e` 和 `test:smoke` 仅接受本地回环地址；E2E 会创建明确标识的测试账号和团队。

旧 `worker/src/` TS 后端和专属测试已删除。后端行为测试位于 `worker/rust-tests/`，直接执行编译出的 WASM。本地超管脚本通过隔离的 Rust 注册处理器校验邮箱、密码并生成密码哈希，不再维护另一套 TS 认证逻辑。仍保留的 TS 文件用于 Vue、浏览器 SDK、开发脚本及测试，不是部署的后端。

本地/打包通过不等于线上 CPU 配额验证通过。发布前需在独立预览 D1 测试登录、刷新、邀请、头像、跨应用鉴权，并保留上一版本用于回滚；本次迁移没有修改数据库结构。
