# 邮箱注册与找回密码 API

更新：2026-09-15。后端入口与 Vue 认证页面已实现；注册/找回表单的完整浏览器收件链路和真实 SMTP 联调仍待验收，见 [网页说明](web-ui.md)。
依赖 [登录事务协议](login-protocol.md) 和 [邮件投递配置](mail-delivery.md)；不能直接调用内部账号服务绕过邮箱证明。

## 开关及基本流程

同时开启 AUTH_LOGIN_ENABLED、AUTH_EPHEMERAL_ENABLED、AUTH_MAIL_ENABLED，配置邮件加密密钥及显式 inbox/smtp 模式。
邮件 worker 另由 AUTH_MAIL_WORKER_ENABLED 启用；关闭时请求仅排队，不会自动投递。
inbox 仅用于 loopback 开发，当前没有公开收件箱 API；集成测试从进程内收件箱取邮件，不能据此声称真实邮件已投递。

客户端先创建绑定自身、精确回调、state 和 PKCE 的认证事务。下列事务接口均要求 X-Auth-Transaction，
接受 application/json，响应沿用 data/error + requestId 包装。客户端不能提交“已验证邮箱”、userId 或任意认证会话 ID。

| POST 路径 | JSON 请求 | 成功 data |
|---|---|---|
| /api/v1/auth/transactions/mailbox | email、purpose（REGISTER/PASSWORD_RESET）、locale（en/zh-CN） | challenge |
| /api/v1/auth/mailbox/verify | challenge、secret（邮件链接中的 token）、confirmed=true | verified=true |
| /api/v1/auth/transactions/register | challenge、displayName、password、locale | continueUrl |
| /api/v1/auth/transactions/reset-password | challenge、password、locale | loginRequired=true |

verify 是 Auth 确认页面使用的同源 POST，不携带原客户端事务，要求 Origin 精确为 Auth origin。
其余接口要求原认证事务仍处于 READY，来源属于该客户端或 Auth。
发信响应不返回邮件 secret，也不说明邮箱是未知账号、本地账号还是外部账号；三种情况都可请求邮件。

## 注册

1. 用原认证事务请求 REGISTER 邮件。
2. 用户打开 Auth 邮件确认页；页面应读取片段并清除地址，展示明确确认按钮，不在 GET/加载时自动验证。
3. 用户确认后 POST verify，邮件证明变为 VERIFIED，但不创建账号、不登录、不修改客户端绑定。
4. 用户回到原注册流程提交 challenge、显示名及新密码。密码校验通过后领取原事务，原子消费绑定 REGISTER 用途、同一事务、未过期的邮箱证明。
5. MySQL 原子创建用户、已验证邮箱、密码凭据、个人空间/Owner、回执、审计和通知任务。邮箱由已消费证明提供，不由注册 JSON 选择。
6. 创建无 Cookie 的根认证会话，再进入已实现的 Auth 顶层 complete → 精确产品回调 → PKCE Token 兑换流程。

相同邮箱已经有账号时不会合并或新增本地凭据；只有证明邮箱后才返回 ACCOUNT_NOT_AVAILABLE，用户应正常登录。
注册聚合提交与随后创建根会话是两个数据库事务；后者失败不撤销已注册账号，用户可以正常密码登录恢复。
后续步骤失败、响应丢失或结果不确定时，不恢复已消费证明或重建认证事务。

## 找回密码

用 PASSWORD_RESET 用途请求邮件并确认，然后从原事务提交新密码。
仅已有本地密码且 ACTIVE 的账号可重置；纯 Google/Apple、未知或禁用账号不能由这个接口获得本地密码。
校验失败在邮箱证明后返回 RESET_NOT_AVAILABLE；不会静默转成注册，也不返回内部账号状态或外部身份详情。

成功事务同时更新密码、撤销全部根认证会话和产品授权会话，并写回执、审计、通知任务。
原找回事务结束，不创建替代会话、不设置 Cookie；返回 loginRequired=true。客户端新建事务，用新密码完成登录。
旧 Cookie/Access/Refresh 不因重置后重新登录而复活。

## 单次证明、并发与限流

邮件 secret 只证明邮箱控制权；必须同时持有原客户端事务才能使用结果。换事务或把注册证明拿去重置会被拒绝。
公开 verify 仅 POST 且要求 confirmed=true；GET、缺少确认或来自产品页面的跨源确认不能消费链接。
这防止常见 GET 扫描器触发验证，并不意味着能够识别模仿用户 POST 的扫描软件。

同一认证事务原子领取后才执行注册/重置，竞争请求不能产生第二份账号聚合。
确定的 INVALID_PROOF 可以按事务已有的累计 5 次错误上限重试；Redis 结果未知或数据库失败时保留 BUSY/已消费状态，必须重新发起流程。
便宜的密码长度/阻止列表校验在领取事务、消费证明之前完成，允许用户修正密码。

共享限流包括邮件请求的每 IP 20 次/小时、每邮箱 3 次/10 分钟；确认每 IP 60 次/分钟；注册/重置提交合计每 IP 30 次/分钟。
均为待按部署容量复核的初始实现值。429 带 Retry-After；依赖故障 503，与无效证明或密码策略拒绝区分。
API 不延长原认证事务或邮箱证明期限，用户需在两者均有效时完成。

## 密码阻止列表

新建/重置密码在 NFC 规范化与 15–128 code points 长度校验后执行离线整值检查；不做任意子串匹配。
只为阻止列表比较采用小写，实际密码编码/登录仍保留大小写，不裁剪空格。
已存在密码的正常登录不因列表后来更新而被悄悄拒绝。

内置列表来自固定版本 SecLists 的 xato top-100000 文件。少于 15 字符的条目已由长度规则拒绝，资源只保留适用长度的 SHA-256 摘要。
来源版本、原文件摘要和 MIT 许可证随 Jar 中 META-INF/SECLISTS-NOTICE.txt 分发。
这是有限常见密码快照，不是完整泄露密码数据库，不宣称合规认证或覆盖所有弱密码。

可通过 AUTH_PASSWORD_BLOCKLIST_FILE 指定本地追加文件：UTF-8，每行一个完整密码 NFC → Locale.ROOT 小写 → UTF-8 SHA-256 的 64 位小写十六进制摘要，允许空行和 # 注释。
追加文件最多 8 MiB；配置后缺失/损坏使启动失败，不能关闭内置检查或静默忽略错误。替换列表后需重启，并在发布过程中评审来源与更新周期。
检查只发生在 Auth 本机，不上传密码、摘要前缀或邮箱。
新密码被拒绝返回 INVALID_PASSWORD 或 PASSWORD_BLOCKED，不返回密码原文。
检查依据：[NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) 的新建/更改密码整值阻止列表要求。

## 验证边界

MailboxAccountHttpRedisIT 使用真实 HTTP、Redis、MySQL 和生产邮件加密/模板/投递代码；仅邮件传输替换为显式开发收件箱。
注册测试不预设邮箱已验证或直接创建目标用户，必须走发信、取邮件、确认、注册、登录完成步骤。
找回测试覆盖撤销已有会话、旧密码失效、新密码可用、外部身份无本地凭据不能重置。
还覆盖用途/事务绑定、GET/未确认/跨源确认拒绝、并发注册和数据库失败回滚。
实际浏览器 UI、跨域 Cookie、Google/Apple 和 SMTP 收件仍需后续验收。
