# 开发进度与验证记录

更新：2026-09-15。总体状态：进行中，尚不可作为正式身份服务接入。

## 最新增量：剩余两条关联分支（2026-09-15 15:10）

- 原账号仅 Google/Apple 登录的再认证已接通：页面明确选择原有提供方，新独立 state/nonce/Cookie 链接加密原续办；回调只接受已绑定到目标账号的 issuer/subject，不用第二次返回的邮箱选账号，不注册第二身份或创建密码。
- 补邮箱后冲突已接通：邮箱证明消费并记录后，complete 返回 `{linkRequired:true}`，同页转入原密码/原提供方关联。目标邮箱来自服务端验证证明，绝对身份截止时间不变，旧 challenge 不复用，不直接认证已有账号。
- 两份提供方证明的回执、新绑定、认证根和成功审计同数据库事务，发布失败回滚。取消原续办后第二回调不能关联；错账号、未绑定身份、重放、过期和密文移植失败安全。成功后清理两段 Cookie，仍走最终登录账号确认。
- LINK_PASSWORD 模式名为兼容既有接口保留，现在页面同时提供密码和已有第三方选择；新 reauthenticate 接口严格要求 confirmed:true。结果不明无自动重试，不延长原证明有效期，仍限制待处理 Cookie 数量与共享登录限流。
- 最终 15:09:52 +08 全量 web,browser-sdk,java-sdk,full-it verify 成功：114 单测、299 集成、45 Vue、27 浏览器 SDK，共 485 项，零失败/错误/跳过。新增 5 项 HTTP、2 项双证明事务、1 项阶段期限测试及 2 项前端测试。此前 15:06 首轮通过后补充最终期限复查及旧状态兼容，再次全量通过。
- 使用独立 MySQL 43316 / Redis 46390、46391，未新增数据库迁移，V15 校验通过。测试提供方签名和邮件 transport 仍是离线替身；独立 Java 模块历史 28 项不计入本轮 485 项。
- **这两条关联分支已完成代码与自动化回归，不等于整个 V1 已验收。** 剩余完整 OpenAPI（已核对仓库仍无 OpenAPI 文件）、完整真实浏览器/Google/Apple/SMTP/mTLS 联调、独立 HTTPS 与生产多机器/故障恢复验收。后文历史“关联分支未完成”由本节更新。

## 最新增量：同邮箱原密码关联（2026-09-15 13:55）

- 权威第三方邮箱遇到已有账号时，保留受保护续办并展示 LINK_PASSWORD 模式。用户输入原账号密码，明确确认后关联到原账号；目标邮箱只从验签产物读取，拒绝前端替换邮箱/userId。不会另建用户/个人空间，不修改密码。此分支不要求启用邮件投递。
- KDF 在锁外完成，用户/凭据锁内复核启用状态、当前密码哈希、邮箱归属、身份和回执。关联、认证根及成功审计同事务；发布前单次消费续办并复查客户端。密码重置竞态、审计/发布失败都不能留下半关联。
- 密码错误记录拒绝审计，不签发会话；在 Redis LOGIN_IP/LOGIN_EMAIL 限流内允许明确重试。前端清除密码输入，不持久化密码/续办秘密，结果不明不自动重试。提交完成关联后仍需登录账号确认；页面明确说明后续取消登录不撤销关联。
- 13:55:26 +08 web,browser-sdk,java-sdk,full-it 全量回归通过：114 单测、291 集成、43 Vue、27 浏览器 SDK，共 475 项，零失败/错误/跳过。新增 8 项集成、1 项前端测试。修正配置装配单测缺少新依赖替身的问题，未放宽生产校验。
- 使用隔离 MySQL 43316 / Redis 46389；V15 重复校验通过，无新迁移。独立 Java 模块未修改，其历史 28 项不计入本轮 475 项。
- **关联仍未全部完成**：原账号仅 Google/Apple 登录的原地再认证、补邮箱后才发现冲突的关联续办尚未接通。上述分支仍需原方式登录后主动绑定。完整 OpenAPI、真实浏览器/供应商/SMTP/mTLS 和生产多机器验收也仍待完成。

## 最新增量：邮箱续办接口与页面（2026-09-15 13:41）

- 同时启用 federation/mail 后，缺少可信邮箱的已验证第三方身份进入 `/provider-mailbox`。新增短时加密 Redis 中间证明，绑定原浏览器 Cookie、原 Auth 事务与 owner，跨节点可读并单次消费，不保存原始 Provider Token。
- context/mailbox/complete/cancel 四个严格 POST 接口及双语 Vue 页面已接通。邮箱验证不能自动登录或注册；用户返回原页明确继续后才原子创建账号，随后仍需既有账号确认才发授权码。无需额外设置密码。
- 提前点击只拒绝未验证证明并保留合法续办；错浏览器/事务、密文移植、过期、停用客户端、取消、并发重放不注册。发邮件和读取不延长提供方证明或原事务期限。结果不明不自动重试。
- 13:40:43 +08 全量 web,browser-sdk,java-sdk,full-it verify 通过：114 单测、283 集成、42 Vue、27 浏览器 SDK，共 466 项，零失败/错误/跳过。新增 6 项 HTTP/真实 Redis/MySQL/邮件 Outbox 链路测试、4 项跨 Redis 连接加密状态测试、4 项前端流程测试。Provider 签名和邮件 transport 是离线测试替身，MockMvc HTTPS 标记不是生产 TLS 证据。
- 本轮修正了 Node strip-only 不支持的 TypeScript 参数属性和测试邮件投递访问方式，未放宽生产安全边界。使用专用 MySQL 43316/Redis 46388；本轮未新增数据库迁移（V15 校验通过）。独立 Java 模块未变更，历史 28 项不计入本轮总数。
- **仍未完成**：同邮箱冲突原地完整认证后的关联续办；完整 OpenAPI；真实浏览器、Google/Apple、SMTP、mTLS 与生产多机器部署验收。当前同邮箱冲突不合并，页面提示先用已有方式登录再主动绑定。本增量取代下文“邮箱续办尚无接口/页面”的历史状态。

## 最新增量：邮箱补证明后端基础（2026-09-15 13:24）

- EXTERNAL_IDENTITY 独立证明用途、VERIFY_EXTERNAL_IDENTITY 双语邮件模板；与本地注册/重置用途双向隔离。普通公开邮箱请求明确拒绝该新用途，尚未开放 Provider 续办接口。
- 内部 ExternalMailboxAccounts 组合真实 Redis 消费和 MySQL 原子注册。只能使用验签产物与服务端邮箱证明，不创建本地密码，不以邮箱占有证明登录/合并已有账号。
- V15 新增邮箱消费回执；新账号/邮箱/个人空间/Owner/外部身份/认证根/审计/通知与回执同事务。已有邮箱冲突只返回 ACCOUNT_LINK_REQUIRED 并记录消费，不签发已有账号会话。提供方证明期限不因邮箱补验证延长。
- 新增 8 项双证明集成测试、1 项公开接口用途拒绝测试、1 项双语邮件单测，覆盖过期/未验证/错用途/错事务、防重放、并发、审计及发布失败回滚；Redis 已消费证明不恢复。
- 最终 13:23:54 +08 完整 web,browser-sdk,java-sdk,full-it verify 通过：114 后端单测、273 集成、38 Vue、27 浏览器 SDK，共 452 项，无失败/错误/跳过。V14→V15 迁移及重复校验通过；使用专用 MySQL 43316 和 Redis 46386/46387，未使用日常数据服务。独立 Java 模块未修改，28 项历史验证不计入本轮 452 项。
- **这不是用户可用的邮箱续办功能。** 待开发：加密/短时/浏览器绑定的提供方中间证明；邮箱请求/继续/取消接口与页面；同邮箱已有账号完整认证后的续办关联。现有公开回调遇到这两类情况仍终止，不把内部基础误报为已交付。
- 完整 OpenAPI、真实浏览器/Google/Apple/SMTP/生产部署验收仍未完成。下一切片优先串起上述续办状态与 HTTP/页面闭环。

## 最新增量：主动绑定（2026-09-15 12:35）

- Auth 账号安全页新增 Google/Apple 主动绑定确认，浏览器 SDK 新增 bindProvider；提供方启用配置决定可选按钮。
- 从最近五分钟完整认证的 account Access 推导目标用户及客户端；将目标加密保存到一次性提供方事务。回调再次加锁核查用户/原会话/客户端、身份归属及验证回执，不以邮箱相同自动关联，也不重新分配邮箱。
- 已属于其他账号的身份拒绝绑定。新增绑定、审计与认证根写入同事务。成功后仍走登录账号确认；安全页明确告知提供方验证成功即提交绑定，后续取消登录不撤销绑定。
- 12:35:16 +08 全量 web,browser-sdk,java-sdk,full-it verify 成功：113 后端单测、264 集成、38 Vue、27 浏览器 SDK，共 442 项本轮测试，无失败/错误/跳过。独立 Java 模块沿用此前未变更模块 28 项验证，不计入本轮 442 项。使用隔离 MySQL 43316 和 Homebrew Redis 46385。
- 新增回归覆盖 Google/Apple 绑定、不新增邮箱、回调重放、原会话撤销、他人身份归属冲突、无效 Access、SDK 账号变更/跨域限制/凭据持久化/非法跳转/结果不明不重试。
- 仍未完成：登录中同邮箱冲突重新认证续办、邮箱补证明、完整 OpenAPI、完整真实浏览器验收、真实提供方及 SMTP 联调和生产部署验收。以下历史记录中“主动绑定未实现”由本节更新。

## 最新增量：登录方式与解绑（2026-09-15 11:55）

- 账号安全页新增本人登录方式列表及外部身份解绑确认，不返回 issuer/subject 或任何凭据。
- 解绑要求当前会话完整认证时间在五分钟内（实现默认值，Cookie 恢复不刷新该时间）；过期返回 REAUTHENTICATION_REQUIRED，页面提供强制完整认证入口。
- 用户行锁内重查当前身份、目标归属和最后可用方式；未启用的外部提供方不计入可用替代方式。本地密码凭据或已启用的其他已绑定身份必须至少保留一种。
- 解绑、本人所有 Auth 根/应用会话撤销和 account.external.unlink 审计同事务；审计失败全部回滚。成功后 SDK 仅清理本地登录态，不再发送失效凭据的退出请求。不退出 Google/Apple 自身账号。
- 完整 clean + web,browser-sdk,java-sdk,full-it 于 11:55:19 +08 通过：113 单测、260 集成、38 Vue、24 浏览器 SDK，加此前独立 Java 模块 28 项，共 463 项。新页面尚未进行真实浏览器验收。
- Homebrew Redis 8.10.1 已安装（用户批准临时中科大镜像，未改永久配置）。用实际安装二进制启动隔离 46384，PING 返回 PONG；12:16:27 +08 再次通过 web,browser-sdk,java-sdk,full-it 全量回归（113 单测、260 集成、38 Vue、24 浏览器 SDK，独立 Java 28 项沿用未变更模块的已验证结果，共 463 项）。未设置登录自启动；本轮测试实例用后停止。开发说明见 local-redis.md。
- 仍需开发：主动绑定、同邮箱重新认证关联、邮箱补证明、完整 OpenAPI；以及页面、外部服务和生产部署验收。以下历史清单中“解绑未实现”已由本节更新。

## 本轮增量（2026-09-15）

- V14、平台邮件列表和确认重发页面：部署白名单授权、仅失败通知、保留原始记录、一次人工重发批次、并发/重复提交去重、入队审计原子回滚。验证邮件不能重发旧证明。
- 服务认证拒绝审计（不写声明的身份或凭据）；服务 Token 签发与授权检查接入共享 Redis 限流，故障关闭。**新增运行要求：服务端签发和鉴权也必须启用 AUTH_EPHEMERAL_ENABLED 并配置 Redis，否则返回 503。**
- 双身份显式用户活动 API 和 Java SDK 方法：只更新当前授权及父会话闲置时间，绝对期限不变，与审计同事务；普通鉴权/刷新不自动调用。
- 空间详情及 Vue 页面展示服务端当前角色的固定权限规则、允许/拒绝和原因；说明应用目录和资源/目标角色限制仍需单独执行。
- 最终完整回归于 2026-09-15 10:27:59 +08 通过：113 后端单测、258 集成测试、36 Vue 测试、24 浏览器 SDK 测试；独立 Java 模块另有 28 项测试通过，共 459 项，零失败/错误/跳过。V14 迁移及重跑已验证。
- 命令：`./mvnw -B -ntp -Pweb,browser-sdk,java-sdk,full-it '-Dauth.it.jdbc-url=jdbc:mysql://127.0.0.1:43316/auth_test_6j3Z04_fresh?connectionTimeZone=UTC' -Dauth.it.redis-port=46380 verify`；Java 模块为 `./mvnw -B -ntp -f sdk/java/pom.xml verify`。测试用隔离 MySQL/Redis，不使用日常数据库。
- 前次补跑发现测试归档使用过期空间版本，已改为读取成员加入后的当前版本；多轮共享 Redis 触发真实邮件小时配额，最终用全新隔离 Redis 重跑。未放宽生产版本检查或限流，也未把失败轮次计为通过。

### 当前真正剩余的工作

1. 账号关联各分支、邮箱补证明、主动绑定/解绑及最后可用方式保护已实现；仍需完整真实浏览器和供应商验收，不能用测试签名/MockMvc HTTPS 标记代替真实联调。
2. 完整 OpenAPI 交付及覆盖核对。
3. 已实现页面的完整浏览器提交验收，包括新增邮件管理与权限展示、注册/找回、跨账号邀请、管理操作；真实 Google/Apple/SMTP 联调。
4. 生产独立域名 HTTPS、可信代理、多机器、容量/故障恢复验收；真实 mTLS 联调。

Owner 转移按用户决定首期不做；原生 App/CLI、GoalBoard 改造不在本期交付范围。后文历史切片中的“尚未完成”以本节为准；测试通过不等于 V1 已完成。

最新切片已接入 Provider 默认关闭配置、HTTPS HTTP/Cookie 边界、Vue 确认/取消/重开页和 SDK signInWithProvider；macOS 协议说明见 native-client-protocol.md。
用户已确认 Auth 增加账号确认步骤。`/complete` 现只预览真实账号，需明确点击并验证浏览器 Cookie 与一次性证明才发码；跨来源 SDK 密码登录、确认返回和取消保留原会话已通过实际浏览器验收。详见 login-confirmation.md，生产 HTTPS/多机器验收仍待完成。
此外，邮箱补证明/同邮箱关联、主动绑定解绑、真实 Google/Apple/SMTP 和部署验收仍未完成。后文按切片保留历史记录；最新状态以此处及“下一实施切片”为准。

## 已落地

- 决策基线：auth-v1-plan.md；未改 GoalBoard。
- Spring Security/Authorization Server 依赖与默认拒绝的服务安全边界；开放健康检查与受协议校验保护的 POST /oauth2/token。
- 256-bit 随机 Token 与 SHA-256 摘要基础函数（不用于密码）。
- 30 天闲置、90 天绝对期限的会话规则；刷新不自动延长用户活动时间。
- 固定角色权限规则，以及邀请/改角色/移除/离开/交接的目标角色限制。
- MyBatis、MySQL 驱动、Flyway；账号、已验证邮箱、本地凭据、外部身份、空间和成员的 V1 迁移。
- V2 迁移：应用、公共登录客户端、精确回调登记、浏览器认证会话、每应用授权会话及 Token 哈希链路。
- SessionService 真实持久化实现：首次签发、刷新轮换、重放撤销、用户/应用绑定、单会话/全部退出、
  账号禁用、身份读取及显式用户活动更新。所有 Cookie/Access/Refresh 仅持久化摘要。
- V3 迁移及生产 Token 端点：授权码仅保存摘要，绑定唯一认证事务、客户端、精确回调及 PKCE S256；
  授权码消费与首对 Token 签发同事务，重复兑换撤销该授权会话。
- 公共客户端刷新适配：保留 NONE 身份，生产请求使用 MySQL 事务轮换，不依赖 JVM 锁或明文 Token 存储。
- V4 迁移及 LocalAccountService：邮箱验证后的原子注册、密码登录、邮箱验证后的密码重置。
  注册同时创建用户/邮箱/密码凭据/个人空间/Owner、操作回执、审计和邮件任务；重置同时更新密码、撤销全部会话并写审计/邮件任务。
  操作回执支持跨节点幂等；同一回执不能换邮箱或跨注册/重置用途使用。
- RedisMailboxProofs：真实 Redis Lua 原子签发、验证、消费；用途/原事务绑定，10 分钟期限不延长，链接及事务 Secret 只存摘要。
- RedisRateLimiter：跨实例固定窗口限流原语，服务端固定初始规则；故障或损坏状态默认拒绝，无本机放行回退。
- VerifiedMailboxAccounts：真实 Redis 验证结果进入真实 MySQL 注册/重置事务；现已接入客户端绑定的公开注册/找回 HTTP 入口。
- V5 迁移、邮件投递器与 MailboxMailService：受保护的验证邮件排队、双语模板、共享发送限流、租约/有限重试、开发收件箱与 SMTP 适配。
  邮件确认 HTTP 入口和 Vue 确认页面已接入，真实 SMTP 待完成。详见 mail-delivery.md。
- 登录 HTTP 入口：Redis 认证事务绑定客户端、精确回调、PKCE S256、state 与 scopes；本地密码验证、Auth 顶层交接、WEB Cookie 恢复、原生强制完整认证。
  事务原子领取/消费、共享创建/密码限流、客户端来源隔离、CORS、JSON 上限与安全错误响应已接通。
  Cookie 摘要附加与授权码签发在同一 MySQL 事务，默认开关关闭；认证页面已接入，详见 login-protocol.md。
- MailboxAccountCoordinator/Controller：公开发信、显式 POST 确认、注册及密码重置；原认证事务与证明用途绑定，禁止通过任意邮箱/userId 绕过证明。
  注册后接既有授权码/Token 链路；重置撤销所有会话且不自动登录；真实 HTTP + 开发收件箱联动已验证，见 mailbox-account-api.md。
- 新密码离线整值阻止列表：固定 SecLists 快照和随 Jar 分发的许可证，支持外部追加 SHA-256 文件；配置损坏启动失败，旧密码登录不受列表更新影响。
- Vue 3/TypeScript/Vite/Element Plus 双语认证页面：登录、注册、找回、明确邮箱确认、Auth 交接；仅邮箱/语言可本地记忆，事务/邮件 secret/密码均不持久化。
  Maven web profile 运行 npm ci、前端测试、类型检查、生产构建，静态产物随同一个 Jar 分发；CSP/no-referrer/no-store 与缺失资源 503 已测试。
  真实浏览器已验证密码错误、登录、Cookie 恢复和独立来源本机接收器 PKCE 兑换，完整边界见 web-ui.md。
- V6 审计上下文、当前身份与两种退出 HTTP API：唯一 Bearer/account scope、本人目标派生、客户端 Origin 绑定、锁内当前状态校验。
  撤销与审计同 MySQL 事务；当前退出保留其他授权及 Auth 根会话，全部退出撤销本人所有根/授权会话，见 self-account-api.md。
- 框架无关浏览器 TypeScript SDK 核心：托管/自定义密码登录、PKCE/state 回调、内存 Token、并发刷新合并、当前身份及两种退出。
  仅待处理 PKCE/state 与暂停恢复标记使用 sessionStorage；丢失消费型响应不自动重试，退出结果区分本地清理与服务端撤销确认。
  browser-sdk profile 运行独立 npm ci/test/build，打包清单仅 JS/类型声明/说明/package.json；未发布 npm，真实 SDK/浏览器/服务联合验收待完成。
- BrowserSdkRedisIT：实际编译 JS SDK 调用真实 Spring HTTP、Redis/MySQL，验证登录、兑换、身份、并发刷新、当前/全部退出及根会话恢复；导航与 Cookie 转发由夹具驱动，不代替浏览器策略验收。
- V7 服务身份三表、独立 ServiceIdentityService 与标准 Client Credentials：服务 Secret/Token 仅摘要持久化，5 分钟不透明 Token，无 Refresh。
  凭据创建/轮换/禁用与审计原子提交；认证后签发前重查、应用/服务/凭据当前状态校验、用户/服务 Token 隔离、503 故障语义已测试，见 service-identity.md。

- V8 应用动作目录和决策审计、三个双身份授权 HTTP API：check、allowed-actions、spaces。
  同事务核对用户/服务身份、应用、会话、动作目录和成员；分页前 SQL 过滤，拒绝/允许与审计原子提交，无最终决策缓存，见 authorization-api.md。
- V9 平台配置版本和审计字段、部署 userId 白名单及平台管理 HTTP：应用/权限目录、精确登录客户端、服务凭据、用户启停、全局审计分页。
  用户身份与白名单检查、修改和审计同事务；版本冲突拒绝覆盖，用户/应用/客户端停用撤销及恢复不复活已验证。
  管理员停用与在途请求精确竞态、服务轮换审计回滚、平台身份不越权读取业务空间有真实 HTTP/MySQL 证据；见 platform-api.md。
  不提供首用户自动提权或管理页授权管理员。
- V10 控制台公共客户端初始化：部署显式开启、数据库锁串行多实例启动，应用/客户端/回调/审计原子创建，不创建用户、密码、Secret 或管理员。
  重启不覆盖修改或恢复停用配置；7 项实际 MySQL/HTTP 测试覆盖并发、回滚和拒绝接管。
- 双语 Vue 平台控制台与独立 SDK 集成：应用/客户端/凭据/用户/审计界面、版本确认、单次 Secret 提示、普通用户 userId 显示、顶层恢复与两种退出。
  已在真实浏览器完成同源密码登录/恢复/退出、空白名单隔离、应用创建/更新及审计读取，390px/1280px 布局检查通过；见 console.md。
- 独立 Java HTTP 客户端、Spring Boot Starter 和最小 MyBatis/MySQL 业务示例：服务 Token 内存缓存/并发合并，双身份授权/动作/全部空间范围调用，严格响应验证、错误脱敏、限时限量传输和无重试/重定向。
  不保存用户 Refresh、不安装业务安全过滤器、不依赖 Auth 数据库；支持外部凭据和 mTLS 传输适配点。27 项模块测试及 6 项真实 Auth/业务 HTTP/MySQL 合同测试已通过，见 sdk/java/README.md。

FixedPermissionPolicy 仍是角色层纯规则；AuthorizationService 已组合当前用户/服务、应用目录和空间校验。
目标成员限制和空间写入事务已接入 SpaceService；真实业务后端仍须执行授权结果，不能由角色层 Allow 替代这些约束。
AccountMapper 是存储层操作，不是注册 API；公开注册只通过 MailboxAccountCoordinator 消费实际邮箱证明进入 LocalAccountService。
SessionService 是可信认证流程调用的内部引擎：createAuthentication 只能在完整身份验证之后调用；
生产 Token 端点通过 exchangeCode 原子消费授权码并签发 Token，不先单独调用 issueInitial。
createAuthorizationCode/completeAuthorization 只能由完成身份验证的可信内部流程调用；新登录入口只接收事务密钥和真实密码/已有 Auth Cookie，不接收任意 userId/sessionId。
不得暴露成凭 userId/sessionId 发 Code 或 Token 的 HTTP 接口。

## 邮箱账号业务层边界

LocalAccountService.registerAfterMailboxVerification/resetPasswordAfterMailboxVerification 只能由完成邮箱验证的
可信流程调用。operationId 是服务端验证流程的标识，不是验证码、用户身份凭据或任意客户端幂等键。
调用前必须验证并消费限定邮箱、用途、事务和期限的证明；VerifiedMailboxAccounts 已接通 Redis 证明消费，
验证链接已接开发收件箱投递，公开注册/重置现已接入 Authentication Transaction、共享限流和显式邮箱确认；内部服务参数仍不可直接暴露。
AccountWorkflowIT 预置邮箱验证前置条件；MailboxWorkflowRedisIT 使用真实 Redis 证明但从测试夹具取得邮件 Secret，仍不构成真实邮件验证证据。

密码校验在数据库锁外进行，成功后重新锁用户并核对当前密码哈希；期间密码重置或账号禁用时不能用旧状态创建新会话。
未知邮箱、纯外部账号、错误密码和禁用账号均返回内部 INVALID_CREDENTIALS，未知或不可用凭据也执行一次密码 KDF。
失败登录审计单独提交；审计写失败不能创建成功登录会话。纯外部身份不能通过注册冲突或找回流程新增密码。

当前实现默认值（不是新增的已确认产品决策）：常规 ASCII 邮箱不区分大小写，不合并点号或 + 别名；
新密码 15–128 Unicode code points，NFC 规范化，不裁剪首尾空格、不要求字符组合。
密码使用 Spring PBKDF2-HMAC-SHA256、600,000 次迭代、16-byte 随机盐，带算法版本前缀，不接受明文/未知编码回退。
参数参考 [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)，
长度和 Unicode 处理参考 [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)。
已接入有限离线常见密码快照与注册/验证共享限流；不代表覆盖完整泄露密码库或满足任何合规标准。部署环境 KDF 性能验收、密码列表更新流程仍需生产验收。
内置来源为 SecLists 固定提交 9a272a1941ab13df9a20a5ce08d72ec8355f8900 的 xato top-100000 文件，含 99999 个非空条目。
短于 15 字符已由长度规则拒绝，保留 70 个适用长度的去重整值摘要；原始文件 SHA-256 为 1472aafa2561df5e3293aee252aee3ca660c12b399a283cf808bb01b39be388b。
追加配置、规范化方式、有限覆盖边界和许可证位置见 mailbox-account-api.md。

Outbox 已支持 ACCOUNT_REGISTERED/PASSWORD_CHANGED 通知和 VERIFY_REGISTER/VERIFY_PASSWORD_RESET 受保护载荷。
验证载荷使用独立外部密钥的 AES-256-GCM，绑定收件人/用途/期限；发送成功或最终失败后清除载荷，不保存原始密码或会话 Token。
邮件租约领取、有限重试、SMTP 适配和显式开发收件箱已实现；PENDING 不代表已发送，SENT 也不证明用户收到邮件。
Vue 公开确认页面和 SPACE_INVITED 双语固定通知已实现；人工重发管理 API 已在 V14 切片补齐，真实 SMTP 联调仍待完成。
当前审计接入注册、密码登录、密码重置、两种退出、服务创建/轮换/禁用/签发、双身份授权判断/查询及平台管理修改/身份拒绝。
平台全局及空间范围审计读取 API 已接入；完整失败认证/会话事件及用户自身安全审计读取仍待完成。

## Redis 证明与限流边界

验证分两步：邮件 Secret 只把对应挑战标记为 VERIFIED；原认证事务另持有的 transactionSecret 才能领取验证结果。
领取重新核对用途与绑定，并在 Redis 原子删除，只能有一个领取者。链接验证不能直接登录、修改密码或选择新的客户端。
5 次错误链接 Secret 使挑战失效；验证成功删除邮件 Secret 摘要，不延长原 10 分钟期限，缺失 TTL 的证明不放行。
邮件 Secret 为 256-bit 随机值，已接受保护的 Outbox 与开发收件箱，不返回发起请求者；HTTP GET/邮件扫描器安全策略还需在入口实现。
邮箱证明的 transactionSecret 绑定本身不等于 client/redirect/PKCE 校验；公开注册/找回入口已先校验已登记客户端的 Authentication Transaction，再领取/消费证明。

Redis 原子消费与 MySQL 提交不是分布式事务：数据库失败或结果不确定时不能把已消费证明重新塞回 Redis，
应重新验证或正常登录；数据库操作回执负责阻止重复业务效果。测试已覆盖消费后数据库回滚及重新验证后恢复。
Lua 原子性依据：[Redis Scripting with Lua](https://redis.io/docs/latest/develop/programmability/eval-intro/)。

限流原语使用首次请求起算的固定窗口，拒绝不延长封锁窗口。初始实现值为：每 IP 创建认证事务 60 次/分钟、每 IP 登录 60 次/分钟、
每邮箱登录 10 次/分钟、每 IP 邮件 20 次/小时、每邮箱邮件 3 次/10 分钟、每 IP 验证链接 60 次/分钟。
注册/重置提交共享每 IP 30 次/分钟。以上均为待按部署流量复核的实现默认值，不是新增已确认产品决策；发送、创建事务、密码、邮箱确认和账号提交限流已接入口。
键中邮箱/IP 以摘要替代原文，但这不等于不可重识别匿名化，仍需按安全数据管理 Redis。

当前 auth.ephemeral.enabled 默认 false；显式开启后加载 Redis 证明/限流/账号编排 Bean，没有内存替代。
Redis 连接/命令超时均为 1 秒，可通过 AUTH_REDIS_* 配置地址、凭据和 TLS；生产连接安全与 HA/Cluster/故障切换尚未验收。

## 协议适配结论

包含两组证据：隔离协议夹具核实 Spring Security 7.1.1 的默认行为；TokenEndpointIT 则启动真实 HTTP
服务器、生产过滤链及数据库适配，连接隔离 MySQL。两组均预置“身份校验已经完成”的授权码，
不测试注册、登录表单或第三方回调。

1. 默认 OAuth2RefreshTokenGenerator 不给 NONE 公共客户端的授权码流程签发 Refresh Token，已用回归测试固定。
2. 隔离测试扩展可在保持 NONE 公共客户端身份的前提下签发/轮换 Refresh Token，无需伪造客户端 Secret。
3. 存储适配可只保存 Code/Access/Refresh 的哈希；提交摘要本身不能替代原 Token。
4. 旧 Refresh 哈希必须保留与授权会话的关联，不能只保留最新 Token。
5. 原协议夹具使用 JVM 锁，仅验证框架边界。新增的生产 SessionService 使用 MySQL 事务/行锁，
   已通过两个独立 DataSource/事务管理器/Service 的刷新竞争测试；生产 Token 端点已接入该引擎。
6. 重放导致的撤销必须在返回 invalid_grant 时提交，不能被异常事务回滚。
7. 跨客户端提交 Refresh 必须先校验归属，不能借此撤销受害者会话。
8. SessionService 已将父认证会话、应用授权会话、用户/应用/客户端状态及旧 Access Token 统一纳入校验；
   完整服务身份鉴权与审计仍待实现。

数据库锁顺序：用户独占锁 → 客户端/应用共享锁 → 父认证会话 → 应用授权会话 → Code/Refresh Token。
配置共享读锁避免所有用户刷新时争抢同一应用的写锁；生产配置管理服务必须遵循兼容的锁顺序。

已复现并修复“查询后、加锁前账号被禁用，但 MyBatis 一级缓存返回旧状态”的竞态：
锁定及安全查询显式刷新缓存，配置 localCacheScope=STATEMENT 并禁用二级缓存。
身份读取使用独立 READ_COMMITTED 只读事务，不继承调用者 REPEATABLE_READ 的旧快照。
依据：[MyBatis Local Cache 文档](https://mybatis.org/mybatis-3/java-api.html#Local_Cache)。

已复现并修复 JDBC 按 UTC 转换、MySQL 会话仍为本机时区引起的到期字段偏差：生产连接池与测试入口
统一 connectionTimeZone=UTC、forceConnectionTimeZoneToSession=true、preserveInstants=true。
回归测试同时核对数据库当前时间与 Java Instant，以及用数据库当前时间设置的过期授权码必须被拒绝。
配置依据：[Connector/J 时间属性](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-datetime-types-processing.html)。

Token 端点拒绝重复关键参数、URL 查询参数、非表单请求、未支持的 DPoP 和不安全传输。
开发 HTTP 例外只允许 loopback issuer 加实际 loopback 连接，不采信任意转发头。
数据库故障返回标准 temporarily_unavailable / HTTP 503，与无效凭据区分；响应不包含底层异常或 Token 日志。
auth.login.enabled=true 时开放本地密码/恢复认证事务及限定来源的 CORS；默认仍关闭。
再开启 auth.mail.enabled 并提供邮件配置可用注册/找回/邮箱确认 API；当前未开放 /oauth2/authorize、OIDC、元数据，不能仅打开默认端点；当前适配不签发 ID Token。
LoginHttpRedisIT 是另一组真实密码至 Token 的 HTTP 证据，不预置授权码，但注册账号仍是内部夹具。浏览器页面有另行执行的本机交接/恢复验收，不能替代生产跨主域名验收。
MailboxAccountHttpRedisIT 进一步从公开发信、开发收件箱取链接、确认、注册，一直验证到授权码与 Token 兑换；目标账号不预置，但传输仍不是实际 SMTP。

所有协议夹具均在 src/test，不能扫描进入生产应用，也不会打包到发布 Jar。

依据：

- [Spring 公共客户端与 PKCE 指南](https://docs.spring.io/spring-authorization-server/reference/guides/how-to-pkce.html)，并以本项目 7.1.1 源码/可执行测试核实实际版本行为。
- [RFC 9700 §4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2)：公共客户端 Refresh 重放保护、轮换及保留关联。
- [MyBatis Starter 4.1.0 发布说明](https://github.com/mybatis/spring-boot-starter/releases/tag/mybatis-spring-boot-4.1.0)：与当前 Boot 4.1 系列匹配。

SDK 实施约束（尚未交付）：同一会话的刷新应合并成一个在途请求；刷新响应丢失时不盲目重试已消费的 Token，
应报告需要恢复/重新认证。不能通过重复签发、保存明文 Token 或无条件宽限期掩盖重放。

## 验证证据

普通测试：107 项（含同一刷新并发场景重复 10 次、平台白名单/邀请安全测试及 32 项 Provider 签名/HTTP/授权码/加密状态/协调器配置边界测试），全部通过。

- 正常 PKCE、不透明 Token、哈希保存、错误/缺失 verifier、拒绝 plain challenge。
- redirect 精确匹配、客户端绑定、过期 Code、重复兑换撤销。
- Refresh 轮换、重放撤销、跨客户端拒绝、过期/未知 Token、重复参数、范围升级拒绝。
- 无 Secret 的公共客户端不能使用 Client Credentials。
- 会话边界、固定权限矩阵、成员操作边界、默认服务安全边界。
- PKCE RFC 已知向量和长度边界、HTTPS/loopback 约束、媒体类型及请求保护。
- 邮箱别名不合并、输入边界、密码随机盐、编码版本、Unicode 规范化及长密码不截断。
- Redis 故障映射为 UNAVAILABLE，不包含底层命令/Secret、不放行证明或限流。
- 登录策略、分块 JSON 请求上限、来源校验与生产 Cookie 的 Secure/HttpOnly/SameSite/Host-only 属性。

真实 MySQL 集成测试：165 项（5 项基础迁移 + 26 项会话测试 + 19 项生产 HTTP 测试 + 17 项账号业务测试 + 6 项邮件投递测试 + 16 项自身账号/退出 HTTP 测试 + 9 项服务身份测试 + 14 项双身份鉴权测试 + 13 项平台管理测试 + 7 项控制台初始化测试 + 16 项空间/邀请测试 + 6 项 Java SDK/独立业务合同测试 + 11 项外部身份账号测试），全部通过。
其中会话测试包含两类并发各重复 5 次，HTTP 授权码并发兑换另重复 5 次。

Redis 测试：62 项（12 项真实 Redis 原语测试 + 3 项真实 Redis/MySQL 联动 + 3 项开发邮件联动 + 11 项真实登录/页面 HTTP 联动 + 7 项注册/找回 HTTP 联动 + 1 项编译后 SDK 真实 HTTP 联动 + 10 项 Provider 回调状态测试 + 15 项 Provider 协调器/MySQL 联动），全部通过。
两个独立 Redis 连接竞争消费重复 3 次；30 个并发请求共享 7 次测试限额，实际只放行 7 次。
覆盖用途/事务绑定、链接重放、错误次数、期限不续期、无 TTL/损坏状态、限流窗口和数据库失败后证明不可复用。
这些 Java 测试涉及页面 HTTP 资源但不执行浏览器 JS，仍不涉及真实 SMTP 或 Google/Apple 回调。

完整命令 ./mvnw -B -ntp clean -Pmysql-it -Dauth.it.jdbc-url=... verify 已通过，Jar 打包成功。
全量联合验收使用 ./mvnw -B -ntp clean -Pfull-it -Dauth.it.jdbc-url=... -Dauth.it.redis-port=... verify。
先运行 ./mvnw -B -ntp -f sdk/java/pom.xml clean install：27 项独立 Java 模块测试通过，只安装到本机 Maven 缓存，不发布远程仓库。
全量 clean + web,browser-sdk,java-sdk,full-it 已通过，113 项普通 + 249 项集成 + 34 项前端 + 24 项浏览器 SDK + 27 项 Java 模块 = 447 项，无失败/错误/跳过（Java 模块独立构建结果）。
四 profile 联合运行所有 249 项集成测试，统一生成 failsafe-summary.xml；未加 browser-sdk 时跳过 1 项 Node/SDK 联动，未加 java-sdk 不编译 6 项 Java 合同测试。
java-sdk,mysql-it 可单独运行不依赖 Redis 的 165 项测试；切换可选 profile 须 clean，避免旧测试类残留。
SDK 的 24 项测试使用受控 fetch 替身和真实 Web Crypto，验证协议/状态与故障边界，不代表已经完成独立主域名 SDK/浏览器端到端联调。
前端 vue-tsc/Vite 构建通过；npm audit（生产和完整依赖）在本次固定 lockfile 上均报告 0 已知漏洞，这不是安全性保证。
此前验证了已有 V1 测试库升级到 V2、全新隔离库从零应用 V1/V2；随后追加 V3–V13 并验证十三条迁移的校验与重跑。
首轮曾以打包后的 Jar 连接隔离 MySQL 启动冒烟测试：GET /actuator/health 返回 UP；
GET /api/v1/users/me 与 GET /oauth2/token 返回 401。Jar 内容已检查，不含协议测试夹具。

- Flyway 建表、校验、再次执行不重复迁移。
- MyBatis 读写用户/邮箱/凭据/个人空间/Owner。
- 邮箱冲突时事务回滚候选用户。
- 个人空间唯一、同一空间最多一个 Owner。
- 拒绝未知角色、拒绝单独归档 Personal Space。
- 独立 Service/连接入口重建后仍可读取 Token 和浏览器会话；摘要不能当作原 Token 使用。
- 两个入口竞争相同 Refresh：一次成功、一次重放撤销；不同用户同一客户端可以并行刷新。
- 重放撤销全部历史 Access Token；插入新 Refresh 失败时旧 Token 消费和新 Access 一起回滚。
- 重放撤销在外层调用事务回滚后仍然生效。
- 用户禁用/恢复不复活旧会话，跨用户撤销和跨客户端刷新拒绝。
- Access 15 分钟到期；后台刷新不续闲置；交互活动与网页恢复不重置 90 天绝对期限。
- 缩小 Scope 可行、扩大拒绝，应用/客户端当前状态每次重新校验。
- 禁用与刷新精确时序竞态、外层旧事务快照不会导致陈旧身份放行。
- 真实 HTTP 授权码兑换、无 Secret 刷新、客户端/回调/PKCE 绑定，以及客户端/回调尾随空格不能形成别名。
- 同一认证事务不能创建两份授权码；并发兑换只签发一对 Token，重放撤销已签发会话。
- Code 兑换时插入 Refresh 失败，Code 消费、授权会话签发标记及 Access 一起回滚；HTTP 返回 503。
- Code 重放在后续刷新之后仍撤销历史及当前 Access；客户端查询故障不伪装成权限拒绝。
- 注册邮件任务写入失败：用户、邮箱、凭据、个人空间、Owner、回执、审计及邮件表全部回滚，无孤立用户。
- 两个独立 DataSource/事务管理器/账号服务并发注册相同已验证操作，得到同一用户、只创建一个个人空间和一封通知任务（重复 3 次）。
- 密码重置同时撤销父认证会话与产品 Token；邮件任务写入失败则保留旧密码及旧会话。
- 双节点重置重试只产生一条重置审计/通知；旧回执重放不覆盖后续密码、不撤销后续新会话。
- 密码 KDF 期间完成重置，原登录被拒绝；外层事务回滚不撤销已提交的失败登录审计。
- 全量回归曾发现两次查询之间另一节点注册已提交、首节点误报 ACCOUNT_EXISTS 的竞态；已增加回执复查并补确定性交错测试。
- 真实 MySQL 邮件租约、跨节点领取隔离、旧确认失效、最终尝试崩溃收敛、过期/篡改邮件拒发；SMTP 操作位于事务外。
- 加密邮件排队后从开发收件箱取链接才能注册，发送限流生效；审计失败回滚邮件任务。此证据不是实际邮件供应商投递。
- 本地密码 HTTP 登录不预置授权码：Redis 事务、无 Cookie 密码认证、Auth 同源完成、授权码及真实 Token 兑换联通。
- 同一事务并发密码提交只创建一个根会话；并发完成只签发一份授权码。错误密码 5 次失效、原始期限不延长、缺失 TTL 拒绝。
- 已登记的另一产品来源仍不能混用事务；WEB 完成拒绝产品 origin，原生不能 Cookie 恢复；发码失败回滚 Cookie 摘要且事务不可复用。
- 开启登录功能的真实启动测试发现并修复配置类与 SecurityFilterChain Bean 重名冲突；不通过允许覆盖 Bean 隐藏错误。
- 注册公开链路必须从邮件取得 secret，不能仅凭发信响应注册；弱密码在消费证明前被拒绝，修正后可完成注册与真实 Token 兑换。
- 证明不能跨事务或跨用途使用，普通 GET/未确认/跨产品确认不验证邮箱；注册并发仅一次成功，数据库失败回滚聚合但不恢复已消费证明。
- 密码重置撤销旧 Cookie/Token、旧密码失效、新密码可重新认证；带 Google 身份而无本地凭据的账号不能通过找回新增密码。
- 修复省略可选 forceLogin 时原始 boolean 反序列化被拒绝的问题，显式规范化默认 false；MACOS/CLI 仍由策略强制 true。
- 离线列表整值/大小写/NFC 比较、外部追加文件损坏拒绝及既有密码登录兼容性已测试。
- 真实 Jar 页面及 JS 资源、CSP/no-referrer/no-store、能力开关；前端片段清理、精确回调/state 绑定、无自动重试和可选邮箱存储。
- 浏览器窄屏与桌面布局、中英文切换、错误密码提示；已有 Auth Cookie 顶层恢复后回到独立本机来源，接收器校验 state 并用原 PKCE verifier 兑换得到 HTTP 200。
  该接收器仅是临时测试工具，不是已交付的 SDK/示例服务；注册/找回 Vue 表单实际收件全链路还需验收。

环境：本机隔离临时 MySQL 9.6.0，独立端口和数据目录，不使用用户已有数据库。
Flyway 12.4.0 提示其官方已验证 MySQL 最高为 9.4；本次测试通过不等于确定生产版本。
生产 MySQL 版本确定后必须补相同测试，不能把本机 9.6 当作已批准的生产选型。

本轮 Redis 为从官方源码在临时目录编译的隔离 8.2.9 实例，只监听 loopback，不安装或修改系统服务。
源码 SHA-256 为 531b314e5557ad76d941f605b3e3162ac61dc141f37c407e1f91fcfe17ea8c30，
已与 [Redis 官方哈希清单](https://github.com/redis/redis-hashes) 一致。测试版本不代表已确定生产版本。

“最多一个 Owner”由唯一索引保证；新注册个人空间的完整 Owner 聚合已经由注册事务保证。
团队创建与 Owner 同事务完成；成员 API 拒绝修改/移除/退出 Owner，个人空间仅本人可用。Owner 交接未实现，需用户确认范围，不能只依靠唯一索引交接。

## 空间与邀请切片

V11 迁移、团队创建/改名/归档恢复、当前成员查询/角色/移除/退出、邀请创建/撤销/站内接受拒绝，以及空间审计已实现。
默认 Member、已验证邮箱匹配、当前邀请人资格重查和事务失败回滚由 16 项真实 HTTP/MySQL 测试验证。
Vue 控制台新增普通账号可用的双语空间、成员、邀请和审计页面；不要求平台管理员。邀请通知沿用 Outbox，不含可直接入组的秘密链接。
详细接口、固定初始限流参数和验证边界见 [空间 API](space-api.md)。Owner 交接因历史“首期不支持转移”表述与计划不一致而暂停，待明确确认。

## 下一实施切片

1. 继续生产独立主域名/TLS 联合验收；本机 localhost 与 127.0.0.1 之间的实际 SDK 密码请求、顶层确认、回调和身份读取已完成，不能代替正式域名和多机器验收。继续补注册/找回表单收件全链路。本人会话与安全事件 API/页面已接入，不等于可信物理设备识别。
   Google/Apple 已实现验签、授权码客户端、Apple 客户端签名、配置装配、HTTP/Cookie 边界、内部协调器、账号工作流及网页/SDK 入口；完成页浏览器绑定/账号确认已实现，邮箱补证明/账号关联和真实联调仍待完成，见 external-identity.md。
2. 服务身份、用户+服务双身份鉴权/按钮/空间范围、平台白名单及配置管理 HTTP/网页和部署初始化已接入；继续完整失败审计/限流与高影响管理操作的浏览器提交验收。
3. 空间/成员/邀请事务、审计和 Vue 页面已接入；继续真实邮件收件及跨账号浏览器验收。Owner 交接须先明确范围，不自动实施。
4. Java Starter 和独立业务示例已实现并通过真实联合验收；继续第三方身份绑定/解绑、生产部署/HTTPS/mTLS/容量和产品端到端验收。

## Provider HTTP、页面与接入说明切片

配置默认关闭；固定官方地址/HTTPS 回调、Google Secret、Apple PKCS8/P-256 和独立 state 加密密钥在启用时严格校验，启动不会访问供应商网络。
Provider 起始接口只接受 Auth 同源 JSON；Google GET 与 Apple form_post 独立边界，5 分钟 per-state HttpOnly Cookie、重复/畸形字段拒绝、共享限流及安全 303 错误返回。4 项配置测试、12 项真实 Spring MVC/MySQL/Redis 测试覆盖，供应商身份仍是离线测试签名，不证明真实 TLS。
Vue 根据 capability 名称显示按钮；SDK 只做固定 Auth 顶层入口交接，强制新事务、不向产品发送供应商凭据。7 项前端和 4 项 SDK 新测试覆盖 URL 白名单、取消片段、有限短期存储、原 PKCE 兑换及旧流程失效。
实际浏览器在临时 UI 夹具中验证确认目标、切换登录方式、失败提示、取消返回 URL 清理及双语显示；未操作真实供应商或用户凭据。后续已完成 `/complete` 的账号确认与浏览器绑定，并使用真实服务完成本机跨来源 SDK 验收，详见下一节。
macOS 文档说明进程重启须重新认证、只记住账号、Token 仅内存、系统认证会话/精确回调/PKCE、取消与晚回调拒绝，以及 CLI/上游强制重新认证的未实现边界。

## 外部身份基础切片

此处及后续按历史切片记录；账号确认证据见 [登录确认](login-confirmation.md)。该切片新增 10 项真实 MVC/MySQL/Redis 测试和 6 项前端状态测试，当时累计 447 项；最新累计数见本文顶部。账号预览阶段不发码，确认与取消竞争只能一个成功，取消不撤销原会话。

ProviderTokenVerifier 固定官方公钥来源、RS256/Nimbus 验签、精确 issuer/audience/azp/subject 与 nonce/时效检查；真实 RSA 测试覆盖伪造与声明歧义。ProviderHttp 有完整响应时限/上限，无 Cookie、重定向或重试。
ExternalAccountService 在真实 MySQL 中实现首次自动注册与个人空间/Owner/外部绑定/根会话/审计/邮件任务原子提交，不添加本地密码；再次登录按 issuer+subject 定位。不同方式同邮箱返回待验证关联，Google 非权威邮箱返回待邮箱证明，不自动合并。
V13 身份键字节精确，验证回执只存摘要；并发回调不重复创建账号，已禁用/撤销结果不复活。9 项签名校验、4 项 HTTP 传输、11 项数据库联动共新增 24 项测试通过。默认服务没有第三方登录 Controller/按钮或测试私钥；真实 Provider OAuth/邮箱联调未完成。详细边界及下一步见 [外部身份适配](external-identity.md)。

后续授权码客户端切片新增 14 项测试：Google PKCE / Apple form_post、固定官方 Token 端点、严格表单/响应与 at_hash、无重试、Apple ES256/P-256 五分钟客户端签名与轮换。现有 HTTP 测试从 4 项增至 6 项，另有 9 项授权码客户端与 3 项 Apple 签名测试；不返回或持久化 Provider access/refresh token。

回调状态切片再新增 14 项测试（4 单元 + 10 真实 Redis）：AES-256-GCM 保护临时 Auth 事务/nonce/verifier，绑定 state 摘要、浏览器凭据与精确注册配置，固定五分钟 TTL，Lua 单次领取、两连接并发、密文移植拒绝和密钥轮换。它仍是内部组件，没有公开 Controller；浏览器凭据的建立、现有 Auth 事务协调及 Apple form_post 的 HTTP 安全边界须继续实现。2026-09-15 全量 clean verify 通过；Jar 含生产组件，不含测试签名辅助类或 Java SDK/示例测试依赖。

随后完成内部 ProviderLoginCoordinator：验证 Auth 同源、共享发起限流、领取/复查 Auth claim owner，单次消费 Provider 回调，在网络调用前后复查当前产品配置；成功沿用现有 Auth complete/授权码/Token 流程，失败/取消只收尾仍持有的 claim。loginAndPublish 在 MySQL 提交前发布 Redis；丢失 Redis 回执和提交前失败均验证回滚，残留无效 root 不能签发 Token，旧会话保留。新增 1 项配置单元与 15 项真实 MySQL/Redis 协调器测试，全量 402 项于 2026-09-15 通过。Provider 网络为测试替身；HTTP Controller、受保护 Cookie、账号关联/邮箱证明中间态与页面接线依然未交付，未以失败安全的中间版本替代最终体验。详细事务边界见 external-identity.md。

## 本人会话与安全事件切片（V12）

V12 添加被撤销根的审计定位字段和本人时间分页索引。本人根会话查询、指定根及关联应用撤销、个人安全事件白名单分页已实现；禁止跨账号目标和游标，未知目标一致 404，写审计失败回滚。SelfAccountIT 从 9 项增至 16 项，新增 Vue API 测试 3 项、SDK 本地清理测试 2 项。
Vue 安全中心无需平台管理员权限；显示根会话而不冒充物理设备，撤销有默认取消确认及当前会话退出提醒。浏览器 SDK 新增 localOnly 清理，明确不等同于服务端退出。
真实嵌入式浏览器 + 打包 Jar + 隔离 MySQL/Redis 已验证普通账号的中英页面、会话列表/当前标记、安全事件查询、确认框默认取消、撤销当前根立即退出，以及刷新不自动恢复。数据库只读复核根已撤销、未撤销子授权为 0、成功审计恰好 1 条。使用预先验证的测试账号，不涉及真实 Google/Apple/SMTP，也不代表独立主域名验收。

## Java 接入切片的证据与边界

- 独立构建三个 Maven 模块；核心 Jar 不含 Spring 或 Auth Server 实现，Starter 不替换接入方 SecurityFilterChain，Auth Jar 不包含测试用 SDK/示例依赖。
- 16 项客户端测试覆盖显式双 Token、无决策缓存、并发服务 Token 合并、单调时钟/到期余量、服务轮换后不重试、用户与服务错误区分、严格 JSON/ID/游标、201 条范围、受限 HTTP 体/完整超时、无 Cookie/重定向。
- 6 项 Starter 测试验证配置缺失拒绝启动、禁用不创建假客户端、用户 Bean 退让、Provider/传输扩展点、显式 loopback 例外和凭据不打印。
- 5 项业务单元测试加 6 项真实合同测试：独立业务 HTTP + MySQL 与 Auth HTTP + MySQL 联动，SQL 在分页/统计前排除无权项目；可信归属、伪造字段拒绝、版本/工作流、降权后旧按钮无效、审计故障和服务禁用不写入。
- 示例独立 exec Jar 已启动并返回无身份 401；不注册备用本地用户，正常操作只认 Auth Token。单进程合同测试使用两个独立 Spring/HTTP 上下文和不同数据库；不把它称为生产多机器部署验收。
- 全量曾因多测试上下文保留连接池触及隔离 MySQL 连接上限；已限制测试缓存为 8，并在合同测试结束关闭上下文。未提高生产连接上限、未减少并发测试。
- [Java SDK 接入说明](../sdk/java/README.md) 和 [独立示例](../sdk/java/example-service/README.md) 已提供；尚未发布 Maven Central。真实 Provider/SMTP、生产代理/TLS/mTLS 和容量依然待验收。

未完成的外部准备：生产 Redis 部署、Google/Apple 开发者配置、SMTP、生产域名与部署；本机隔离 Redis 测试环境已经可用。
Google/Apple 尚无真实登录联调，当前没有替代真实身份校验的开发后门。
