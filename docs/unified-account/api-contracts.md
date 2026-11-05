# Molis 统一账号接口合同

状态：2026-11-04，AUTH-01 已生成可执行合同，AUTH-02 已实现存储与策略边界，AUTH-03 已实现换码、会话、刷新及退出接口；AUTH-04 已实现邮箱/手机认证事务与 mock 投递；AUTH-05 已实现 Google/GitHub mock 授权、浏览器绑定与回调；AUTH-06 已实现资料、登录方式及密码管理；AUTH-07 已实现租户、邀请、角色、交接与平台启停；AUTH-08 已实现目录发布、订阅生命周期、容量维护及商业审计；AUTH-09 已实现席位分配、回收、换绑和历史查询；AUTH-10 已实现退出/移除与席位释放原子联动及在线权益判定。产品规则以[需求文档](requirements.md)的 C-01 至 C-40 为准；本文件给出技术方案，供三个仓库按[开发任务](development-tasks.md)实现和评审。路径、字段和工程默认值已在 [AUTH-01 合同包](../../contracts/unified-account/README.md)固化为 OpenAPI、JSON Schema 与合同夹具；实际交付与未完成项见开发任务实施记录。

AUTH-12 已汇总[验收矩阵](acceptance-matrix.md)、[固定版本与交付记录](delivery.md)及[Host/BFF 接入说明](integration-guide.md)。合同保持 1.1.0，运行证据不由合同中的 CONTRACT_ONLY 标记推导。

## 1 边界与版本

中央接口使用 `/api/v2`。Auth 拥有身份、登录会话、资料、租户和成员；商业模块拥有套餐、订阅、席位和权益。首期商业模块已与 Auth 同仓库、同 D1，通过领域函数和事务协作，不跨模块散写表。Club BFF 和 Work Host 只持有本产品会话、短期事务与展示缓存，不拥有第二套商业事实。

| 合同组 | 内容 | 实现 owner |
| --- | --- | --- |
| API-01 | 通用结构、错误、版本、幂等与客户端策略 | Auth；两端适配 |
| API-02 | 产品内认证事务、验证码、Google/GitHub、令牌交付 | Auth |
| API-03 | 资料、再次验证、登录方式及密码 | Auth |
| API-04 | 独立登录会话、活动、刷新和退出 | Auth；两端持久化 |
| API-05 | 租户、成员、邀请、所有权和平台权限 | Auth |
| API-06 | 套餐、订阅、库存与席位分配 | Auth 商业模块 |
| API-07 | 当前用户的权益查询与判定 | Auth 商业模块 |
| API-08 | 产品页面到 BFF/Host 的安全适配 | Club、Work |
| API-09 | 外部 mock、环境和存量切换 | Auth 主导；三端协作 |

当前 `/api/v1/auth/transactions/*`、`/oauth2/token`、账号及空间接口的实现可复用，但不能直接照搬行为。依据见 [路由](../../worker/rust/src/app.rs)、[身份](../../worker/rust/src/identity.rs)、[令牌](../../worker/rust/src/tokens.rs)、[账号](../../worker/rust/src/account.rs)、[团队](../../worker/rust/src/teams.rs)。现有根会话退出、共享 activity、自由创建 TEAM 和仅 Auth 同源的完成流程不符合新合同。

Work/Club 新客户端由后台登记 `policyProfile=unified-account-v2`，不能由请求自行选择。旧路由也必须检查该策略；已纳管租户无论经哪个入口访问，都执行同一平台/租户权限守卫。未盘点的旧 TEAM 不自动成为本方案租户，纳管须有明确映射和平台授权。保留其他产品旧接口不意味着允许借旧接口创建或修改新租户。

## 2 API-01 通用约定

### 数据与传输

- JSON 使用 camelCase；ID 为不透明字符串，不从邮箱或昵称派生。时间为 UTC ISO 8601，时间区间为 `[startsAt, endsAt)`，服务器时间为准。
- 成功响应 `{data, requestId}`；错误响应 `{error:{code, fields?, retryAfterSeconds?}, requestId}`。`fields` 只含可公开字段错误，不回显密码、验证码、令牌、其他账号是否存在等秘密。
- `Authorization: Bearer <opaque access token>` 只由 BFF/Host 使用。私有及认证响应 `Cache-Control: no-store`。不将不透明令牌当 JWT 解码。
- 列表使用 `?limit=20&cursor=...`，上限 100，返回 `{items,nextCursor}`；游标绑定过滤条件和请求权限，不接受客户端分页绕过访问范围。
- 写操作拒绝未知字段；actor、当前 userId、clientId、applicationId、平台角色均从已验证上下文取得。输入中的 ownerUserId/memberUserId 是被操作目标，不是操作者身份。
- 可修改资源返回整数 `version`；更新、回收、转让、退出等请求带 `expectedVersion`，不匹配返回 409 `VERSION_CONFLICT`。跨资源约束在提交时重新读取，不能只校验页面读到的角色或库存。
- 管理写操作带 `Idempotency-Key`，作用域为操作者、客户端、操作与目标。相同键和相同规范请求返回同一已提交结果；同键不同请求为 409 `IDEMPOTENCY_CONFLICT`。建议保留 24 小时，客户端超过窗口先读资源再决定新操作。原子提交业务变更、幂等结果及审计。
- 幂等记录只保存请求摘要和必要的无秘密结果，不持久化原始密码、验证码、证明或 refresh；验证重试必须先识别同次已完成结果，不能因 proof 已消费而把成功操作误判成新请求。
- 重复管理请求仍先检查当前会话与资源权限，不能凭幂等键取回已无权访问的数据；API-04 的退出结果查询和 API-05 本人已完成离租户的回执是独立受限例外，不授予后续资源访问权。
- 登录码、验证凭据和 refresh 是一次性材料，不能套用普通管理操作的盲重试策略；响应丢失处理见 API-04。

### 基础视图

| 结构 | 必填字段与语义 |
| --- | --- |
| UserView | `issuer,userId,displayName,avatarUrl:null或清洗后地址,version`；邮箱不必存在，不使用占位邮箱 |
| LoginMethod | `bindingId,type:EMAIL/PHONE/GOOGLE/GITHUB,maskedLabel,verified,usableForLogin`；完整联系信息仅本人获准接口返回 |
| SessionView | `loginSessionId,applicationId,clientId,authenticatedAt,lastActiveAt,idleExpiresAt,absoluteExpiresAt,sessionRevision` |
| Scope | `{kind:PERSONAL}` 或 `{kind:TENANT,tenantId}`；个人主体始终是当前用户 |
| TenantView | `tenantId,name,status:ACTIVE/DISABLED,myRole,version`；成员身份另有 `membershipId` |
| Membership | `membershipId,tenantId,userId,role:OWNER/ADMIN/MEMBER,status:ACTIVE/LEFT/REMOVED,version` |

可操作项可以返回 `capabilities` 供页面显示；服务端每次重新鉴权，不把它作为授权凭证。停用租户只在“我的租户”中显示必要状态摘要，不能凭列表可见继续访问成员、商业详情或后续内容。

### 错误与客户端处理

| HTTP | 码及场景 | 客户端行为 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST`、`INVALID_SCOPE`、`FEATURE_UNKNOWN` | 修正输入，不自动重试 |
| 401 | `LOGIN_REQUIRED`、`SESSION_EXPIRED`、`SESSION_REVOKED`、`INVALID_CREDENTIALS`、`INVALID_GRANT` | 区分登录表单错误与已登录失效；后者清除恢复凭据并引导登录 |
| 403 | `FORBIDDEN`、`POLICY_MISMATCH`、`TENANT_DISABLED`、`REAUTH_REQUIRED` | 展示权限、停用或再次验证状态，不自动换账号/租户 |
| 404 | `NOT_FOUND` | 不暴露无权查看对象是否存在 |
| 409 | `VERSION_CONFLICT`、`CAPACITY_CONFLICT`、`IDENTITY_IN_USE`、`LAST_LOGIN_METHOD`、`OWNER_TRANSFER_REQUIRED`、`PROOF_CONSUMED`、`TRANSACTION_EXPIRED`、`IDEMPOTENCY_CONFLICT` | 重新读取或重新开始对应操作；不自动回收席位、合并账号或重放凭据 |
| 429 | `RATE_LIMITED`，附重试等待信息 | 等待后由用户重试；两端一致显示 |
| 503 | `UPSTREAM_UNAVAILABLE`、`AUTH_UNAVAILABLE` | 标记暂不可确认，不显示为无权益，不回退为 mock |

无付费权益是 API-07 的成功判定 `allowed:false`，不是登录失败。Work 将上游错误转换为本仓库 owner 错误合同，不把 Auth 的错误实现或 HTTP 状态判断复制进插件。

## 3 API-02 产品内认证事务

以下路径均相对 `/api/v2`。页面只接触本产品 API-08，BFF/Host 保存上游事务凭据和 PKCE。工程初始建议：事务 10 分钟、验证码 5 分钟且最多 5 次错误、同目标重发间隔 60 秒、登录码 60 秒、敏感操作证明 5 分钟。这些是 AUTH-01 要固化的配置默认值，不改变 C-34 的 30/90 天规则；总发送限额按 IP、目标和客户端在部署配置中明确。

| 方法与路径 | 请求 | 成功数据及约束 |
| --- | --- | --- |
| POST `/auth/transactions` | `clientId,purpose,method,redirectUri,state,codeChallenge,codeChallengeMethod:S256,initiatorChallenge`；REAUTH 另含 `operation,target`，REPLACE 另含 `bindingId`；REAUTH/BIND/REPLACE 要求当前会话 | `transactionId,status:PENDING,nextStep,expiresAt`；purpose 为 LOGIN/EMAIL_SIGNUP/REAUTH/BIND/REPLACE/PASSWORD_RESET，method 为 EMAIL_PASSWORD/PHONE_OTP/GOOGLE/GITHUB/EMAIL_CODE，校验允许组合 |
| GET `/auth/transactions/{id}` | 发起方证明 | `status,nextStep,expiresAt`；不返回身份秘密、code 或 Token，轮询不记活动 |
| POST `/auth/transactions/{id}/challenges` | `channel:EMAIL/SMS,address` | `challengeId,expiresAt,retryAfterSeconds`；目的从事务取得；找回等匿名接口不泄漏账号是否存在 |
| POST `/auth/transactions/{id}/challenges/{challengeId}/verify` | `credential` | `verificationProof,expiresAt`，仅交 BFF/Host；绑定事务、规范目标、用途和当前主体，单次使用 |
| POST `/auth/transactions/{id}/password` | `email,password` | 推进为 VERIFIED；统一错误，不泄漏账号枚举 |
| POST `/auth/transactions/{id}/email-signup` | `email,password,verificationProof` | 验证新邮箱后原子开户并推进 VERIFIED；不把“已发送邮件”当验证成功 |
| POST `/auth/transactions/{id}/phone` | `verificationProof` | 验证 +86 手机后登录或原子创建，推进 VERIFIED；新账号并发创建受唯一身份约束 |
| POST `/auth/transactions/{id}/providers/{google或github}/start` | 发起方证明，无任意上游 URL | `browserStartUrl`：固定 Auth origin 下的一次性启动地址，不含访问/刷新令牌 |
| POST `/auth/transactions/{id}/complete` | 发起方证明 | LOGIN/EMAIL_SIGNUP 返回 `{kind:LOGIN_CODE,code,state,expiresAt}`；其他用途返回相应短期证明，不能互换 |
| POST `/auth/transactions/{id}/cancel` | 发起方证明 | `status:CANCELLED`；完成与取消竞争只允许一个终态 |
| POST `/auth/token` | 授权码交换：`grantType:authorization_code,clientId,code,redirectUri,codeVerifier`；刷新见 API-04 | TokenSet 只交 BFF/Host，包括 access/refresh、accessExpiresAt 和 SessionView |

发起方随机保存 `initiatorProof`，创建时只提交其 S256 摘要；后续事务请求使用 `X-Auth-Initiator-Proof`。证明不进入页面、URL、日志或提供方。服务器校验客户端允许流程、环境、来源与精确回调；不能伪造 Auth Origin，也不能把原有同源保护删除。浏览器入口另由产品执行 CSRF/本机授权；public native client 不携带 service secret。

purpose 与步骤固定如下，未列组合拒绝：

| purpose | 允许的验证与 VERIFIED 条件 | complete 的唯一输出 |
| --- | --- | --- |
| LOGIN | EMAIL_PASSWORD 通过 password；PHONE_OTP 先验证挑战，再由 phone 登录/自动开户；GOOGLE/GITHUB 经提供方回调 | LOGIN_CODE |
| EMAIL_SIGNUP | EMAIL_CODE 挑战产生 verificationProof，再由 email-signup 验证邮箱、密码并开户 | LOGIN_CODE |
| REAUTH | EMAIL_PASSWORD/PHONE_OTP/GOOGLE/GITHUB 必须匹配当前用户已有可用方式；成功直接 VERIFIED，不创建用户 | OPERATION_PROOF，绑定 operation 与 target |
| BIND/REPLACE | EMAIL_CODE/PHONE_OTP/GOOGLE/GITHUB 只验证新目标身份；挑战或回调成功后 VERIFIED，不开户、不提前绑定 | NEW_IDENTITY_PROOF，最终写入仍需当前账号 operationProof |
| PASSWORD_RESET | EMAIL_CODE 仅验证已有账号的已验证邮箱；挑战验证成功后 VERIFIED | RESET_PROOF，仅用于 password-reset/complete |

AUTH-06 实现中，REAUTH/BIND/REPLACE 的后续事务请求同时携带原发起方证明和创建事务的同一次登录的 access token；第三方浏览器回调使用浏览器绑定，并在服务端检查该登录仍有效。受保护的邮箱/手机挑战在 verify 成功后直接进入 VERIFIED，通过查询结果的 `nextStep:COMPLETE` 完成取证明；`/phone` 仍只供 LOGIN 自动开户使用，BIND/REPLACE 不经过该步骤、不创建用户。REAUTH 邮箱密码通过 `/password`，第三方通过已有受保护回调。

`/phone` 的自动开户行为只允许 LOGIN，`/email-signup` 只允许 EMAIL_SIGNUP。challenge 的用途不能由 verify 请求改写；REAUTH 的 operation/target 作为事务创建字段固定，BIND/REPLACE 的 bindingId（换绑时）也固定。其他用途的证明不能替代登录码或互相替代。

complete 的数据按 kind 分别包含 `code`、`operationProof`、`newIdentityProof` 或 `resetProof`，并含 expiresAt；这些结果只交 BFF/Host。新账号若尚无昵称，服务端生成不包含完整手机号/邮箱的初始显示名，用户随后可编辑。

事务只允许 `PENDING → VERIFIED → CONSUMED`，以及 `CANCELLED/EXPIRED` 终态。验证凭据、事务完成和授权码交换的单次消费各自原子执行。LOGIN_CODE 绑定 client、redirectUri、PKCE、用户、登录代次和用途；用户信息不由页面输入决定。邮箱/SMS 完成直接返回 JSON，不插入 Auth 账号确认页。

Google/GitHub 流程：BFF/Host 创建事务 → 浏览器访问 browserStartUrl → Auth 建立一次性浏览器绑定并跳官方/受控 mock 提供方 → Auth 回调验证提供方 state、浏览器绑定和身份 → 回精确产品回调（仅事务结果和产品 state）→ 原 BFF/Host 用发起方证明完成并换码。提供方 state 与产品 state 分开保存；认证取消、退出或换号后的迟到回调不能建立会话。Google 验证其 OIDC 响应，GitHub 使用其可信稳定用户标识，不能假设两者都是 id_token。

AUTH-05 的 mock 实现使用 `/api/v2/auth/external/{google或github}/browser-start` 和 `/callback` 两个浏览器入口，中间经过 `/api/v2/auth/mock/{provider}/authorize`。启动票据与模拟提供方码分别有效 60 秒且一次性消费；事务仍为 10 分钟。产品回调查询参数固定为 `transactionId,state,result`（VERIFIED/CANCELLED/FAILED），不得在预登记回调 URL 中预占这三个参数，也不携带登录码或 Token。取消/失败后重新创建事务；成功后原 Host/BFF 调用 complete。模拟页面只选择服务端预置的隔离账号，不接受 subject/email 断言。官方适配器未启用时 LIVE 明确失败。配置与验收证据见[AUTH-05 实施记录](development-tasks.md#10-auth-05-实施记录)。

PASSWORD_RESET 仅向已验证邮箱对应的已有账号发出找回证明，未知目标返回等形状的投递受理结果但不创建账号。找回完成不自动签发登录码。BIND/REPLACE 的目标用户必须来自当前会话，并要求 API-03 的再次验证证明。

## 4 API-03 资料 登录方式与密码

| 方法与路径 | 输入 | 输出与权限 |
| --- | --- | --- |
| GET `/users/me` | 当前会话 | `user,loginMethods,passwordEnabled,session,platformCapabilities`；返回的应用/客户端归属须被调用方核对 |
| PATCH `/users/me/profile` | `displayName?,avatarDataUrl?,expectedVersion` | UserView；沿用真实 PNG 解码清洗，明确 `null` 为移除头像，不直接抓取任意提供方头像 URL |
| GET `/users/me/login-methods` | 当前会话 | LoginMethod 列表 |
| POST `/users/me/reauthentications` | `method,operation,target` 及 API-02 创建事务的 `clientId,redirectUri,state,codeChallenge,codeChallengeMethod,initiatorChallenge` | 受保护的 REAUTH 创建入口，调用同一个事务服务并固定 purpose；绑定当前用户和登录，不另建验证系统 |
| POST `/users/me/login-methods/bind` | `operationProof,newIdentityProof,expectedVersion` | 最新绑定列表及 user version |
| POST `/users/me/login-methods/{bindingId}/replace` | 同上；目标由路径指定 | 通过任一仍可用方式验证当前账号，再验证新方式；原子替换，新身份被占用则原绑定不变 |
| POST `/users/me/login-methods/{bindingId}/unlink` | `operationProof,expectedVersion` | 原子解绑后至少保留一种实际可登录方式 |
| POST `/users/me/password/change` | `operationProof,newPassword,expectedVersion` | `passwordChanged:true,keptLoginSessionId,session`；按 C-39 保留可信当前会话，撤销其他所有产品/设备会话 |
| POST `/auth/password-reset/complete` | `transactionId,resetProof,newPassword` 与发起方证明 | `passwordChanged:true,nextStep:LOGIN_REQUIRED`；按 C-39 撤销全部会话，不自动登录 |

`operationProof` 绑定 userId、loginSessionId、operation、目标 binding/事务、身份/会话撤销版本和过期时间，单次使用；不能换取登录 Token，也不重置 90 天起点。bind/replace 必须分别证明“当前账号归属”和“新方式归属”，不能用新手机号验证码替代当前身份验证。再次验证允许任一仍可用的已绑定方式。

EMAIL 绑定的 `verified` 与 `usableForLogin` 分开计算；有已验证邮箱且有密码才提供邮箱密码登录，无密码账号不展示“请输入旧密码”死路。无密码账号首次设置密码也走相同敏感操作合同。旧账号邮箱可信状态不因迁移提高，按 D-09 处理。

AUTH-06 的资料及绑定管理共用 UserView.version；资料更新只推进账号版本，不使已取得的再次验证证明失效。登录方式变更推进身份版本和服务器撤销边界，使旧验证证明、未完成登录事务及未换取会话的旧授权码失效，已有效的登录会话保留。管理写操作的同键重试只在当前登录仍有效且与原操作属于同一次登录时返回已提交结果；新请求不能借已消费的证明再次执行。找回完成是一次性证明消费，不套用管理写入的幂等回执。

密码更新、保留会话集合与撤销版本必须原子提交。请求不能提交任意 `exceptSessionId`；保留对象只取可信当前会话。被撤销会话的刷新、正在完成的旧授权码和重新绑定结果不得在提交后恢复它；当前保留会话仍沿原 30/90 天期限，不借改密延长登录。

## 5 API-04 会话 活动与退出

| 方法与路径 | 请求 | 返回与规则 |
| --- | --- | --- |
| GET `/sessions/current` | 当前 access token | SessionView；同时检查登录级及账号级撤销版本，不续活 |
| POST `/sessions/current/activity` | `eventId,kind:OPEN/INTERACT` | 更新后的 SessionView；不接收客户端时间、用户或另一个 sessionId |
| POST `/auth/token` | `grantType:refresh_token,clientId,refreshToken` | 原子轮换 TokenSet，不改变 authenticatedAt，不因刷新更新 lastActiveAt |
| POST `/sessions/current/logout` | 当前会话 | `revokedScope:CURRENT_LOGIN`，重复退出可返回已结束；仅撤销当前产品这次登录 |
| POST `/sessions/logout-all` | 当前会话 | `revokedScope:ALL_MOLIS_PRODUCTS`，撤销该用户全部产品和设备登录，包括请求方 |

独立登录有效截止为 `min(lastActiveAt + 30天, authenticatedAt + 90天)`。恢复、刷新、后台轮询、同步、Agent 自动任务不调用 activity。受保护产品适配层把明确的用户打开/交互送为活跃事件，Auth 去重并以服务器时间更新；这不是证明用户“人在场”的独立安全因子。

刷新只允许每个登录单飞：Work 在 Host 串行，Club 跨 Workers 实例用持久化 CAS/租约协调，不能只靠内存 Promise。旧 refresh 重放只能影响所属登录族，不能误撤销另一个产品独立登录。消费结果不确定时不重发旧 refresh；若不能取得已提交的新凭据，结束本端恢复状态并重新登录。普通管理请求可按 API-01 幂等重试，刷新不得混用该策略。

退出先冻结本端 session epoch、取消在途认证/刷新，将本次中央撤销所需凭据保留在只用于该请求的内存快照，再清除持久恢复材料；所有后续结果写回前比较 epoch，快照不允许重新登录或写回存储。中央在换码、刷新及敏感变更提交时比较用户/登录撤销版本。

全局退出/密码重设记录服务器有序撤销边界；事务创建也记录服务器序号，不能使用客户端时间。即使旧事务仍 PENDING、当时尚未识别用户，也须在识别出用户及最终提交时检查：早于该用户撤销边界的事务拒绝完成，用户须重新发起。敏感证明同样检查版本，不能在撤销后绑定或改密。

撤销端点支持有效 access，或提交仅用于撤销的 refresh 证明（当前 access 已过期时）；后者校验摘要、客户端、所属登录和期限，不签发新 Token。当前登录已结束时，只允许凭保留的摘要返回该登录 ALREADY_ENDED，不借已失效证明执行全局撤销。logout-all 要求仍有效的登录；响应丢失时可凭相同幂等键和原请求证明查询短期保留的同次撤销结果，已撤销证明仅能读取该最小结果，不能发起新的撤销或访问账号接口。无可验证结果时返回未确认，不能假报成功。

离线普通退出可返回 `{localCleared:true,remoteRevocation:UNCONFIRMED}`，不能显示已退出全部设备。全局退出须得到中央成功才可确认；连接失败显示未完成的远端结果。本地缓存身份只用于提示，不证明云会话、成员或权益有效。

## 6 API-05 租户与成员

| 方法与路径 | 请求/返回 | 权限及条件 |
| --- | --- | --- |
| GET `/tenants` | 当前用户 TenantView 列表及个人 Scope | 仅本人加入的租户；停用租户仅必要摘要 |
| GET `/tenants/{tenantId}` | TenantView、允许的管理操作 | 正常租户当前成员；平台查看走平台接口 |
| PATCH `/tenants/{tenantId}` | `name,expectedVersion` → TenantView | OWNER/ADMIN |
| POST `/platform/tenants` | `name,ownerUserId,reason` → PlatformTenantView | 平台权限；指定现有有效账号，原子建立唯一 OWNER |
| GET `/platform/tenants`、GET `/platform/tenants/{id}` | 平台范围列表/详情 | 明确平台权限，含停用记录 |
| POST `/platform/tenants/{id}/disable` 或 `/enable` | `expectedVersion,reason` | 仅平台；保留记录，不改订阅期限 |
| GET `/tenants/{id}/members` | Membership 分页 | 当前成员；按权限提供必要资料，不披露完整联系方式 |
| PATCH `/tenants/{id}/members/{membershipId}/role` | `role:ADMIN/MEMBER,expectedVersion` | 仅 OWNER；不能借此设置/移除 OWNER |
| POST `/tenants/{id}/members/{membershipId}/remove` | `expectedVersion` | OWNER 可移除非 OWNER；ADMIN 仅移除普通成员 |
| POST `/tenants/{id}/leave` | 本人 membership 的 `expectedVersion` | MEMBER/ADMIN 自行退出；OWNER 返回 OWNER_TRANSFER_REQUIRED |
| POST `/tenants/{id}/invitations` | `target:{kind:EMAIL/PHONE/USER,value}` → Invitation | OWNER/ADMIN；首期默认邀请为 MEMBER，升级 ADMIN 另走 OWNER 的角色操作 |
| GET `/tenants/{id}/invitations` | Invitation 分页，目标脱敏 | OWNER/ADMIN |
| POST `/tenants/{id}/invitations/{inviteId}/revoke` | `expectedVersion` | OWNER/ADMIN |
| GET `/invitations` | 当前账号可接受的定向邀请 | 按已验证联系方式/稳定 userId 匹配，不能只凭知道邀请 ID |
| POST `/invitations/{id}/accept` 或 `/decline` | `expectedVersion` | 登录且目标匹配；未注册先注册；接受时复核租户启用和邀请有效 |
| POST `/tenants/{id}/ownership-transfers` | `targetMembershipId,expectedVersion`（租户）→ Transfer | 仅当前 OWNER，目标是本租户有效成员 |
| GET `/ownership-transfers` | 本人发起或待本人接收的 Transfer | 不因知道 ID 获得其他租户详情 |
| POST `/ownership-transfers/{id}/accept` 或 `/cancel` | `expectedVersion` | 接收人本人接受/原 OWNER 取消；提交时复核双方成员与当前 OWNER |

Invitation 含 `invitationId,tenantId,targetSummary,status:PENDING/ACCEPTED/DECLINED/REVOKED/EXPIRED,expiresAt,version`。Transfer 含 `transferId,tenantId,fromMembershipId,toMembershipId,status:PENDING/ACCEPTED/CANCELLED/EXPIRED,expiresAt,version`。建议邀请默认 7 天、交接默认 24 小时，作为 AUTH-01 的工程配置；过期和撤销不能建立成员或变更所有者。

交接接受必须原子把目标变 OWNER、原 OWNER 变 MEMBER，按 C-40 保留原所有者已有席位；后续晋升 ADMIN 由新 OWNER 执行。租户始终恰好一个 OWNER；过期、失效、重复确认或接受时已离开的目标不能接管。

离开/移除原子结束成员关系、释放其在该租户全部当前席位分配、推进权益版本并审计；不能让前端先删除成员再单独调用回收。释放包括到期/停用订阅仍保留的 ASSIGNED 分配，结束原因为 MEMBER_LEFT/MEMBER_REMOVED，个人订阅和其他租户不变。退出后再次加入创建新的 membershipId，历史分配关联旧 membership，不自动恢复；新成员版本从同一用户在该租户的历史最大版本加一继续，拒绝旧页面带旧 expectedVersion 的退出请求。租户停用会拒绝所有成员业务及管理操作，平台恢复入口仍可用；保留记录但没有永久删除接口。

AUTH-07 与 AUTH-10 已开放本节接口，返回形状以可执行合同为准。成员列表仅含 ACTIVE 成员；本人邀请列表仅含当前身份匹配、未过期且租户启用的 PENDING 邀请。管理员的租户邀请列表保留历史状态，交接列表按仍有效的参与成员关系查询。列表使用服务端保存的随机游标，有效 15 分钟，绑定用户、客户端、路由、页大小及当前管理权限/成员版本；每次请求及最终返回前复核权限。

邀请匹配当前已验证邮箱、手机号或稳定 userId；通知不是入租户凭据。EMAIL/SMS 在 LOCAL/TEST 的显式 MOCK 模式中写入独立通知 outbox，USER 邀请从本人邀请列表读取，不触发外部发送。已有 ACTIVE 成员接受邀请时沿用原 membershipId 和角色；历史成员重新加入时建立新 membershipId。写操作的业务变化、审计、24 小时幂等回执及 mock 通知在同一事务中提交，读取回执前仍检查当前权限。OWNER 退出/被移除返回 OWNER_TRANSFER_REQUIRED；ADMIN 仅可移除普通 MEMBER，OWNER 可移除非 OWNER 成员。成员结束时同时取消涉及该成员的待确认交接。实现与验证见[AUTH-07 实施记录](development-tasks.md#12-auth-07-实施记录)及[AUTH-10 实施记录](development-tasks.md#15-auth-10-实施记录)。

本人已成功 leave 的同键、同请求重试，可在仍有效的原用户/客户端会话下取回本人旧成员的 LEFT 结果；仍须租户启用、该旧成员确为对应版本的 LEFT。它不要求已离开的成员仍 ACTIVE，不返回其他租户数据，也不会退出后来重新加入的成员。移除他人的回执仍要求操作者当前具备对应管理权限。新的幂等键按当前成员和版本处理，不复用历史操作。

## 7 API-06 订阅与席位

### 结构与状态

| 结构 | 字段 |
| --- | --- |
| Feature | `featureId,product:WORK/CLUB/SHARED,name`；稳定标识，首期隔离环境使用明确标注的测试功能项 |
| PlanVersion | `planId,planVersion,name,personalFeatureIds[],seatTypes:[{seatTypeId,name,featureIds[]}]`；版本发布后不可原地修改权益集合 |
| Subscription | `subscriptionId,owner:{kind:USER/TENANT,id},planId,planVersion,enabled,startsAt,endsAt,version`；个人订阅没有席位数量 |
| SeatPool | `subscriptionId,tenantId,seatTypeId,quantity,assignedCount,availableCount,version`；按订阅和类型独立计量 |
| Assignment | `assignmentId,subscriptionId,seatTypeId,membershipId,userId,status:ASSIGNED/ENDED,assignedAt,endedAt:null或时间,endReason:null或RELEASED/REASSIGNED/MEMBER_LEFT/MEMBER_REMOVED,version` |

订阅显示状态由 enabled 与时间计算为 SCHEDULED/ACTIVE/EXPIRED/DISABLED，不能把“EXPIRED”当删除指令。`ASSIGNED` 表示保留当前分配，不表示当前享有权益；订阅到期/停用时仍占容量。历史 ENDED 不占容量。`availableCount=quantity-assignedCount`，到期库存也不能因未提供权益而被重复分配。

个人订阅及租户分配的全部有效来源按功能并集判定，不按套餐名猜升级/降级关系。套餐变更显式选择版本，不自动改变旧订阅内容；未接支付，不创建订单、金额或付款状态。

### 中央接口

所有商业写入使用 API-01 的版本和幂等约定；平台写入必须有 reason，操作者和时间由服务器记录。

| 方法与路径 | 请求或返回 | 权限 |
| --- | --- | --- |
| GET `/catalog/plans`、GET `/catalog/features` | 可用套餐版本/功能定义 | 当前用户；展示不代表开通权益 |
| POST `/platform/catalog/features`、POST `/platform/catalog/plans/{planId}/versions` | Feature/PlanVersion 定义 | 平台；引用合法，版本不可覆盖；测试功能配置与正式清单分开 |
| GET `/users/me/subscriptions` | 本人个人订阅列表 | 本人 |
| GET `/tenants/{id}/subscriptions` | 租户订阅及类型摘要 | 当前有效成员；管理权限另判 |
| GET `/tenants/{id}/seat-pools` | SeatPool 列表 | OWNER/ADMIN；普通成员只读本人分配及权益 |
| GET `/tenants/{id}/seat-assignments?state=current或history` | Assignment 列表 | OWNER/ADMIN 可读租户范围，MEMBER 只读本人；服务端固定范围，不能前端加 userId 绕过 |
| POST `/platform/subscriptions` | `owner,planId,planVersion,startsAt,endsAt,seatQuantities?,reason` | 平台开通；租户需已存在；起止时间有效，各类型引用合法 |
| GET `/platform/subscriptions`、GET `/platform/subscriptions/{id}` | 平台查询及停用租户内的记录 | 平台 |
| PATCH `/platform/subscriptions/{id}` | `plan?:{planId,planVersion},startsAt?,endsAt?,enabled?,seatQuantities?,expectedVersion,reason` | 平台变更；plan 成对指定可跨套餐；未提交字段保持不变，不自动延期或换绑 |
| POST `/platform/subscriptions/{id}/renew` | `endsAt,expectedVersion,reason` | 延长原订阅到期时间；类型/数量不变时沿用保留分配，不恢复 ENDED；停用状态不因续期自动启用 |
| POST `/tenants/{id}/seat-assignments` | `subscriptionId,seatTypeId,membershipId,expectedVersion`（池） | OWNER/ADMIN 分配；目标是有效成员；相同池不重复给同一 membership 占多个席位 |
| POST `/tenants/{id}/seat-assignments/{assignmentId}/release` | `expectedVersion,reason?` | OWNER/ADMIN；结束当前分配，释放库存 |
| POST `/tenants/{id}/seat-assignments/{assignmentId}/reassign` | `targetMembershipId,expectedVersion,reason?` | OWNER/ADMIN；原子结束旧分配并创建新分配，数量不短暂超额 |
| GET `/tenants/{id}/audit-events`、GET `/platform/audit-events` | 操作、目标、时间、结果及允许披露的前后状态 | 租户 OWNER/ADMIN 仅本租户；平台按平台权限；不含凭据 |

首期建议只在有效且启用的订阅下新分配或换绑；到期/停用订阅允许管理者回收保留分配，便于减量和类型调整。该工程限制写入 AUTH-01 合同夹具；不影响续期沿用规则。停用租户仍拒绝租户成员管理操作；确需回收时先由平台恢复租户，不新增平台代替成员随意分配的权限。

`seatQuantities` 为该订阅完整的目标 `{seatTypeId:quantity}` 映射；PATCH 不提供则不变，提供后未保留的旧类型视为删除并执行回收前置检查。跨套餐变更也按稳定 seatTypeId 判断类型是否相同，不按显示名自动匹配；plan、容量及版本原子更新。

### 原子约束

| 操作 | 提交前必须满足 | 提交结果 |
| --- | --- | --- |
| 分配/换绑 | 租户启用、管理员权限仍有效、目标成员有效、池容量足够、版本一致 | 新分配与旧分配结束（若有）同事务，推进用户/租户权益版本 |
| 减量 | 各类型新数量不低于全部 ASSIGNED 数，含到期保留 | 不替管理者挑人回收；失败时所有池和订阅不变 |
| 删除/替换类型 | 受影响类型的 ASSIGNED 已全部回收 | 未变类型沿用，结束的历史不映射到新类型 |
| 改套餐/期限/启停 | 平台权限、版本和目标合法 | 显式修改字段，保留审计，按新有效来源重新计算 |
| 成员离开/移除 | 当前成员版本和管理权限仍有效 | 结束该租户所有当前分配，个人订阅不变 |
| 续期 | 新到期时间有效且更晚，类型/数量不变 | 保留有效成员的当前分配；已结束历史不恢复 |

同一 D1 内以事务/受控原子 batch 维护这些约束；并发请求的胜者成功，另一方返回版本/容量冲突并重读。前端串行执行多个请求、事后补库存或定时清理都不能替代一致性保证。所有订阅、成员、租户状态变化均推进判定所依赖的版本。

AUTH-08 已实现功能和套餐目录发布/查询、本人及租户订阅查询、平台开通/查询/变更/续期、席位池查询及本模块商业审计。单份订阅的停用和恢复通过 PATCH 的 `enabled:false/true`，没有额外启停路径。目录只追加发布，旧版本不能覆盖；新版本可以为同一稳定席位类型使用新的名称，名称随套餐版本留存。个人订阅拒绝 `seatQuantities`；租户开通必须提供完整目标映射，允许空映射或零容量。

更换套餐时，未提交 `seatQuantities` 会保留原映射；如果旧类型不在新套餐中，应明确提交目标映射，否则拒绝请求。移除类型将池标记 RETIRED，保留历史；重新增加同类型只恢复库存，不恢复 ENDED 分配。容量检查在最终事务中再次执行；AUTH-09 已接入分配/回收/换绑并与容量变更联合验证，AUTH-10 已完成成员退出时的全量释放及权益判断。

订阅状态依服务端当前时间计算，区间为 `startsAt <= now < endsAt`，disabled 优先显示 DISABLED。平台可以在停用租户下开通及维护订阅，但不会恢复租户访问或自动顺延。商业审计接口当前返回 `auth_management_audit` 中的目录、订阅和席位事件，旧身份/租户审计仍在原有审计存储中。公开 changes 是受长度限制的摘要，完整目录定义、订阅前后值、容量映射与操作原因保存在审计记录中。实施与验证见[AUTH-08 实施记录](development-tasks.md#13-auth-08-实施记录)。

AUTH-09 的分配/回收返回 `SeatMutationResult {assignment,pool,entitlementRevision}`，换绑返回 `SeatReassignResult {endedAssignment,assignment,pool,entitlementRevision}`。新分配请求的 expectedVersion 是池版本，回收/换绑的是原分配版本；每次成功操作都推进池和相关权益版本。重复操作需沿用原 Idempotency-Key，不能把“原分配已 ENDED”误认为同键重试失败；权限和租户状态仍按当前事实检查。

当前列表默认 `state=current` 仅含 ASSIGNED；`state=history` 仅含 ENDED。普通成员按本人 userId 查询，仍须是该租户当前有效成员；游标绑定 state，不能从当前列表切换过滤条件继续翻页。新分配/换绑最终提交复核数据库时间、订阅版本、当前池、目标有效成员/账号及容量；回收允许原受益成员或账号失效。停用租户一律禁止成员操作。实施及容量联合验证见[AUTH-09 实施记录](development-tasks.md#14-auth-09-实施记录)。

## 8 API-07 权益判定

`POST /api/v2/entitlements/check` 请求：`{scope,featureIds:[...]}`，建议最多 100 项。主体、产品与客户端来自可信会话，不接受 `subjectUserId` 或“已购买”字段。功能 ID 必须在服务端目录存在，并符合调用产品的范围。

成功返回：

```json
{
  "data": {
    "scope": { "kind": "TENANT", "tenantId": "tenant_example" },
    "evaluatedAt": "2026-11-04T08:00:00Z",
    "revision": "opaque-entitlement-revision",
    "decisions": [{
      "featureId": "demo.shared-feature",
      "allowed": true,
      "reason": "GRANTED",
      "validUntil": "2026-12-01T00:00:00Z",
      "sources": [{ "kind": "PERSONAL_SUBSCRIPTION", "subscriptionId": "sub_example" }]
    }]
  },
  "requestId": "request_example"
}
```

`reason` 为 GRANTED/FEATURE_NOT_GRANTED；允许的 sources 为 PERSONAL_SUBSCRIPTION 或 TENANT_SEAT（含订阅、类型和 assignmentId）。来源只表达当前用户自己的授权，不暴露其他租户或用户数据。订阅失效、未分配等细节由本人订阅/席位页面解释。用户未登录返回 401，非成员隐藏租户存在性，停用租户返回 403 TENANT_DISABLED；这些不是“缺少某项付费权益”。

计算顺序：校验会话及产品 → 校验 Scope 和成员/租户状态 → 读取有效个人订阅 → 在租户范围追加本人当前有效分配 → 按功能取并集。个人范围不计任何租户席位；租户甲的席位不能流入乙。管理角色本身不增加付费功能。

`validUntil` 是此次结果的最早已知时间边界（保守取相关来源的下一到期/生效点以及会话截止），不是可离线持有的许可证。成员撤销或配置变更可以更早使结果失效；重新查询读取最新事实，断网只显示“暂不可确认”。首期不把本结果接到 Work 动作付费拦截，也不拿它授权共享内容；后续内容权限仍由资源 owner 核对。

AUTH-10 实现使用服务端 `auth_client_product` 明确登记当前客户端的 WORK/CLUB 产品，只允许该产品或 SHARED 的目录项；未登记客户端返回 403 POLICY_MISMATCH，未知或其他产品功能返回 400 FEATURE_UNKNOWN。不从客户端名称、前端参数或套餐名推断产品。0011 迁移仅建表，不自动登记旧客户端；本地可选 seed 显式登记隔离客户端，不覆盖已有登记。

`revision` 是当前用户、客户端、产品、Scope、所请求功能列表、来源及相关版本的不可解读摘要；不同功能批次的摘要不能互相比较或拼成一份全局版本。同样的事实和会话读取保持稳定，跨生效/到期边界即使没有数据库写入也会改变。返回前原子复核当前会话、客户端登记、成员、租户及商业版本和时间边界，竞争变化返回 409 VERSION_CONFLICT，调用方重新查询。`validUntil` 同时不超过本次 access、会话最长/闲置截止；没有有效来源的否定结果也受未来订阅生效时间约束。完整来源超过合同或查询上限时返回 503 AUTH_UNAVAILABLE，不截断来源后给出部分判断。验证见[AUTH-10 实施记录](development-tasks.md#15-auth-10-实施记录)。

## 9 API-08 两产品适配合同

两端使用相同 AccountView 和业务 DTO，可以有不同展示样式。下表以 `/api/account` 表示产品操作合同，Club 由固定 BFF 路由承接；Work 的非凭据管理操作经既有动作网关映射到账号动作提供方，不另加一套平行业务 HTTP 路由。认证/会话窄协议入口由 Host 保护。两端都不提供允许任意上游 URL、路径、头或主体的代理。

| 产品接口 | 输入/输出与转接 |
| --- | --- |
| GET `/api/account/session` | `{state:ANONYMOUS/AUTHENTICATED/OFFLINE_CACHED/EXPIRED, user?,session?,capabilities?}`；禁止返回 access/refresh、PKCE、上游证明 |
| POST `/api/account/auth/transactions` | 页面 `purpose,method,returnTo?`；BIND/REPLACE 另带本地 `reauthHandle`，REPLACE 带目标 `bindingId`；产品决定 client、环境、回调、PKCE及发起方证明，返回本地 opaque handle、nextStep、期限 |
| POST `/api/account/reauthentications` | 已登录页面 `method,operation,target`；适配层补公共事务字段，校验受支持操作及目标，返回受保护 REAUTH 的本地 handle |
| GET `/api/account/auth/transactions/{handle}` | 仅发起浏览器/Host 返回公开状态、nextStep、期限，不返回上游 proof/code，不续活 |
| POST `/api/account/auth/transactions/{handle}/submit` | 按下表的 step 联合类型处理，不接受任意上游 operation；上游证明保存在适配层 |
| POST `/api/account/auth/transactions/{handle}/resend`、`/cancel` | 仅本发起方的事务；返回最新可公开状态 |
| GET `/api/account/auth/callback` | 只接受已登记回跳的事务结果与 state，验证后由适配层完成上游换码；returnTo 只允许站内路径 |
| POST `/api/account/activity` | `eventId,kind`，适配层以当前会话转交；后台取 session 不更新活跃 |
| POST `/api/account/logout` | `scope:CURRENT_LOGIN/ALL_MOLIS_PRODUCTS`，返回本端清除及中央撤销结果，不伪报远端成功 |
| `/api/account/profile`、`/login-methods/*`、`/password/*` | 固定映射 API-03；页面通过本地 reauth handle，不能自行提供 operationProof/userId |
| `/api/account/tenants/*`、`/invitations/*`、`/ownership-transfers/*` | 固定映射 API-05，Scope 显式随请求传递 |
| `/api/account/subscriptions`、`/tenants/{id}/seat-*`、`/entitlements/check` | 固定映射 API-06/07；版本、幂等键和结构化错误保留，禁止本地计算最终授权 |
| `/api/account/platform/tenants/*`、`/platform/subscriptions/*` | 在产品内为平台人员提供固定操作入口，中央验证平台权限；不因租户 OWNER 而开放 |

产品 SDK/适配层只把字段映射到已登记操作。未列出的批量、删除、代登录、账号合并、付款和数据共享接口不属于本期。两个页面的 Scope 不应通过一个全局“当前租户”可变值相互覆盖；页面偏好不构成权限事实。

| submit.step | 页面输入 | 返回及适配层行为 |
| --- | --- | --- |
| REQUEST_CHALLENGE | `address` | `challengeHandle,expiresAt,retryAfterSeconds,nextStep`，不返回原始验证码/邮件链接 |
| VERIFY_CHALLENGE | `challengeHandle,credential` | 验证结果及 nextStep，verificationProof 只保存在适配层 |
| PASSWORD_LOGIN | `email,password` | 公开事务状态，不返回 Token |
| EMAIL_SIGNUP | `email,password` | 使用同事务已验证邮箱的证明，不接受更换为未验证目标 |
| PHONE_LOGIN | 无额外身份字段 | 使用已验证手机证明，只有 LOGIN 允许自动开户 |
| START_PROVIDER | 无任意授权地址或身份字段 | `browserStartUrl`，来自 Auth 固定环境并由产品校验后交浏览器桥 |
| COMPLETE | 无额外身份字段 | 适配层完成/换码后返回 AccountView 或 `operationReady:true`，证明留在服务端 |

绑定/换绑最终产品请求使用 `reauthHandle,identityHandle,bindingId?,expectedVersion`，改密用 `reauthHandle,newPassword,expectedVersion`，找回用 reset 流程 handle 和 newPassword；适配层验证 handle 所属浏览器/Host、当前用户、用途、目标与 epoch，再取出中央证明。页面不能通过替换 handle 引用别人的再次验证结果。REAUTH 的 operation 限定 BIND_METHOD/REPLACE_METHOD/UNLINK_METHOD/CHANGE_PASSWORD，target 形状在 AUTH-01 Schema 中按操作固化。

### Club

BFF 使用同源、HttpOnly、HTTPS 下 Secure、SameSite=Lax、Path=/ 且不设 Domain 的随机产品会话 Cookie；本地 HTTP 使用隔离 Cookie 名。浏览器关闭后可恢复，Cookie 有效期不超过中央会话截止。服务器只存 Cookie 摘要，令牌在服务端加密保存；不能只把中央用户 ID 装进可自造 Cookie。

普通写请求校验同源 Origin 和会话绑定 CSRF，匿名认证事务也绑定发起浏览器；OAuth 回调使用专用 state/事务验证。BFF 请求中央前核对 issuer/applicationId/clientId，私有业务请求复核中央会话状态；全局撤销不能因为本地缓存而继续访问留言等受保护操作。多个 Workers 实例共用刷新协调与撤销版本。

旧 `user.id` 继续作为留言外键，新增唯一 `(issuer,authUserId) → localUserId` 映射，同时约束同一 localUserId 只能有一个有效中央账号映射。并发认领不能让两个中央账号共享旧业务身份。缺少可靠映射时不按邮箱自动接管；新无邮箱用户按新用户流程建立本地业务映射，不能误替换旧用户。历史 `notes.user_id` 和作者记录不批量重写；联系表 email 不是身份凭据。

### Work

建议新增 `horizontal/account` 作为 Auth 客户端与会话协调 owner，合同归 `packages/contracts`；Host 装配服务并注入公开 SecretStore。工作台内提供页面，桌面只承担系统浏览器/回跳桥。凭据型协议使用窄认证入口，不登记为可被 Agent/MCP 调用的普通动作，也不进入动作记录；非凭据的成员/商业管理能力按现有动作目录注册一次，页面和其他获授权入口复用同一合同，不额外开放自动调用权限。

Host 校验 loopback、Host/Origin、本机控制令牌及一次性写键；回调是单独受约束的协议入口，不豁免整个账号 API。PKCE、发起方证明和恢复凭据按环境、issuer、client 和 Home 隔离保存，浏览器与桌面共享同一个 Host 登录。当前登录用户来自 Host 会话，而本地 `LOCAL_PERSON_ACTOR_ID` 保持原义。

管理动作返回前及本地状态写回前检查会话 epoch/调用撤销；需要网络的动作声明并发并遵循现有 beforeEffect 约束。UI 的密码和验证码只短暂提交到可信认证入口，不向插件暴露。账号、Scope 变化不切 Home，不导入 personal 分支按账号分区的数据路径，不同步或上传本地内容。

## 10 API-09 外部适配与环境

| 端口 | 输入与输出 | mock 和真实接入边界 |
| --- | --- | --- |
| SmsSender | `deliveryId,toE164,templateKey,templateData,expiresAt` → `ACCEPTED/providerMessageId` 或确定失败 | Auth 生成验证码；mock 仅投递到隔离测试设施，支持成功/失败/超时夹具 |
| MailSender | `deliveryId,to,templateKey,templateData,expiresAt` → 同上 | 注册验证、绑定、找回等模板用途分开；不在正常接口/业务日志返回链接或验证码 |
| ExternalIdentityProvider | `start(serverContext)` → 固定允许域授权 URL；`consumeCallback(serverContext,response)` → 可信 `issuer,subject,email?,emailVerified?,profile?` | Google/GitHub 分别验证响应；mock 输出限定测试身份，仍走状态绑定和消费；页面不能自报可信 subject |

发送的 ACCEPTED 只表示投递已受理，不是手机/邮箱已验证。超时或重复投递不产生第二个验证机会，验证码消费仍只有一次；供应商调用不能回写业务授权。模拟模式在启动配置和请求处理两层限制于隔离环境/测试数据，不可因真实服务缺配置或失败自动回退。

按 C-36 至 C-38 先使用本地/隔离测试地址。配置清单包括 `authOrigin,productOrigin,clientId,policyProfile,redirectAllowlist,providerMode,deliveryMode,environmentId`；实际密钥只以环境绑定/密钥引用注入。开发中的固定回调和原生 loopback 规则仍须校验，不使用任意通配符。真实域名、短信签名模板、发信域名、OAuth 应用和精确回调在后续真实联调前落实。

模拟账号、成员、订阅和席位通过受控测试夹具及正式管理服务建立，不能用“测试入口直接写已付费”绕过商业规则。对外部 mock 的验证与对中央真实服务的验证分别标记，真实发送和官方授权证据后补。

## 11 切换与合同交付

旧账号按 C-14/C-35 保留并重新登录。P0 盘点身份、验证状态、密码格式、供应商稳定标识、旧 TEAM 与业务外键；凭据格式和冲突事实未查明前，不承诺批量复制密码或自动合并同邮箱。Work/Club 停止接受旧会话的切换不能撤销其他产品会话；旧密码接续与旧会话接受是两件事。

AUTH-01 的落地交付应包含：OpenAPI 3.1、请求/响应与错误 JSON Schema、上文 purpose/method 联合类型、权限矩阵、版本与幂等约定、脱敏夹具和变更记录。Rust 与两端 TypeScript 使用同一合同样本校验；禁止三个仓库分别维护可漂移的账号枚举。Auth 的接口升级不自动要求 Work 将内部 HTTP 合同原样导出给外部插件。

合同验收对应[需求验收表](requirements.md#10-验收标准)。认证链路需证明拒绝、失败和竞态，而不只是页面成功；商业链路需用实际持久化数据证明权限与功能并集。实现拆分及完整覆盖见[开发任务](development-tasks.md)。
