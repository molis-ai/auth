# T-03 真实登录外部依赖台账

状态：2026-11-08，Work 网页、Work Tauri 分发包和 Club 已通过真实 GitHub staging 登录和回跳。[Work #1975](https://github.com/molis-ai/molis-work/pull/1975) 已合入 `main`。[Auth #3](https://github.com/molis-ai/auth/pull/3) 的 GitHub LIVE 适配与实测 staging 配置已通过 CI 并合入 Auth `main`（`99c28b3`），Cloudflare 生产构建关闭，合入后生产仍由 `b6e35a45` 承载。Work Tauri 无代理回跳和 Club 真实再次验证已复测，GitHub 成功绑定与换绑由隔离 WASM/D1 的不同夹具身份覆盖。两个隔离域名已绑定，阿里云短信申请材料已准备，Titan Pro Light 已核实。短信资质和模板申请、Titan 专用发件邮箱和试投、Google 项目确认和真实联调待推进。Cloudflare Email Sending 暂缓。

本台账供统一账号主流程认领和交接，承接 [T-03](delivery.md#6-剩余待办与依赖顺序) 和 [X-01 至 X-03](development-tasks.md)。盘点版本为 Auth `67904ef`、Work `d20f07c98`、Club `9ad3a66` 的 `origin/main`。Work 主线包含 [桌面回跳修复 #1965](https://github.com/molis-ai/molis-work/pull/1965)，Club 主线包含 [Cloudflare mock 预览 #28](https://github.com/molis-ai/molis-club/pull/28)。

## 盘点与认领

| 编号 | 业务链路 | 已核实的接入状态 | 资源和下一步 | 建议认领角色 |
| --- | --- | --- | --- | --- |
| T03-SMS | `+86` 手机验证码注册、登录、绑定、换绑和再次验证 | 已选阿里云短信。申请材料草稿和 API 映射已准备。控制台要求登录，企业账号及已有资源待核对。Auth 仍走 mock | 企业管理员登录后查资质、签名和模板，按缺项提交。报备后在授权测试号码验证 | 阿里云企业账号管理员申请，Auth 接适配器 |
| T03-MAIL | 邮箱验证码注册、密码找回和邮箱证明 | 已在 GoDaddy 的 Titan Webmail 核实 `support@molis.ai` 为 Pro Light。专用发件邮箱、账号级 SMTP 设置和实际外发额度待核。管理员后台要求单独登录。Cloudflare Email Sending 暂缓，Auth 仍走 mock | 确认专用发件邮箱及 SMTP 认证方式，从隔离 Auth Worker 试投并检查认证、时延和限流。Resend 保留为事务邮件 API 备选 | 邮箱管理员准备资源，Auth 接适配器 |
| T03-GOOGLE | Google 登录、绑定、换绑和再次验证 | Auth v2 只支持模拟授权和换码。已删除的 v1 Google 实现仅可从 Git 历史参考。用户正在确认 Google Cloud 项目 | 选定项目后配置授权页、隔离 Web 客户端及精确 Auth 回调 | Google 项目管理员登记，Auth 接适配器 |
| T03-GITHUB | GitHub 登录、绑定、换绑和再次验证 | `molis-ai` 组织已登记 staging 应用 #4002147 和生产应用 #4002664。三端 staging 真实登录、Club 再次验证及重复绑定拒绝通过，绑定和换绑成功路径的夹具测试通过 | [Auth #3](https://github.com/molis-ai/auth/pull/3) 已合入 `main`（`99c28b3`）。生产待确认，先对齐仓库域名和产品客户端，再按验收及回滚方案发布。[生产配置与发布门槛](#github-生产上线准备) | `molis-ai` 组织管理员负责应用，Auth 及 Work、Club 发布负责人负责接入 |
| T03-ENV | 供应商回调、Work/Club 回跳及密钥注入 | Cloudflare 已分别绑定 `auth-staging.molis.ai` 与 `club-staging.molis.ai` 到独立 staging Worker。两个 Worker 各使用专用 D1 | 已验两个域名可达；Work 网页实测使用 `http://127.0.0.1:44207`，Tauri 分发包使用 `http://127.0.0.1:4173`，两者使用独立 Auth 客户端 | Cloudflare 管理员与 Auth、Work、Club 联调负责人 |

记录进度时分别填资源状态（待申请、已提交、已获批）、适配状态（mock、LIVE 已实现）和联调证据（待验、实际送达或官方回调已验）。每次提交补控制台工单或应用引用、账号归属、环境、负责人和日期。真实密钥值由管理员放入目标环境的秘密存储。

现行 v2 投递与验证见 [delivery.rs](../../worker/rust/src/delivery.rs) 和 [registration.rs](../../worker/rust/src/registration.rs)。历史 SMTP 文档属于旧实现，真实 SMTP 也缺联调证据。[历史邮件投递](../history/mail-delivery.md)

GitHub 已在 staging 启用真实授权与回调，Google v2 仍用模拟授权。各环境按已部署的适配和配置启用登录方式。[external_login.rs](../../worker/rust/src/external_login.rs) · [account_management.rs](../../worker/rust/src/account_management.rs) · [unified_policy.rs](../../worker/rust/src/unified_policy.rs)

租户定向邀请使用同样的投递渠道，但走独立的通知路径。若随本批启用真实邀请，补相应通知模板及验收，单独跟踪。[邀请投递](../../worker/rust/src/delivery.rs)

## 短信横评

2026-11-08 盘点以中国大陆验证码、每月 1,000 条和公开价为口径。三家都能发送 Auth 自己生成的验证码。价格不含专属报价或促销，真实送达率和时延需用同一批运营商样本实测。

| 候选 | 1,000 条参考成本 | 开通与接入 | 适用条件及来源 |
| --- | --- | --- | --- |
| 阿里云短信服务 | 按量约 ¥45，或 ¥50 套餐 | 企业资质 → 签名 → 模板，等运营商报备。调用 `SendSms`（`2017-05-25`），传号码、签名、模板及参数，跟踪运营商回执 | 无既有资源时优先核查。小量可按量，官方文档明确说明超时重试和回执区别。[价格](https://help.aliyun.com/zh/sms/product-overview/billing-of-messages-sent-to-chinese-mainland) · [开通](https://help.aliyun.com/zh/sms/getting-started/get-started-with-sms) · [API / SDK](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms) |
| 腾讯云短信 | 约 ¥50，国内自定义套餐最低 1,000 条 | 企业账号下创建短信应用，准备签名和审核通过的模板。调用 `SendSms`（`2021-01-11`），使用 `SmsSdkAppId`、签名、模板 ID 及参数 | 公司已有可复用的资质和签名时优先。官方 API Explorer 可生成 SDK 示例并验证签名。[价格](https://cloud.tencent.com/document/product/382/8414) · [API / SDK](https://cloud.tencent.com/document/api/382/55981) |
| 华为云消息&短信 | 按需约 ¥65 | 企业账号下创建中国大陆短信应用，配置签名与模板。使用区域 API、应用凭据或该接口支持的 AK/SK 签名，接收发送状态 | 有企业账号、可用签名或集中采购要求时纳入联调。[价格](https://support.huaweicloud.com/price-msgsms/sms_06_0016.html) · [发送 API](https://support.huaweicloud.com/api-msgsms/sms_05_0001.html) |

**阿里云申请材料。** 模板名拟填「Molis AI 账号验证码」，类型为国内验证码。场景填「用户在 Molis Work 或 Molis Club 主动请求手机验证码，用于注册、登录或验证本人手机号」。验证码正文草稿为「您的验证码为 `${code}`。请勿向他人透露。」签名候选为「Molis AI」，由企业管理员核对签名主体、品牌证明、应用或网站入口及场景截图后提交。控制台当前停在登录页，申请尚未提交。 [短信控制台](https://dysms.console.aliyun.com/) · [资质申请](https://help.aliyun.com/zh/sms/user-guide/apply-qualification/) · [模板申请](https://help.aliyun.com/zh/sms/user-guide/create-message-templates-1/)

企业账号管理员登录后，先查能否复用国内短信资质、已报备签名及模板，再按缺项提交。联调交接记录签名、模板 ID、配额、测试号码范围、回执查询入口和 Auth 环境的凭据引用。Auth Worker 调用 `SendSms`，映射 `PhoneNumbers`、`SignName`、`TemplateCode`、`TemplateParam`，将业务投递 ID 与供应商回执关联。供应商受理和运营商送达分别验收。 [SendSms 与 SDK 示例入口](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)

## 邮件横评

2026-11-08 盘点以无附件的事务验证码邮件、每月 10,000 封和公开基础发信价格为口径。费用按原币比较，按一次投递请求只有一个收件人估算。额度、增值服务和企业合同以相应账号为准。

| 候选 | 10,000 封参考成本 | 开通与接入 | 适用条件及来源 |
| --- | --- | --- | --- |
| 现有 Titan（优先试投） | 取决于现有邮箱套餐和剩余配额 | 专用发件邮箱、TLS SMTP、隔离 Worker 试投 | 若属 GoDaddy Professional Email powered by Titan，公开 SMTP 配额是每邮箱 500 封/日。直购及其他渠道按各自套餐核对小时、日和域名级限制。 [GoDaddy 配额](https://www.godaddy.com/en-ca/help/professional-email-powered-by-titan-account-limitations-31970) · [Titan 通用配额](https://support.titan.email/hc/en-us/articles/360038836914-How-many-emails-can-I-send-and-receive) |
| Cloudflare Email Sending（暂缓） | 邮件增量约 US$2.45。若为此新开 Workers Paid，另加 US$5 月费 | DNS 验证发信域，在 Auth Worker 用邮件 binding 或 REST | 已核实 Molis 账号为 Workers Free，向普通邮箱发信需要升级。 [邮件价格](https://developers.cloudflare.com/email-service/platform/pricing/) · [Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/) |
| Resend | Pro US$20/月，含 50,000 封。免费方案每月 3,000 封且每日 100 封 | 验证发信域，创建限该域的发送权限 key。Worker 调 `POST /emails`，可用 `deliveryId` 作为幂等键 | 可快速验证低量事务邮件，费用有明显的免费和付费台阶。[价格](https://resend.com/pricing?product=transactional) · [发信 API](https://resend.com/docs/api-reference/emails/send-email) · [发送权限](https://resend.com/changelog/new-api-key-permissions) |
| 腾讯云邮件推送 | 约 ¥19 | 校验发信域及地址，提交验证码模板审核。Worker 调 `SendEmail`，以模板 ID 注入验证码变量 | 公司已有腾讯云账号或希望短信、邮件集中管理时优先对照试投。[价格](https://cloud.tencent.com/document/product/1288/47930) · [模板与发送](https://cloud.tencent.com/document/product/1288/77251) · [发信 API](https://cloud.tencent.com/document/api/1288/51034) |
| Amazon SES | 基础发送约 US$1 | 选 AWS 区域，验证域及 DKIM，申请退出沙盒，再用 SES v2 `SendEmail` 与 AWS 签名 | 已有 AWS SES 正式账号和运维体系时可优先。新账号要增加区域、IAM 和沙盒申请工作。[价格](https://aws.amazon.com/ses/pricing/) · [沙盒申请](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) · [发信 API](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html) |
| Postmark | Basic 约 US$15/月，免费联调每月 100 封 | 验证发件人或域名，使用 HTTPS 事务邮件 API，检查消息正文留存设置 | 需要独立事务流和投递事件时可对照试投。 [价格](https://postmarkapp.com/pricing) · [发信 API](https://postmarkapp.com/developer/api/email-api) |

**独立事务邮件服务。** 发信子域候选为 `mail.molis.ai`，发件人候选为 `Molis AI <no-reply@mail.molis.ai>`，均待 DNS 管理员确认。隔离发信使用独立验证域或账号、指定收件人和独立凭据。按服务商生成的记录验证 SPF、DKIM 等所需 DNS，核对 DMARC 策略及对齐。模板分别覆盖「验证 Molis AI 注册邮箱」「重设 Molis AI 密码」「验证 Molis AI 邮箱」。正文包含验证码和有效期，用现有挑战状态验证消费。试投用实际目标用户会用的邮箱服务，记录收件箱或垃圾箱、投递耗时和退信。[Resend 域验证](https://resend.com/docs/dashboard/domains/introduction)

**Titan 接入核对。** 已登录的 GoDaddy Titan Webmail 显示 `support@molis.ai`，首选项显示当前套餐为 Pro Light。`molis.ai` 的公开 MX 与 GoDaddy 的 Titan 配置一致。Email & Office Dashboard 跳转到 GoDaddy 登录页。专用邮箱及 SMTP 账号设置由管理员在登录后核对。GoDaddy 版的 SMTP 为 `smtpout.secureserver.net:465`，使用 TLS。Titan 通用文档提供 `smtp.titan.email:465`（TLS）或 `:587`（STARTTLS），按实际经销渠道和地区选用。 [GoDaddy DNS](https://www.godaddy.com/help/what-are-my-dns-settings-for-professional-email-powered-by-titan-42767) · [GoDaddy SMTP](https://www.godaddy.com/help/set-up-third-party-plugins-or-websites-using-smtp-settings-42788) · [GoDaddy 管理后台](https://productivity.godaddy.com/) · [Titan SMTP](https://support.titan.email/hc/en-us/articles/4405162224665-Configuring-Titan-on-Email-Scripts)

1. 邮箱管理员确认可用于隔离联调的专用邮箱、外发额度和第三方访问设置。已观察到的 `support@molis.ai` 仅作为套餐核对依据，隔离发件地址可由管理员从现有专用邮箱中指定，或评估 `auth-staging@molis.ai`。应用密码按该渠道的支持情况启用，凭据直接交给隔离 Auth 的秘密存储。 [Titan 应用密码](https://support.titan.email/hc/en-us/articles/59899461438233-Application-Password-in-Titan-for-Third-Party-Clients)
2. 从实际隔离 Auth Worker 验证 SMTP TLS 连通和认证。试投覆盖邮箱注册及找回验证码，记录 SMTP 接受、实际入箱、投递时延及 SPF/DKIM/DMARC 结果。发信实现只走 SMTP，省略 Titan 示例中的 IMAP 已发送副本，验证码和凭据留在受控路径内。 [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) · [Titan SMTP 示例](https://support.titan.email/hc/en-us/articles/4405162224665-Configuring-Titan-on-Email-Scripts)
3. 根据峰值发件需求和试投结果定生产方案。需要独立的发送配额、API 幂等和投递事件时，优先对照 Resend，用独立发信子域验证。当前为配置核对阶段，尚未进行 SMTP 认证或真实投递。 [Resend 发信 API](https://resend.com/docs/api-reference/emails/send-email)

## OAuth 登记材料

### Google

Google Cloud 项目是 Google 存放 OAuth 客户端、授权页配置和项目权限的地方。现有 Auth Worker 继续运行在 Cloudflare。公司项目是 Molis 的归属与交接安排。先由公司管理员确认是否已有适用项目及可管理它的成员，再决定复用或创建隔离项目。

1. 打开 [Google Auth Platform](https://console.cloud.google.com/auth/overview)，选择受公司管理的项目，进入 **Branding**，填应用名 `Molis AI`、用户支持邮箱、开发者联系人。首页、隐私政策及授权域名使用经确认的公司地址，按控制台要求验证。
2. 在 **Audience** 配置联调受众。公开产品的隔离项目可先选 **External / Testing**，按控制台要求登记测试账号。公司 Workspace 内测若仅面向本组织，可由管理员评估 **Internal**。正式发布时再处理对应品牌和受众状态。
3. 在 **Clients → Create Client** 选 **Web application**，隔离客户端名称建议 `Molis AI Auth Staging`。Authorized redirect URI 填 `https://auth-staging.molis.ai/api/v2/auth/external/google/callback`。生产拟登记 `https://auth.molis.ai/api/v2/auth/external/google/callback`。Auth 后端发起 OAuth 和换码，此方案无浏览器 JavaScript origin 配置需求。
4. 先用 `openid` 完成稳定身份登录，明确产品需要的额外声明再加 `email` 或 `profile`。记录项目、环境、客户端 ID、精确回调和授权页状态。客户端 secret 交目标 Auth 环境的秘密存储。

[创建 Web 客户端](https://developers.google.com/identity/protocols/oauth2/web-server) · [Branding](https://support.google.com/cloud/answer/15549049) · [Audience](https://support.google.com/cloud/answer/15549945) · [OIDC 协议与 ID Token](https://developers.google.com/identity/openid-connect/openid-connect)

### GitHub

`molis-ai` 组织已登记隔离应用 `Molis AI Auth Staging`（#4002147）。首页为 `https://club-staging.molis.ai`，精确回调为 `https://auth-staging.molis.ai/api/v2/auth/external/github/callback`，wildcard matching 关闭。客户端密钥已加密写入 `molis-auth-staging` 的 `UNIFIED_GITHUB_CLIENT_SECRET`。 [隔离应用设置](https://github.com/organizations/molis-ai/settings/applications/4002147)

浏览器流程使用授权码与 PKCE S256。Auth 先按 GitHub OAuth 元数据校验回调的 `iss`，随后换码并从 `GET /user` 读取稳定数字 `id`。真实授权页面只请求公开资料。 [GitHub OAuth 元数据](https://github.com/.well-known/oauth-authorization-server/login/oauth)

[创建 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) · [授权及换码](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) · [当前回调规则](https://github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps/) · [获取当前用户](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)

#### GitHub 生产上线准备

2026-11-08，已在 `molis-ai` 下登记独立 OAuth App `Molis AI Auth Production`（#4002664）。首页为 `https://auth.molis.ai`，唯一回调为 `https://auth.molis.ai/api/v2/auth/external/github/callback`，通配匹配和 Device Flow 关闭。已分配 Client ID `Ov23limq0OUD4PsZh6LZ`，客户端密钥待发布确认后生成。 [生产 OAuth 应用](https://github.com/organizations/molis-ai/settings/applications/4002664)

Cloudflare 回读确认 `auth.molis.ai` 已绑定 `molis-auth-production`，生产 `AUTH_ORIGIN` 为该域名。旧 `workers.dev` 入口仍启用。正式域名 `/login` 返回 200，无凭据访问 GitHub 回调返回 401 `INVALID_TOKEN`，正式 OAuth 授权和会话仍待验收。当前生产版本 `b6e35a45` 承载 100% 流量，生产分支自动构建关闭。 [生产域名](https://dash.cloudflare.com/200c8682734af6babc8d4ae4afaff221/workers/services/view/molis-auth-production/production/domains) · [生产部署记录](https://dash.cloudflare.com/200c8682734af6babc8d4ae4afaff221/workers/services/view/molis-auth-production/production/deployments)

| 配置 | 发布前核对 |
| --- | --- |
| Auth 生产 Worker | 将仓库生产 Wrangler 的 `AUTH_ORIGIN`、自定义域路由及部署校验对齐 `https://auth.molis.ai`，明确保留现有 `workers.dev` 入口的兼容安排。当前校验硬编码旧域名且拒绝自定义域。现有 Console seed 也写旧回调，先核对生产登记及旧客户端使用，再形成兼容的更新方案。保留生产 D1 和 `PASSWORD_KDF` 绑定。 |
| GitHub 参数 | 在生产配置校验中明确允许公开参数 `UNIFIED_GITHUB_CLIENT_ID`，并绑定 #4002664 的 Client ID。发布获批后，通过生产 Worker 的秘密绑定设置 `UNIFIED_GITHUB_CLIENT_SECRET` 和独立的 `PROVIDER_STATE_KEY`（32 个随机字节，无填充 base64url）。将代码、配置和密钥一起放入候选版本。 |
| 统一账号 v2 | `UNIFIED_ACCOUNT_CONFIG` 与生产 D1 的 `auth_environment` 对齐，使用独立生产环境 ID、`PRODUCTION / LIVE / LIVE` 和正式 Auth 来源。核对 D1 迁移记录、备份和旧版本兼容性，再登记获准试点的应用、客户端、产品、来源和精确回调。直接套用 staging seed 会带入隔离客户端，生产登记须单独准备。现行生产配置要求 LIVE，邮件和短信目前仍缺 LIVE 投递适配。 |
| Work 与 Club 回跳 | Work 由发布负责人确认实际包的数字回环端口与 `/account/callback`。Club 当前可达入口为 `https://adeptify.me`，其 `/account/callback` 本次探测返回 404。确认候选 Club Worker 的回调路由及 BFF 服务绑定、`MOLIS_CLUB_ACCOUNT_CONFIG` 和独立会话密钥，再登记产品回调。GitHub 应用只登记上表的 Auth 回调。 |

1. **发布前验收。** 基于包含 Auth #3 的候选提交对齐生产配置和校验，跑合同、OAuth、部署测试和生产 dry run。在独立数据上演练登记、回跳、D1 迁移兼容和回退。记录生产完整版本 ID、候选提交与版本 ID、试点客户端、观察窗口和回滚负责人。D-09 存量归属与旧客户端切换按 [账号迁移方案](account-migration-plan.md) 验收。
2. **批准后发布与试点。** 先由组织管理员生成生产密钥。通过 `wrangler versions upload --secrets-file` 或等效的版本操作上传候选，核对版本、路由、绑定和密钥名称，随后按批准窗口提升版本。`wrangler secret put` 会立即部署，候选准备使用版本命令。先只给获准的独立客户端开放 GitHub，保持现有登录入口可用。 [Worker 版本](https://developers.cloudflare.com/workers/versions-and-deployments/) · [Cloudflare 密钥与版本操作](https://developers.cloudflare.com/workers/configuration/secrets/)
3. **正式冒烟与放量。** Work 分发包和 Club 用受控账号跑 GitHub 首登、复登、跨端同一用户、取消与重放拒绝。用有其他可用登录方式的账号验证绑定、再次验证及解绑保护，双账号换绑按可用测试身份安排。确认系统 Chrome 回到 Work、Club 建立会话、刷新与退出正常，同时抽查原有登录、会话及回调。观察 HTTP 5xx、换码失败、回跳超时和会话完成率，再决定扩大范围。邮件、短信和 Google 按各自验收状态开放。
4. **回滚。** 发现旧登录受损、身份归属异常或回跳持续失败时，先停止试点入口和新事务。将生产 Worker 回滚到发布前确认的版本（目前为 `b6e35a45`），同步回退本轮 Work / Club 入口配置。验证正式域名、原登录、会话和生产流量，撤销受影响的新试点会话。D1 备份和迁移单独处置，保留已写入的用户和身份数据，先在独立副本验证恢复方案。 [Cloudflare Worker 回滚](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) · [D1 迁移](https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-migrations)

## 并行执行与主流程接入

1. **隔离环境。** 已部署独立 Worker `molis-auth-staging`、`molis-club-staging` 并各绑定同名专用 D1。两个自定义域名已在 Cloudflare 回读确认。Auth 环境为 `TEST / MOCK 投递 / LIVE 提供方`，Club BFF 通过 Worker 服务绑定到 Auth staging。Auth 已登记 Club 的 HTTPS 回调及 Work 的数字回环回调。 [Auth staging 配置](../../worker/deploy/staging/wrangler.json) · [客户端初始化](../../worker/deploy/staging/seed.sql)
2. **投递适配。** Auth 保持挑战生成、限流、用途、次数、过期与一次性消费规则。现有 `Sender::enqueue` 返回 D1 写入语句，LIVE 应先设计如何原子登记挑战和待投递任务，再在事务外发送并保存回执。短期验证码载荷加密、按过期清理。邮件可用供应商幂等键。短信遇到超时等结果未知的情况应核对回执再决定重试。保留密码找回的防账号枚举语义，覆盖未知邮箱在 LIVE 下的响应。API 接受、供应商回执和实际送达分别取证。
3. **OAuth 适配。** 在现有 Auth v2 `external_login` 复用一次性 browser-start、浏览器绑定、state、PKCE、超时和客户端版本检查。Google 用固定官方端点换码并校验 ID Token 签名、签发者、受众、到期时间与 nonce，以 `sub` 关联。GitHub 换码后只用服务端认证得到的数字 ID。两端共用 Auth 的稳定身份映射，禁止按邮箱自动合并；重放、取消、并发首次登录、凭据撤销和远端换码结果未知须分别处理。同步更新 `usableForLogin`、登录方式绑定与替换保护。优先验证现有 Worker Fetch/Web Crypto 和可复用的签名校验代码。选择 SDK 时先验证 Workers/WASM 运行时兼容性。
4. **产品回跳。** Google/GitHub 的服务商回调指向 Auth。Auth 完成验证后再回到产品的精确 `/account/callback`，Club 使用该环境的 HTTPS 来源，Work 继续用已登记的数字回环 HTTP 地址和实际端口。Work 桌面需用系统浏览器实测无应用窗口 Cookie 的回跳。产品继续走统一账号 v2 合同和现有 Host/BFF。供应商 secrets 注入 Auth，Club 只保有自身 BFF 会话密钥。[产品接入指南](integration-guide.md) · [Work 配置边界](https://github.com/molis-ai/molis-work/blob/d20f07c988efc080d7db12ff867652b819fa2408/horizontal/account/README.md) · [Club 配置说明](https://github.com/molis-ai/molis-club/blob/9ad3a6669c6227b3dee2fd416cbe03fb31a16784/docs/AUTH-SETUP.md)
5. **隔离联调后交付。** 记录资源、版本、非秘密配置、秘密引用、环境与联系人。邮件验收注册/找回实际收件和验证码完成，短信验收三家主要运营商样本实际到达、首登和复登、绑定、失败和限流，Google/GitHub 分别验官方授权、拒绝/取消、错误或重复回调、跨端同一 Auth 用户和 GitHub 无邮箱账号。校验配置缺失明确失败、生产拒绝 mock。把真实证据补到 UAS-03/04/05/39/40/41，T-04 继续负责实际分发形态与多设备验收。[验收矩阵](acceptance-matrix.md)

2026-11-08，真实 GitHub 登录通过的 Auth staging 版本为 `28174880-4cae-438e-bba7-3fc3adba1b5e`。

- Club 从 staging 登录页进入 GitHub，授权后回到 Club 并显示已登录，账号页可查看 GitHub 登录方式。
- Work 从临时 Home 的浏览器界面进入 GitHub，回到数字回环 `/account/callback`。首次回跳时 Work 主机等待 Auth 请求超时。重新发起事务后，浏览器弹窗关闭，Work 显示已登录及退出选项。此项使用本机 Work 主机和 Chrome；Tauri 分发包另验见下节。
- 隔离 Auth D1 聚合回读显示一个 GitHub 关联用户、两个产品客户端各一个有效会话。37 项 Auth WASM/D1 定向测试通过，覆盖 PKCE、缺浏览器绑定、缺失及错误签发方、mock 隔离、重复回调、取消及跨产品同一身份。自动化测试的 GitHub HTTP 使用夹具。

### T-04 Work Tauri 分发包的 GitHub 回跳

- 2026-11-08，以 Work `d20f07c98` 构建 macOS arm64 `0.1.0` Release DMG。App 通过签名校验，DMG 中的可执行文件与签名资源清单和被测 App 一致。此包为本地临时签名，未做 Apple 公证。DMG SHA-256：`bee9a398f74bcfaa42f79611990f07f8314b33babcb8e08ab8fa19d42d43bae6`。
- 隔离 Home 用专用的 Auth v1 测试账号完成安装登录；真实 GitHub 测试从桌面内的「Molis 账号」发起，使用独立 v2 客户端 `molis-work-tauri-staging`，Auth 只允许回跳到 `http://127.0.0.1:4173/account/callback`。
- 首轮真实 GitHub 授权已完成，系统 Chrome 到达 Work 回跳地址，但回跳请求返回 `account.unavailable`。当时 D1 显示 GitHub 事务为 `VERIFIED`、桌面客户端有效会话为 0。一次重启复用原 WebView 数据时，工作台能显示但账号按钮无响应，人工点击也未触发授权。
- 同一分发包使用干净的 WebView 数据目录，等待隔离 Work 主机就绪，并让该主机通过本机系统代理访问 Auth。重新从桌面发起真实 GitHub 登录后，Chrome 回跳显示「验证完成」；原 Work 窗口自动更新，显示「个人资料与安全」和「退出登录」。隔离 D1 回读新事务为 `CONSUMED`，同一 GitHub 用户在 Tauri、Work 网页和 Club 各有一个有效会话。正式 Work 常驻服务已恢复并通过健康检查。
- 上述首轮通过使用干净的 WebView 数据和系统代理；已有 WebView 与直连条件见下次复测。

#### 2026-11-08：复用 WebView 修复与无系统代理复测

- 原因：宿主重启后，持久化的 WebView Cookie 指向已结束的本机进程。Auth 暂时不可达时，Work 能恢复原生本地账号，却在离线状态响应里漏发 WebView 的一次性附加票据。修复后，只向已就绪账号的可信原生请求发票据；旧 Cookie、网页伪造桌面标记、票据重放和切换前的票据仍被拒绝。旧版在断开 Auth 的回归用例上因缺票据失败；修复后 8 个账号相关测试文件、73 项通过。
- 实测：Work 本地修复提交 `4729a6061` 的 macOS arm64 `0.1.0` DMG 已校验并从盘镜像解出 App（本地签名，未做 Apple 公证）。SHA-256：`a481066854e73f90c36d83c63c6f72319532bf8b48f85b352899dfc41f383dc8`。沿用上一轮 WebView 数据目录和隔离 Home，确认旧 Cookie 在启动后被拒、WebView 重新附加成功，「Molis 账号」可打开。测试期间 macOS 的 HTTP、HTTPS、SOCKS 和自动代理均关闭，Work Host 未配置代理。
- 最终包首个直连请求 Auth 超时，保持无系统代理，用新事务重试。系统 Chrome 回到 `http://127.0.0.1:4173/account/callback`，HTTP 200 并显示「验证完成」；原 Work 窗口自动显示「个人资料与安全」和「退出登录」。隔离 Auth D1 确认新增一条 `CONSUMED` 的 GitHub 事务和一个未撤销的桌面会话，并确认该 GitHub 用户在 Work 桌面、Work 网页与 Club 都有有效会话。正式 Work 常驻服务和系统代理均已恢复，正式 Work 健康检查通过。
- 最终代码验证：Work 相对 `origin/main` 的健康门禁通过；账号定向用例和宿主必跑回归共 73 个文件、933 项，全部通过。
- Work 提交 `4729a6061` 在 [PR #1975](https://github.com/molis-ai/molis-work/pull/1975) 上通过 [GitHub CI #7198](https://github.com/molis-ai/molis-work/actions/runs/42464126683)。21 个作业通过，包含 [Verify](https://github.com/molis-ai/molis-work/actions/runs/42464126683/job/128682062676)、8 个安全测试分片和 4 个产品测试分片。4 个作业按工作流条件跳过。
- PR 转为待评审后，最终 head 的健康、包边界、页面资源和密钥扫描通过，随后进入合并队列。[队列 CI #7201](https://github.com/molis-ai/molis-work/actions/runs/42465377604) 的 [Verify](https://github.com/molis-ai/molis-work/actions/runs/42465377604/job/128686323619) 通过，23 个作业成功，包含完整的 8 个安全分片和 6 个产品分片，4 个作业按条件跳过。2026-11-08 17:13（北京时间）合入 `main`，合并提交 [`f1b9993a278d07b129b72d71e62937a2e2996e59`](https://github.com/molis-ai/molis-work/commit/f1b9993a278d07b129b72d71e62937a2e2996e59)。已从 `origin/main` 回读，合并提交与 PR head 的补丁一致，涉及的五个文件内容一致。
- 结论：已有 WebView 数据下的桌面入口与无系统代理的真实 GitHub 登录通过。T-04 其余部署和多设备项继续单独验收。

### Auth GitHub LIVE 评审与复测

- 2026-11-08，[Auth PR #3](https://github.com/molis-ai/auth/pull/3) 的 `18dc1507546054b6993a793d767ba5067951af36` 固定 GitHub LIVE 适配、[staging Worker 配置和 D1 登记](../../worker/deploy/staging/README.md)。Cloudflare 控制台回读版本 `28174880-4cae-438e-bba7-3fc3adba1b5e` 承载 100% staging 流量。沿用原构建路径重建的 WASM SHA-256 为 `399b6ac2d852403531a896f45067a8cbb5774594f510adc2c7e3f6850c0fff98`，与上传前本地构建文件一致。CI 后续提交只改工具安装步骤，本轮复测沿用该 staging 版本。
- 本机全套 `npm test` 通过，Web 和 SDK 构建、staging Wrangler dry run 通过。隔离 WASM/D1 通过 GitHub HTTP 夹具覆盖成功绑定、从一个夹具身份换成另一个、操作范围内的再次验证、已消费证明和换掉的身份均被拒绝。真实 staging 的 Club 用已绑定 GitHub 通过再次验证，提交同一身份的重复绑定收到「该登录方式已被使用」，回读原登录方式仍在。成功绑定新 GitHub 身份及两个真实 GitHub 账号之间的换绑按本轮约定使用夹具验收。
- Work Tauri 复用旧 WebView 和隔离 Home，以先前验证的签名 DMG 复测。macOS HTTP、HTTPS、SOCKS 和自动代理均关闭，Work Host 未配置代理。首轮 Chrome 完成 GitHub 授权后回到 `/account/callback`，Work 完成会话时收到 `account.timeout`（HTTP 504）。在同一无代理条件下用新事务重试，回跳 HTTP 200，Chrome 显示「验证完成」，原 Work 窗口显示个人资料与退出入口。正式服务和系统代理已恢复，正式服务健康检查通过。
- 原提交的 [CI](https://github.com/molis-ai/auth/actions/runs/42466943913) 两次在下载 `wasm-bindgen` 预编译资产时遇到 HTTP 504。CI 改用 crates.io 构建 `Cargo.lock` 对应的同版本 CLI。最终 head `226c076e45f048c38018439fc4c9f0ab940354b5` 的 [Development checks](https://github.com/molis-ai/auth/actions/runs/42467985462/job/128691842151) 通过。合同 7 项、Rust 20 项、Worker 132 项、Web 91 项、SDK 27 项均通过，Web 和浏览器 SDK 构建通过。
- 合入前复核 GitHub 授权回调、PKCE、一次性证明与环境隔离，未发现阻塞项。GitHub 显示检查通过且可合入。生产环境配置检查、Wrangler dry run 和覆盖 OAuth、账号管理、部署的 37 项定向回归通过。
- Cloudflare 的生产分支为 `main`，生产「禁用构建」开启，控制台说明推送到该分支不会启动构建。预览分支构建关闭，生产部署钩子未配置。2026-11-08 18:01（北京时间），Auth #3 合入 `main`，合并提交 [`99c28b304cd0bd71c78d9dd2b6f90726047f79a7`](https://github.com/molis-ai/auth/commit/99c28b304cd0bd71c78d9dd2b6f90726047f79a7)。回读 `origin/main` 确认合并提交及树内容与已验 PR 一致。合入后生产部署活动无该提交的构建，版本 `b6e35a45` 仍承载 100% 流量。[生产构建设置](https://dash.cloudflare.com/200c8682734af6babc8d4ae4afaff221/workers/services/view/molis-auth-production/production/settings#builds) · [生产部署记录](https://dash.cloudflare.com/200c8682734af6babc8d4ae4afaff221/workers/services/view/molis-auth-production/production/deployments)

阿里云企业账号、Titan 发件邮箱和 Google 项目可以独立准备。
