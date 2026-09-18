# 本地密码登录与顶层 Auth 交接

更新：2026-09-15。这是已实现后端 API 的接口说明，不是完整交付声明。
`/login`、`/complete`、`/verify-email` 等 Vue 认证网页已实现，可通过 web profile 打进 Jar；SDK 尚未交付，构建及浏览器证据见 [网页说明](web-ui.md)。
公开注册/重置、本人会话管理与服务鉴权已接入。Google/Apple 验签、授权码客户端、配置装配、HTTP/Cookie 边界和页面入口已实现；账号确认与浏览器绑定见 [确认协议](login-confirmation.md)。补证明/关联及真实联调仍待完成，见 [外部身份适配](external-identity.md)；邮箱流程见 [邮箱账号 API](mailbox-account-api.md)。

## 启用与信任边界

同时显式设置 `AUTH_LOGIN_ENABLED=true`、`AUTH_EPHEMERAL_ENABLED=true`，并配置独立 Auth MySQL 与 Redis。
两个开关默认 false；不提供无数据库或内存认证回退。生产要求 HTTPS；HTTP 只接受 loopback issuer 和实际 loopback 连接。
不信任任意 X-Forwarded-*；代理 TLS 终止的受信任配置仍待部署验收，不能直接放宽 HTTPS 检查。
当前 issuer 必须是 Auth 的根 origin，不能带子路径。

客户端必须预先登记为 ACTIVE，所属应用也必须 ACTIVE。回调是精确登记值；不能用尾随空格等形成别名。
登记由部署白名单管理员通过平台管理 API 完成。测试直接建立夹具，不代表允许产品任意自助注册客户端。
WEB 回调仅 HTTPS 或本机 loopback HTTP；MACOS/CLI 可用已登记的具有 host 的自定义 scheme 或安全 HTTP(S) 回调。
当前不支持任意动态端口或未登记回调。回调不能含 fragment/userinfo，也不能预置 code/state/error 查询参数。

## HTTP 接口

基础路径 `/api/v1/auth/transactions`。POST 使用 `application/json`，最多 16 KiB（也检查分块传输），不接受 URL 查询参数。
创建后通过 `X-Auth-Transaction` 请求头携带事务密钥，不把它放在 API query。
普通 API 返回 `{ "data": ..., "requestId": "..." }`；错误返回 `{ "error": { "code": "..." }, "requestId": "..." }`。
所有响应 no-store，服务端生成 X-Request-ID；不得记录密码、事务密钥、Cookie、Code 或 Token。
标准 `/oauth2/token` 保持 OAuth 表单请求与未包装响应。

| 方法与后缀 | 请求 | data 内容 |
|---|---|---|
| POST 空后缀 | clientId、redirectUri、codeChallenge、codeChallengeMethod=S256、state、scopes、forceLogin | transaction、loginUrl |
| GET /context | 事务请求头 | 已绑定 context 与 status |
| POST /password | 事务请求头，email、password | continueUrl |
| POST /restore | 事务请求头，空 JSON，Auth Cookie | continueUrl |
| POST /confirmation | 事务请求头，空 JSON，Auth 同源 | 账号预览、一次性 confirmation；设置短期绑定 Cookie，不发码 |
| POST /complete | 事务请求头，confirmation、confirmed=true，绑定 Cookie | redirectTo；需要新浏览器会话时同时设置 Cookie |
| POST /cancel | 事务请求头，confirmation，绑定 Cookie | 只取消本次交接，保留原会话 |

state 必须由客户端密码学随机生成并保存，当前校验为 22–128 个 base64url 字符；客户端必须在回调时匹配并一次性消费，不能只相信服务端回传。
PKCE verifier 由客户端保管，challenge 是其 S256；scopes 目前只能请求登记范围内的 account/profile。
forceLogin 的默认 false 仅对 WEB 有效，MACOS/CLI 服务端强制 true。

## 自定义产品登录页面

1. 产品创建 PKCE verifier/state，向 Auth 创建事务。
2. 产品自己的页面向 Auth `/password` 提交用户输入的邮箱和密码及事务请求头。密码校验成功只创建无 Cookie 的根会话；该响应不设置 Cookie，也不发 Token。
3. 页面顶层导航到 continueUrl（Auth `/complete#transaction=...`）。片段承载短期交接密钥，不能写入日志；后续 Auth 页面读取后须立即清除地址片段，不加载第三方脚本。
4. Auth 页面同源 POST `/confirmation`，展示真实账号及目标应用并建立浏览器绑定；用户明确确认后才 POST `/complete`。服务端核对双证明并消费事务，原子提交 Cookie 摘要与一次性授权码，返回已登记回调的 redirectTo。取消只终止该交接。
5. 页面跳转回产品；产品校验 state，使用原 verifier、client_id、精确 redirect_uri 和 code 向 `/oauth2/token` 兑换 Token。

托管登录复用同一事务：第二步改为顶层进入 loginUrl，在 Auth 页面输入密码。
生产 Cookie 为 `__Host-auth_session`，Secure、HttpOnly、SameSite=Lax、Path=/，无 Domain；开发 Cookie 为 auth_session_dev。
Cookie 只由 Auth 顶层同源完成步骤设置，不依赖产品域名的跨站 credentialed fetch 或第三方 Cookie。
Cookie 最长期限取根会话最初认证时间 + 90 天；服务端额外校验 30 天闲置期限。

## 恢复与原生客户端

WEB 顶层进入 Auth 后，可以同源提交 `/restore`。有效 Auth Cookie、当前客户端状态及未强制完整认证才允许复用根会话。
恢复不重设 authenticated_at 或 90 天上限；已有 Cookie 不重新签发。后续 `/complete` 创建新的应用授权会话及授权码。
MACOS/CLI 不能用 Cookie 恢复，即便请求 forceLogin=false 也必须经过完整认证；原生完成步骤不设置浏览器恢复 Cookie。
这些是协议能力，不代表原生 SDK 已交付；每次重新启动完整身份验证、不保存会话 Token 的客户端约束仍需实现和验收。
逐步接入与供应商会话语义边界见 [macOS/CLI 协议](native-client-protocol.md)。

## 来源、事务与失败处理

浏览器 CORS 只允许 Auth origin 和活动 WEB 客户端已登记回调的 origin；无通配符，不开启跨产品 Access-Control-Allow-Credentials。
通过 CORS 不是身份认证：每个事务还检查自己的客户端及回调 origin，另一个已登记产品也不能混用。
WEB `/restore` 与 `/complete` 额外要求 Origin 精确等于 Auth。没有 Origin 的非浏览器调用仍须持有事务及完成真实认证；伪造 Origin 不能替代这些凭据。
声明 cross-site 却缺少 Origin 的 API 请求仍被拒绝。仅被明确列入的登录入口页允许 GET + navigate + document 顶层导航，不授予 CORS 或接口权限。
`/complete` 已改为明确账号确认页，允许上述顶层页面导航；完成 API 仍必须 Auth 同源，且要求绑定 Cookie、一次性证明和 confirmed=true，不因页面入口放行而放宽接口。
预检仅 GET/POST 和 Content-Type/X-Auth-Transaction/Authorization。

事务密钥是 256-bit 随机值，Redis 键只保存其摘要；绑定客户端、类型、精确回调、challenge、state、scope、forceLogin 和服务端 UUID。
10 分钟原始期限不延长；READY → BUSY → AUTHENTICATED → 单次删除。错误密码退回 READY，累计 5 次后 FAILED。
原子领取阻止并发密码校验创建多个根会话；原子消费阻止多次签发授权码。无 TTL、过期和状态冲突均拒绝。
Redis 不保存密码、Cookie、Code、Access/Refresh 明文。

Redis 消费和 MySQL 提交没有分布式事务。DB 失败、进程中断或响应丢失时，不重建已消费事务，也不重试发码以恢复响应。
密码验证后未完成交接的根会话没有可用 Cookie/Code/Token；数据库发码失败时 Cookie 摘要和授权会话一起回滚。
客户端须新建事务并重新认证/正常恢复；不能把结果不确定当作成功。授权码兑换与 Refresh 响应丢失也不能盲目重试已消费凭据。

共享限流默认：创建事务每 IP 60 次/分钟；密码登录每 IP 60 次/分钟、每邮箱 10 次/分钟。
这些是待容量复核的实现值。HTTP 429 带 Retry-After；Redis/DB 故障返回 AUTH_UNAVAILABLE / 503，不伪装为密码错误。
真实测试使用独立 Redis，IP 限流键会在测试间共享；短时间反复运行可能受到真实限流，等待窗口自然到期，不执行 FLUSHDB。

## 当前证据与待办

LoginPolicyTests 覆盖来源/回调/PKCE、HTTPS、不信任转发头、分块请求上限和生产 Cookie 属性。
LoginHttpRedisIT 启动真实 HTTP + Redis + MySQL，账号由已验证邮箱的内部测试夹具建立，随后真实密码校验、事务交接、发码、Token 兑换。
覆盖密码失败上限、并发登录/完成、客户端来源隔离、期限不延长、缺失 TTL、账号禁用、DB 发码失败回滚、WEB 恢复与原生强制认证。
这是 HTTP 协议测试，测试手工构造 Origin/Cookie。Vue 网页与真实浏览器顶层恢复/回调另有独立证据，见 web-ui.md；仍不能当作生产独立主域名全链路验收。
注册/找回邮箱证明、离线常见密码检查、认证 Vue 页面与当前身份/两种退出已接通。
浏览器 SDK 核心已有协议、HTTP 与同源控制台浏览器验收；本人会话管理/审计已实现。Google/Apple 完整登录和生产独立主域名验收仍待完成，不能用基础验签测试代替。
账号与退出约束见 [自身账号 API](self-account-api.md)，SDK 用法见 [接入说明](../sdk/browser/README.md)。
