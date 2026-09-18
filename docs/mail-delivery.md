# 邮件投递实现与运行边界

状态：后端投递、公开请求/确认 API 和开发收件箱联动已验证；Vue 确认页面和人工重发管理入口已实现。重发 HTTP 权限/并发/审计回滚已验证，管理页面浏览器验收及真实 SMTP 联调仍待完成。
公开账号调用链见 [邮箱注册与找回 API](mailbox-account-api.md)。
本文不是生产上线批准，不能把开发收件箱的 SENT 解释为真实邮件已送达。

## 当前流程

MailboxMailService 先使用 Redis 的 IP/邮箱发送限流，再创建绑定原认证事务的邮箱证明。
邮件挑战与 Secret 使用 AES-256-GCM 加密，与请求审计一起提交到 MySQL Outbox。
发起请求只得到 challenge，不得到验证 Secret；邮件中链接的 fragment 才带 Secret。
客户端后续必须通过明确确认动作提交验证，不能把普通 GET 或邮件扫描器访问作为确认。
Vue 确认页面只在用户点击后 POST；完整后端链路通过集成测试中的开发收件箱验证，浏览器实际收件全链路仍待验收。

Access/Refresh Token 仍然只保存摘要。可解密的邮件载荷只用于短期验证邮件，不能用于保存用户密码或会话 Token。
GCM 的认证上下文包含邮件 ID、收件人、模板、语言和到期时间，修改或挪用这些字段会使解密失败。
每次加密使用独立随机 96-bit nonce 和 128-bit tag。密钥在外部配置，不进入数据库或日志。
选择认证加密的依据：[OWASP Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)。

Redis 与 MySQL 不是一个事务：排队失败时不会发布可用的邮件 Secret，孤立 Redis 挑战自行过期；
不能通过“发送失败”跳过验证。原证明已消费但账号提交结果不确定时，也不能恢复原证明。

团队邀请另使用 `SPACE_INVITED` 中英文固定通知，与邀请记录、审计同一 MySQL 事务排队。
邮件只指向 Auth `/console`，没有直接接受邀请的 secret；登录账号须持有对应已验证邮箱并显式 POST 接受。
通知最长发送至邀请到期时间，沿用租约和有限重试；状态 PENDING 不代表投递成功。完整规则及限流见 [空间 API](space-api.md)。

## 显式启用

默认 AUTH_MAIL_ENABLED=false、AUTH_MAIL_WORKER_ENABLED=false，不发送邮件。
启用邮件须提供 Base64 编码的独立 32-byte 随机 AUTH_MAIL_KEY；默认 Key ID 为 primary。
不要使用示例测试密钥、账号密码、Token 签发密钥或固定字符串作为邮件密钥。

开发收件箱配置：

```text
AUTH_EPHEMERAL_ENABLED=true
AUTH_MAIL_ENABLED=true
AUTH_MAIL_MODE=inbox
AUTH_MAIL_WORKER_ENABLED=true
AUTH_ISSUER=http://localhost:8080
AUTH_BIND_ADDRESS=127.0.0.1
AUTH_MAIL_KEY=<独立生成的 32-byte 随机密钥的 Base64>
```

还需配置隔离 MySQL 和 Redis。inbox 强制要求 loopback Auth origin 和 bind address，不自动启用。
它最多保留最近 100 封邮件在本机进程内，重启会丢失；暂只有服务对象/测试可读取，没有公开收件箱 API/UI。
不要把使用过开发收件箱的数据库直接切到生产：已经标记 SENT 的任务不会再投递 SMTP。

SMTP 模式使用 AUTH_MAIL_MODE=smtp，并提供 AUTH_SMTP_HOST/PORT/USER/PASSWORD/FROM。
默认端口 587，强制 STARTTLS；AUTH_SMTP_IMPLICIT_TLS=true 时使用隐式 TLS，端口由部署者明确配置。
始终启用服务器身份校验；连接/读取/写入超时分别为 3/5/5 秒，不开放“信任所有证书”开关。
适配基于 Spring JavaMailSender；参考 [Spring Email](https://docs.spring.io/spring-boot/4.1/reference/io/email.html)。
当前只有 MIME、UTF-8、配置和错误脱敏测试，没有真实供应商凭据/握手/投递回执证据。

## 租约与重试

- 每次短事务通过 FOR UPDATE SKIP LOCKED 领取一封邮件，设置独立租约 Token、60 秒期限并增加尝试次数。
- 网络发送在事务外；即使上层调用带事务，也先挂起它。SMTP 不占用本投递器的数据库事务。
- 最多 5 次尝试；失败后等待 15、60、300、900 秒。到期证明直接失败，不再发送。
- 崩溃遗留的 SENDING 租约到期后可以重新领取；第 5 次崩溃也会收敛为 FAILED。
- 回写状态须匹配当前租约 Token；旧 worker 不得覆盖新 worker 的成功或失败状态。
- 成功、到期或最终失败都会清除受保护载荷，只留下任务元信息和固定错误码，不保存供应商异常详情。
- 当前后台每 5 秒最多处理 10 封；仍需按实际流量做吞吐与队列告警配置。

这是至少一次投递尝试，不是“恰好一次”：SMTP 接受后数据库确认失败、长暂停或租约失效，均可能导致重复邮件。
稳定 Message-ID 只是辅助关联，不保证供应商去重。开发收件箱按 ID 合并显示也不代表真实 SMTP 会去重。
SENT 只代表 transport 成功返回，不能证明邮件进了用户收件箱。

验证邮件失败后的重发应创建新证明、受发送限流约束，不重置旧证明期限。
人工重发通知任务已接入白名单管理 API 和控制台「邮件」页，不能直接把数据库任务重置成 PENDING。

### 管理员人工重发

- `GET /api/v1/platform/mail?limit=25&cursor=...`：沿用平台 Bearer、account scope、Auth 来源及部署白名单校验。仅返回投递元数据，不返回加密载荷或租约 Token。
- `POST /api/v1/platform/mail/{id}/resend`，JSON `{}`：仅允许 FAILED 的 ACCOUNT_REGISTERED、PASSWORD_CHANGED、SPACE_INVITED 原始任务。返回 `data: {id, alreadyQueued}`。
- V14 新增 `resend_of` 唯一关联。保留原始任务及失败历史，创建新的通知任务；每个原始任务允许一次人工重发批次，新任务仍执行有限自动重试。禁止沿重发任务继续生成链条。
- 行锁和唯一键保证并发/重复提交只产生一个任务；重复提交返回已创建的任务 ID，不表示已经送达。管理员重新校验、入队和 `platform.mail.resend` 审计同事务，审计失败回滚。
- 非失败任务、验证邮件及重发子任务返回 409 MAIL_NOT_RETRYABLE。验证邮件由用户重新发起验证，不恢复旧证明。
- UI 显示确认步骤，不自动重试写请求；网络响应丢失时可刷新列表核对状态。真实 SMTP 与管理页浏览器验收仍待完成。

## 密钥轮换

外部配置支持 auth.mail.crypto.active-key-id 和 auth.mail.crypto.keys 的 Key ID → Base64 映射。
先把新密钥和旧密钥一起部署到所有节点，再切换 active-key-id；旧密钥保留到引用它的待发送任务全部结束。
测试已验证新密钥签发、旧密钥解密共存。不能直接覆盖同名密钥，否则现有载荷无法解密。
不要提交包含真实密钥的配置文件；配置中心接入仍按既定计划后续扩展。

## 验证入口

完整 ./mvnw -B -ntp clean -Pfull-it -Dauth.it.jdbc-url=... -Dauth.it.redis-port=... verify。
MailSecurityTests 验证加密/绑定/轮换、模板和 SMTP 适配；MailDeliveryIT 使用真实 MySQL 验证租约和有限重试；
MailVerificationRedisIT 使用真实 Redis + MySQL + 开发收件箱验证邮件 Secret 与账号注册的联动。
# 第三方邮箱补证明预留（2026-09-15）

邮件投递支持 `EXTERNAL_IDENTITY` 证明用途及 `VERIFY_EXTERNAL_IDENTITY` 双语模板。链接仍通过原有确认页明确确认，内容说明“只验证邮箱，不重置密码或合并账号”。该用途不能经普通注册/找回的公开邮件请求接口签发；现已由受浏览器 Cookie、原 Auth 事务及短时提供方证明保护的 Provider 续办接口签发，见 provider-http-api.md。邮件确认后需返回原页明确继续，不能用仍有效的邮件链接复活已过期的提供方证明；真实 SMTP/浏览器验收仍待完成。
