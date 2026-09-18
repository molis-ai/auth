# Google / Apple 回调接口（V1 开发中）

更新：2026-09-15。配置装配、开始/回调接口、安全链、Vue/SDK 入口、邮箱补证明和各账号关联续办已实现，**默认关闭，尚未完成真实第三方登录验收**。真实 Google/Apple 凭据及浏览器/TLS 验收待完成。测试不会替你注册开发者应用或填写真实凭据。

## 邮箱续办增量（2026-09-15）

启用 federation + mail 后，未绑定且缺少可信邮箱的第三方身份进入 `/provider-mailbox#transaction=...&continuation=...`，而非直接终止。页面立即清除地址栏片段，证明只存内存；中间身份使用独立命名空间的加密 Redis 状态保存，不保存原始 Provider Token。未启用 mail 时保持原安全失败行为。

以下均为 POST `/api/v1/auth/providers/continuation/{action}`，严格 JSON，HTTPS、精确 Auth Origin、单个 X-Auth-Transaction 及原始 HttpOnly Provider Cookie。不得把 Cookie 的值放入请求体、URL 或前端存储。每次重查原客户端/应用及 BUSY 事务归属。

| action | 严格请求体 | data |
|---|---|---|
| context | `{continuation}` | `{context,provider,expiresAt}`，不返回 subject 或 Provider 邮箱 |
| mailbox | `{continuation,email,locale}` | `{challenge}`；发送 EXTERNAL_IDENTITY 验证邮件，不返回邮件秘密 |
| complete | `{continuation,challenge,locale,confirmed:true}` | `{continueUrl}`，精确指向原事务的 `/complete` |
| cancel | `{continuation}` | `{cancelled:true}`，结束原事务并清理 Cookie |

locale 仅 en / zh-CN；confirmed 必须由页面明确点击。普通 `/transactions/mailbox` 仍不能签发 EXTERNAL_IDENTITY。邮件沿用 `/mailbox/verify` 明确确认，此动作本身不注册、不登录；用户必须返回续办页面点击“确认并创建账号”。

未验证邮箱返回 400 INVALID_PROOF，允许验证邮件后明确再次提交；不会消费仍有效的中间身份。已验证邮箱与续办状态分别原子消费，不允许自动重试结果不明的请求。期限受原 Provider 验签结果（最多五分钟）及原 Auth 事务共同约束，发邮件、刷新页面、跨节点访问都不延长。页面展示身份截止时间，邮件可能还有剩余时间也不能复活已过期身份。

注册成功后进入既有真实账号确认页，仍须确认才向客户端发授权码。取消、错浏览器、错事务、已停用应用/客户端、密文损坏、过期或重放均不注册。后续增量已将已有邮箱冲突转入原地关联确认，见下节。真实浏览器/供应商/SMTP 验收仍待完成。下文历史“邮箱中间证明未保存”由最新增量更新。

## 部署配置

### 同邮箱原密码关联续办（2026-09-15）

已有账号具备本地密码、且新第三方身份携带服务端认可的权威邮箱时，ACCOUNT_LINK_REQUIRED 现在保留加密续办状态，进入同一个 `/provider-mailbox` 页面。context 新增 `mode: LINK_PASSWORD | MAILBOX` 和 `email`（仅 LINK_PASSWORD 返回已验证目标邮箱，否则空字符串）。目标邮箱来自验签产物，前端不能提交不同邮箱或 userId。

新增 POST `/api/v1/auth/providers/continuation/link-password`，严格 `{continuation,password,confirmed:true}`；沿用 HTTPS、Auth Origin、原浏览器 Cookie、X-Auth-Transaction、五分钟证明和原事务限制。密码关联不需要启用邮件投递；邮箱补证明分支仍需 mail.enabled。

页面显示目标邮箱及提供方，用户输入已有密码并明确确认后提交。密码 KDF 在锁外执行；用户锁与凭据锁内重查账号启用状态、密码哈希未被并发重置、邮箱归属和外部身份未被占用。关联、完整认证根、Provider 回执和成功审计同数据库事务，发布前单次消费续办状态并复查客户端/应用；失败不留下半关联。不会另建用户/空间、修改密码或重分配邮箱。

密码错误返回 401 INVALID_CREDENTIALS，提交拒绝审计，不签发会话，可在 LOGIN_IP/LOGIN_EMAIL 共享限流范围内明确重试。无密码或禁用账号同样拒绝，不提供密码补建捷径。结果不明不重试。成功提交即完成关联，之后登录账号确认页的取消不会撤销关联，页面已提前说明；未提交时取消不会关联。

**后续增量已接通下面两个分支**；真实浏览器/供应商验收仍待完成。前文及后文“同邮箱原地关联未实现”的描述以此处最新状态为准。

### 已有 Google/Apple 再认证与补邮箱冲突续办

- LINK_PASSWORD 模式为兼容已交付字段名保留，现在表示“已有账号关联”，页面允许输入原密码或选择部署启用的 Google/Apple 进行原身份验证。不要求外部账号创建本地密码。
- 新增 POST `/api/v1/auth/providers/continuation/reauthenticate`：严格 `{continuation,provider:"google"|"apple",confirmed:true}`，沿用原 Cookie、X-Auth-Transaction 和 Auth Origin。返回 `{authorizationUrl}` 并设置新的独立 HttpOnly Provider Cookie。链接原续办的信息只在加密服务端状态中，不向浏览器发送其 Cookie 值。共享登录限流及最多五个待处理 Provider Cookie 约束继续执行。
- 第二次提供方回调必须证明一个已绑定在目标账号上的 issuer/subject；不使用第二次返回的邮箱查账号，不自动注册该身份。错误账号、未绑定身份、禁用账号、过期/已消费证明拒绝。原续办已取消时，第二回调不能继续关联。
- 新绑定、认证根、两份提供方证明的消费回执及成功审计同一 MySQL 事务；提交前单次消费原续办并复查客户端。成功后清理两段 Cookie，进入原账号确认页。网络、审计或发布结果不明不自动重试，不声称存在 Redis/MySQL 分布式事务。
- 邮箱补证明 complete 若发现已有邮箱，现在返回 HTTP 200 `{linkRequired:true}`，而非成功登录或终止。只有已验证邮箱证明才可进入此阶段，邮箱消费回执已提交；原第三方证明以不变的绝对截止时间进入关联阶段。读取或发邮件不延长期限，旧邮箱 challenge 不可重复完成。正常新账号仍返回 `{continueUrl}`，两种结果不能混用。
- 页面遇到 linkRequired 后读取服务端目标邮箱，显示已有账号关联方式。用户重新明确选择密码/原提供方；验证邮件本身仍不足以登录已有账号。不迁移其他账号数据、不改变邮箱归属、不新建个人空间。

选择提供方按钮已明确说明：原身份验证成功即确认关联，之后取消最终登录确认不撤销已提交的关联。用户在关联提交之前取消则不发生绑定。真实供应商认证策略、真实邮件及完整浏览器验收仍需外部联调。

使用外部配置文件或环境变量；V1 配置启动时读取，变更后协调重启所有 Auth 节点。未加入配置中心依赖。仅开启 federation 但没有可用供应商、缺少登录/Redis 开关、缺少状态密钥或供应商配置不合法时拒绝启动。

| 环境变量 | 要求 |
|---|---|
| AUTH_LOGIN_ENABLED、AUTH_EPHEMERAL_ENABLED、AUTH_FEDERATION_ENABLED | 均显式 true；federation 默认 false |
| AUTH_ISSUER | 精确 HTTPS Auth 根 origin，无尾斜杠/路径；本功能无 HTTP 开发例外 |
| AUTH_PROVIDER_STATE_KEY_ID | 当前状态加密 key id，默认名称 primary，不是默认密钥 |
| AUTH_PROVIDER_STATE_KEY | primary 对应的 32 字节随机密钥的标准 Base64；无默认值 |
| AUTH_GOOGLE_ENABLED、AUTH_GOOGLE_CLIENT_ID、AUTH_GOOGLE_CLIENT_SECRET | Google 独立启用开关及 Auth 自己的机密网页客户端注册 |
| AUTH_APPLE_ENABLED、AUTH_APPLE_CLIENT_ID、AUTH_APPLE_TEAM_ID、AUTH_APPLE_KEY_ID | Apple 独立开关、Services ID、10 位 Team ID、10 位 Key ID |
| AUTH_APPLE_PRIVATE_KEY_BASE64 | Apple P-256 私钥 PKCS#8 DER 的标准 Base64（.p8 的正文，不含 PEM 首尾行；不是把整份 PEM 再 Base64） |

扩展状态 key ring 使用外部 `auth.federation.crypto.keys.<id>`，并设置 `active-key-id`；保留旧 key 以读取最长 5 分钟的在途回调。所有节点须共享同一套 ring；原始 Google secret、Apple 私钥和状态密钥禁止放入前端、版本库、请求或日志。配置对象的 toString 脱敏，不代表外部配置系统/堆转储天然安全。

供应商端必须登记固定回调：

- Google：`<AUTH_ISSUER>/oauth2/callback/google`。
- Apple：`<AUTH_ISSUER>/oauth2/callback/apple`，不可用 localhost/IP。

端点、JWKS 和 callback 不由请求或配置中的任意 URL 覆盖。Apple 每次兑换生成 5 分钟 ES256 client_secret；ID Token 仍按 RS256 校验。当前装配密钥源是启动快照，SPI 每次读取并不等于配置中心热更新。

## 开始登录

`POST /api/v1/auth/providers/google/start` 或 `/api/v1/auth/providers/apple/start`。

- HTTPS，精确 `Origin: <AUTH_ISSUER>`，唯一 `X-Auth-Transaction`，`Content-Type: application/json`，正文 `{}`。
- 事务先通过现有 begin API 建立；产品自有登录页通过 SDK signInWithProvider 跳到 Auth `/provider`，用户确认目标应用后同源发起本步骤，不能直接用产品 origin 调用。
- 复查当前产品注册，领取 Auth 事务；响应 data 仅含 `authorizationUrl`，requestId 使用现有 envelope。不得返回 browserBinding/Google secret/Apple 私钥或用户 Token。
- Set-Cookie：每个 state 一个 `__Host-auth_provider_<state>`，随机独立绑定，Secure、HttpOnly、Path=/、无 Domain、SameSite=None、Max-Age=300。该 Cookie 只证明本次回调浏览器，不是登录会话。Cookie 规则见 [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies)。
- 发起沿用 LOGIN_IP 60 次/分钟；请求中已有 5 个在途 Provider Cookie 时返回 429 PROVIDER_TOO_MANY_PENDING，避免不断积累 Cookie。取消/完成清理对应 Cookie，超时由浏览器到期清理；用户需重新发起时不得重试旧 code。

这里没有跨域产品凭据 Cookie、隐藏 iframe 或把供应商 Token 交给产品的接口。

## 回调

Google 只接受 GET query；无正文，原始 query 最多 16 KiB。Apple 只接受 POST form-urlencoded（UTF-8），无 query，原始正文最多 32 KiB。表单按严格百分号/UTF-8 解码，拒绝重复字段（包括编码别名）、未知字段和畸形输入。state 必须 43 位 base64url；code/error 恰好一个，code 上限 4096。

Apple Origin 若存在只允许 `https://appleid.apple.com` 或浏览器不透明来源 `null`；Google 若存在只允许 Google、Auth 自身或 `null`。允许缺失/null 不构成认证，**始终还须 state、精确注册、随机浏览器 Cookie 和现有 Auth owner 匹配**。重复 Origin 拒绝。回调不提供 CORS 放行，也不依赖 Auth 登录会话 Cookie。

可选 `iss` 必须精确匹配目标供应商。Apple 回调的 unsigned `user` / `id_token` 可以接收但不作为身份来源；Google 的 query 邮箱/hd 等提示也不作为身份声明。只采信服务端 code 兑换并验证后的 ID Token。字段长度另外限制，任意 `emailVerified`、`userId`、subject 参数均拒绝。

仅接受精确 state 对应的一个 Cookie；缺失、重复或绑定不匹配不进行 Token 兑换。共享 PROVIDER_CALLBACK_IP 限流为 60 次/分钟，Redis 不可用不放行。成功或进入协调器处理的失败会删除当前短期 Cookie；畸形请求未进入协调器时，旧 state/claim 由原 TTL 收敛，不延长或恢复。

成功：303 到固定 Auth `/complete#transaction=…`，用户在 Auth 明确确认账号后继续 code/token 流程。失败：303 到固定 Auth `/login#provider-error=<安全错误码>`，不复制 code、供应商错误文本、用户资料或第三方 error_uri；提供 no-store/no-referrer/CSP，最终跳转 URL 不携带供应商响应参数。
Vue 已实现安全错误本地化、同步清理片段和明确重新开始；只在 sessionStorage 保存最多 10 分钟的非会话重开上下文，不保存原事务 secret、verifier、密码或 Token。存储失败时停止发起；未知结果不自动重试。

`/login`、`/provider` 等入口只对 GET + Sec-Fetch-Mode=navigate + Sec-Fetch-Dest=document 的顶层导航提供跨站例外，且不返回 CORS 放行。API、iframe、POST、重复 Origin 仍拒绝。
`/complete` 已改为 [显式账号确认与浏览器绑定](login-confirmation.md)：顶层加载只预览账号，明确点击并验证 Cookie/一次性证明后才发码。它现可接受相同的顶层页面导航例外；接口来源检查、绑定与供应商原有 state 检查都没有放宽。真实供应商 HTTPS/Cookie 验收仍待完成。

主要错误：PROVIDER_CANCELLED、PROVIDER_AUTHORIZATION_FAILED、PROVIDER_TRANSACTION_INVALID、PROVIDER_NOT_ENABLED、PROVIDER_UNAVAILABLE、PROVIDER_CONFIGURATION_ERROR、ACCOUNT_LINK_REQUIRED、MAILBOX_VERIFICATION_REQUIRED、RATE_LIMITED。开始接口返回对应 JSON 错误；回调统一安全重定向，限流仍附 Retry-After。ACCOUNT_LINK_REQUIRED / MAILBOX_VERIFICATION_REQUIRED 目前终止事务，不能当作最终体验或通过另建账号绕过。

## 验证边界

配置测试验证默认关闭、完整绑定、必要开关、非法密钥与固定 HTTPS 回调。`ProviderHttpRedisIT` 使用真实 Spring MVC/安全链和隔离 MySQL/Redis，供应商客户端由仅测试可用的 @TestBean 替换，返回真实测试 RSA 签名。覆盖 Google 回调至 Auth Token、Apple form_post、Cookie 隔离、重复/畸形字段、来源/方法/媒体类型/大小、取消、限流和现有密码端点不被放宽。

MockMvc 的 secure(true) 只是模拟 servlet HTTPS 标记，**不证明 TLS、真实浏览器 Cookie/SameSite、反向代理或生产多机器可用**。这些须实测；禁止为通过联调而信任任意 X-Forwarded-* 或关闭 Cookie/state 检查。测试 Provider/私钥不进入生产配置或 Jar。
# 主动绑定增量（2026-09-15）

账号安全页先显示目标 Auth userId 并要求明确确认，然后调用浏览器 SDK `bindProvider(provider, expectedUserId)`。这不是根据邮箱相同自动合并。

- `POST /api/v1/auth/providers/{google|apple}/bind`：HTTPS、Auth Origin、单个 `Authorization: Bearer <access>`、`X-Auth-Transaction`，严格空对象 `{}`；响应 `data.authorizationUrl`，并设置原有安全 Provider Cookie。
- Access 必须有 account scope，当前授权仍有效，完整认证在五分钟内；恢复 Cookie 不刷新完整认证时间。认证事务必须属于同一个客户端。无效凭据返回 401 UNAUTHENTICATED，需重新认证返回 403 REAUTHENTICATION_REQUIRED，客户端不一致返回 403 CLIENT_MISMATCH。
- 目标 user/grant/client 只由服务端凭据推导，保存在加密 Provider 事务中；不接受浏览器声明目标用户、subject 或已验证邮箱。沿用一次性 state、nonce、PKCE、绑定 Cookie 与提供方签名验证。
- 提供方回调后重新加锁核查原用户及会话。身份属于别人时拒绝 IDENTITY_ALREADY_LINKED；属于本人时不重复插入。绑定不新增用户、邮箱、密码或空间，也不迁移其他账号的数据。
- 身份插入、account.external.bind 审计、验证回执和新认证根属于同一数据库事务；验证证明不能重放重新绑定。提供方回调成功即提交绑定，随后登录确认页取消不会撤销绑定；安全页提前明确提示此语义。
- 绑定后仍需账号确认才能向客户端发授权码；网络结果不明不能自动重试提供方 code。用户重新登录后检查登录方式确认最终状态。

本增量不代表“同邮箱登录冲突原地重新认证续办”和“邮箱补证明”已完成；真实 Google/Apple 和浏览器跳转验收仍需独立完成。
