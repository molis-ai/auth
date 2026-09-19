# Google / Apple 外部身份适配

更新：2026-09-15。**基础验签、授权码客户端、Apple 客户端签名、回调状态/协调器、默认关闭的 HTTP/配置与账号工作流已实现；完整第三方登录尚不可用。** 未配置真实凭据，没有真实 Google/Apple 回调成功证据。本文不能当作已交付第三方登录的声明。

## 已实现边界

### 邮箱补证明后端基础（2026-09-15）

已加入内部 `ExternalMailboxAccounts`，消费 EXTERNAL_IDENTITY 专用 Redis 邮箱证明，再与验签产生的 `VerifiedIdentity` 一起进入 MySQL 注册事务。证明仍绑定原 continuation secret，不能使用 REGISTER/PASSWORD_RESET 证明，也不能反向用于本地注册或重置密码。公开 `/transactions/mailbox` 暂时拒绝 EXTERNAL_IDENTITY，避免未完成的续办流程提前开放。

补证明后的新账号仍仅绑定外部身份，不创建本地密码；账号、邮箱、个人空间/Owner、外部身份、认证根、审计、通知及 V15 邮箱消费回执原子提交。验证邮箱来自 Redis 服务端证明，不使用浏览器声明或未经认可的 Provider 邮箱。

邮箱已被已有账号持有时，返回 ACCOUNT_LINK_REQUIRED，不关联、不签发该账号会话；记录已消费的邮箱操作，不能将同一证明换给其他身份重复使用。提供方证明过期或身份已被并发注册时拒绝；不因补邮箱而延长原提供方证明寿命。Redis 消费不因数据库/发布失败而恢复，结果不明必须重新验证或正常登录。

**后续增量已接入邮箱和各账号关联续办 HTTP/页面，见 provider-http-api.md。** 同时启用 federation/mail 时，MAILBOX_VERIFICATION_REQUIRED 保存短时加密、浏览器及原事务绑定的证明，进入明确发邮件/继续/取消页面；仍不延长验签期限。ACCOUNT_LINK_REQUIRED 支持原密码或已有 Google/Apple 再认证；补邮箱后的冲突进入同一关联阶段。真实跨机器及浏览器/供应商/SMTP 验收尚未完成。后文保留的历史安全失败描述不代表最新行为。

`ProviderTokenVerifier` 使用现有 Nimbus JOSE/JWT 依赖验证 RSA 签名，固定 Provider/注册 clientId，核对 issuer、subject、audience、azp、nonce、iat/exp/nbf 及服务端事务起始时间。只接受 RS256、公钥 RSA ≥2048 位；拒绝私钥来源、错误签名/算法/类型、重复 JSON 字段、尾随 JSON、非整数时间、缺失声明和 token 自带的公钥位置。输入有 16 KiB 上限。

Google 的兼容 issuer `accounts.google.com` 归一为 `https://accounts.google.com`；Apple 为 `https://appleid.apple.com`。持久身份以该 issuer + 不改变大小写的 subject 定位，不以邮箱定位。V13 把外部身份两列改为 VARBINARY，避免数据库文本比较规则改变不透明标识。

这些校验基于 [Google ID Token 校验说明](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)、[Google Discovery](https://accounts.google.com/.well-known/openid-configuration) 和 [Apple Discovery](https://appleid.apple.com/.well-known/openid-configuration)。两个 Discovery 当前均声明 ID Token 签名为 RS256；不要把 Apple 的客户端凭据签名算法与 ID Token 验签算法混淆。

生产构造方法仅使用固定官方 JWKS URL，不接受请求里的 issuer/JWKS 地址。公钥使用 Nimbus 有限缓存（5 分钟）、刷新限流（30 秒），无过期缓存故障放行或自动重试。JDK HTTP 限制连接 3 秒、完整响应 5 秒、响应 256 KiB，不跟随重定向，不携带 Cookie/认证器。未知密钥/签名失败与公钥服务故障区分；安全错误不附带原始异常或 Provider 响应。公共可信 SPI 只用于服务器组合/测试，不是可配置的浏览器入口。

验签产物 `VerifiedIdentity` 只能由校验器内部构造，最多存活 5 分钟且不超过 ID Token 到期；不会将原始 Token 填入账号 DTO。该对象仍不能代替 state/回调事务与一次性消费校验。

## 服务端授权码客户端

`ProviderRegistration` 固定 Auth 自己在供应商登记的 clientId 和 HTTPS 回调，不接受产品端的 clientId/回调替换；URL 禁止凭据、query、fragment、路径归一歧义。Apple 网页回调还拒绝 localhost/IP。配置/独立启用开关已装配，默认关闭；固定回调和环境变量见 [Provider HTTP API](provider-http-api.md)，测试注册不进入生产配置。

`ProviderCodeClient` 只生成 code 流的固定官方授权地址。Google 使用 `openid email profile`、state、nonce、S256 PKCE、query 返回，明确 online，不请求离线授权。Apple 使用 `openid email`、state、nonce、form_post；不声称 Apple 会执行未声明支持的 PKCE。流程基于 [Google OIDC 参数参考](https://developers.google.com/identity/openid-connect/reference) 和 [Apple Token validation](https://developer.apple.com/documentation/SigninwithAppleRESTAPI/Generate-and-validate-tokens)。

兑换请求只向固定官方 Token 端点 POST form-urlencoded。每次读取服务端凭据来源，以支持轮换；redirect_uri 固定为注册回调，不接受临时覆盖。输入期限/nonce/code/verifier 在读凭据和请求网络前校验，表单逐项编码。返回 JSON 拒绝重复字段、尾随内容和不合规类型；提取 ID Token 后交给签名校验器，存在 `at_hash` 时校验其与同次响应 Access Token 匹配。只返回 VerifiedIdentity，不向产品返回或持久化 Provider 的 access/refresh token。

当前模块不处理 Apple 上游长期授权检查、供应商撤销通知或代用户撤销 Provider 授权；需要这些能力时须单独实现受保护的凭据持久化及生命周期，不能以 Auth 本地退出代替。Auth 自有会话的 Access/Refresh 与 Provider Token 完全不同。

Apple `client_secret` 由 `AppleClientSecret` 使用 ES256/P-256 私钥生成，kid 和 Team ID 为部署配置，sub 为注册 clientId、aud 为 Apple、有效期 5 分钟；每次读新的 SigningKey，错误不保留私钥异常详情。它不是用户 ID Token（后者仍验 RS256）。依据 [Apple 客户端签名说明](https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret)。未提供私钥文件读取或配置默认密钥，更没有浏览器签名入口。

所有请求沿用完整响应 5 秒/256 KiB 上限，无 Cookie、Authorization 转发、重定向、网络自动重试。`invalid_grant` → PROVIDER_CODE_REJECTED；`invalid_client`/密钥不可用 → PROVIDER_CONFIGURATION_ERROR；网络、限流、服务器或不合规错误响应 → PROVIDER_UNAVAILABLE；200 中缺失/不合规 Token 字段 → PROVIDER_RESPONSE_INVALID；签名或身份不匹配 → PROVIDER_IDENTITY_INVALID。错误不回显 error_description/原始响应/code/secret。

重要：**该客户端本身不维护已用 code/state 集合，不能替代跨节点 Redis 单次领取。** 调用方在兑换前必须消费绑定的认证事务；响应丢失或 Provider 拒绝后不得用旧 code 自动重试。公开 Controller 仅在显式开启 federation 后装配，必须经专用安全链及协调器，不提供绕过事务的直接兑换 API。

## 内部回调状态存储

`RedisProviderTransactions` 生成独立随机 state、nonce 和 Google PKCE verifier，将 Auth 事务秘密、领取 owner、nonce、verifier 与开始时间用 `ProviderStateCipher` 的 AES-256-GCM 加密后保存。Redis key 只含 state 摘要；另一字段是浏览器绑定、供应商、注册 clientId 和精确 Auth 回调的联合摘要。加密附加认证数据绑定命名空间/key/联合摘要，密文不能移植到其他事务。

状态组件已由默认关闭的配置装配为 Bean，不能单独证明浏览器绑定。协调器验证并领取 Auth 事务、生成独立随机绑定；HTTP 层通过短期 Secure/HttpOnly/Host-only/SameSite=None Cookie 设置和读取。**不能把回调 state 本身、请求自报 userId 或可随授权链接复制的参数当作浏览器绑定**。防护依据 [RFC 9700 §4.7.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.7.1)。Apple 专用 form_post、参数边界及回调限流已接入，真实浏览器行为仍需验收。

Lua 在一个 key 上原子检查绑定/TTL、取出并删除密文；只允许一个消费者获得待兑换数据。错误浏览器或注册配置不消耗合法事务，也不延长 TTL。固定上限 5 分钟；缺失 TTL、超长 TTL、解密失败、移植密文和认证加密保护的开始时间过期均拒绝。密文损坏或密钥移除后的失败不恢复已领取状态；网络结果不确定时不重试消费/兑换，需要重新发起认证。取消/错误回调也必须走协调器的消费与 Auth 事务收尾，不能直接复用旧 state。

加密密钥需由所有 Auth 节点共享的独立部署 key ring 提供，无默认密钥、不复用 Provider client secret。构造时校验 256 位密钥；新写使用 active key，轮换期间可保留旧 key 读取最多 5 分钟的在途数据。已接外部配置/环境变量启动快照，变更后重启；配置中心热更新未实现。测试使用两个独立连接访问一个隔离 Redis，不等于 Redis Cluster/故障转移验收；Lua 单次消费也不是 Redis 与 MySQL 之间的分布式事务或备份回滚后的全局恰好一次保证。

## 内部登录协调器

`ProviderLoginCoordinator` 仅接受部署装配的 ProviderCodeClient 集合，每种供应商最多一个注册，回调必须是 Auth 同源且供应商之间不同。未装配供应商返回 PROVIDER_NOT_ENABLED。begin 只允许 Auth origin、复用共享 LOGIN_IP 限流，验证当前产品客户端后领取 Auth 事务并生成随机浏览器绑定；不设置会话 Cookie、不签发用户 Token。产品自有登录页后续通过 Auth 顶层交接页发起此步骤，相关网页/SDK 跳转尚待完成。

callback 先单次消费 Provider 状态并验证浏览器/注册绑定，再用新增 Redis `owned` 原语检查 Auth 事务仍为 BUSY 且 owner 精确匹配。兑换前后均重新检查 Auth 事务和产品当前可用状态；失效/换 owner 的事务不能写账号。取消或错误回调不调用 Provider token 端点；失败只收尾本人仍持有的 Auth claim，不重置 READY、不续期、不自动重试旧 code。错误浏览器不会销毁合法回调状态。成功只返回固定 Auth `/complete#transaction=…`，后续沿用现有 Auth 授权码/Token 流程。

账号服务增加仅包内可用的 `loginAndPublish`：完成验证身份的账号/会话写入后，在同一个 MySQL 事务提交前发布 Redis AUTHENTICATED。发布失败会回滚本次新账号/会话/审计/邮件；即使 Redis 已执行但回执丢失，数据库回滚后残留 root 也无法通过会话服务验证。提交前故障同样不能凭残留 root 签发 Token。旧账号、外部身份及旧会话不因一次新登录失败而被删除/撤销。发布已尝试后不再因唯一键异常重试。此设计不是 XA，数据库提交结果不确定或节点进程崩溃仍须依靠数据库实际提交状态、当前根会话校验与 TTL 收敛，不宣称所有网络故障都能确定回滚。

**账号关联/邮箱补证明仍未交付。** 当前这两个分支明确返回 ACCOUNT_LINK_REQUIRED / MAILBOX_VERIFICATION_REQUIRED 并终止当前事务，不静默合并、不新增本地密码，也未保存可继续使用的中间证明。这只是失败安全的阶段性处理，不能作为最终登录体验；必须补上受保护的中间状态与二次验证后，才能完成 V1 第三方登录交付。

## 首次注册与再次登录（内部服务）

`ExternalAccountService` 是内部服务，没有 Controller。身份已经绑定时，锁定并复查当前用户/绑定状态，创建 Auth 完整认证根；不自动修改已验证邮箱，也不因 Provider 邮箱变更而换用户。

未知身份且邮箱证明可信时：账号、已验证邮箱、个人空间、Owner、外部绑定、登录根、审计及注册通知 Outbox 原子提交，不创建本地密码。纯外部账号仍不能通过密码找回静默获得密码。

注册邮箱已属于现有账号时返回 `ACCOUNT_LINK_REQUIRED`，既不自动关联，也不新建另一个用户/个人空间。现已接通原密码或已有 Google/Apple 身份的原地关联确认；补邮箱后冲突也进入同一关联阶段，见 provider-http-api.md。密码必须匹配当前锁内凭据，已有提供方证明必须对应目标账号已绑定的 issuer/subject，不能再次按邮箱猜账号。两份提供方证明都记录一次性回执，不创建本地密码。真实联调尚未完成。

Google 非 Gmail、非 Workspace 的邮箱即使 `email_verified=true`，也不一定是当前邮箱所有权证明；首次使用时返回 `MAILBOX_VERIFICATION_REQUIRED`，不会写成已验证邮箱。已有 issuer/subject 绑定仍可登录。Gmail、带已验证 hosted-domain 声明的 Workspace、Apple 已验证邮箱（含私密转发地址）可进入自动注册分支。规则依据 [Google 的邮箱权威性说明](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)；缺失/未验证邮箱也须补证明，不用邮箱后缀猜登录供应商。

Apple 接受 `email_verified` 的布尔值或明确字符串 true/false，不做 truthy 转换。Apple 浏览器首次返回的用户姓名不是本组件采信的签名身份字段；默认显示名为 Apple user，后续资料编辑另行处理。

V13 `auth_external_login_receipt` 用 Provider + 注册 clientId + nonce 的摘要约束同一份验证结果只产生一个登录根；不存 nonce、原始 ID/access/refresh token。并发唯一键冲突仅在完整回滚后重读一次，不重试 Provider 的授权码兑换。重复回执复查用户、绑定和根会话；已撤销/禁用不能借旧回执复活。注册/登录审计失败整笔回滚。用户安全事件页允许展示本人外部注册/登录事件。

## 已有测试证据

- 9 项真实 RSA 签名的校验器测试：声明/类型/算法/签名/nonce/时效/主体/邮箱可信度、未知/弱/私钥拒绝、公钥故障脱敏。
- 6 项本机真实 HTTP 测试：公钥 JSON、无凭据、禁止重定向/重试、超大/非 JSON 拒绝、慢响应正文总时限、POST 表单及真实 HTTP + 签名响应联动。
- 9 项授权码客户端测试：精确注册/端点、Google PKCE、Apple form_post、表单编码、错误分类、响应/at_hash、输入在网络前拒绝、凭据轮换与无重试。
- 3 项 Apple 真实 ES256 签名测试：必要声明/5 分钟期限、轮换及旧密钥不再验证、错误曲线/配置/来源拒绝。
- 4 项回调状态单元测试：随机化加密、上下文/密文认证、密钥轮换、错误配置与 Redis 故障脱敏。
- 10 项真实 Redis 状态测试：两个独立连接单次领取（并发重复 3 次）、无明文秘密、浏览器/供应商/注册/回调隔离、TTL、密文移植/损坏、轮换、绝对时间和 Apple 无 PKCE。
- 1 项协调器配置单元测试：非 Auth 回调、重复回调和重复供应商拒绝。
- 15 项真实 Redis/MySQL 协调器测试：真实签名身份至 Auth 授权码/Token、Apple 交接、取消/畸形输入、浏览器/owner 隔离、并发回调（重复 3 次）、应用停用/事务过期复查、Provider 错误、不绕过邮箱证明/关联、Redis 回执丢失/提交前失败回滚与旧会话保留。Provider token 传输为测试替身，不是公开回调 HTTP 或真实供应商登录验收。
- 11 项真实 MySQL + 签名测试身份联动：自动注册/无密码、同邮箱不合并、邮箱改变/缺失、Apple 转发邮箱、撤销/禁用、原子回滚、相同/不同证明并发、subject 大小写隔离、过期证明拒绝。
- V12→V13 实际迁移及重复校验通过。测试私钥只存在于 src/test，不在服务端 Jar 或生产配置。

这不等于真实供应商认证。签名来自测试私钥，HTTP 来自本机测试服务器；公开网络 JWKS 轮换、生产代理与 Provider 账号策略仍需真实验收。

## 下一步必须完成

1. 在已实现的默认关闭配置和 HTTP 接口上补真实 TLS/浏览器 Cookie/反向代理验收，不以 MockMvc secure 标记代替。
2. Auth Provider 入口确认页、错误处理和重开已实现；最终 `/complete` 已加入 [真实账号确认/浏览器绑定](login-confirmation.md)，不自动切换身份。本机跨来源浏览器已验证，真实供应商回调及生产域名验收仍需继续。
3. 需要验证邮箱/已有账号的中间状态、既有方式重新认证、原子关联；主动绑定/解绑的身份复核与最后可用方式保护。
4. Vue/框架无关 SDK 第三方入口与错误/取消/不自动重试语义已接入；[macOS 进程重启与协议说明](native-client-protocol.md) 已补齐，原生应用和真实浏览器联合验收不在这些单元测试证据内。
5. 真实 Google/Apple 开发者配置、HTTPS 正式回调域名及联调；SMTP 真实收件单独验收。

禁止直接添加接受客户端 `userId`、`emailVerified=true`、subject 或已解码 claims 的登录 API。第三方按钮默认隐藏，只根据明确的部署开关/有效配置展示以供受控验收；在补证明流程与真实部署验收完成前，不得将开关打开后的界面当作生产可用声明。
