# 后端服务身份（当前实现边界）

更新：2026-09-15。标准 Client Credentials 签发与服务身份持久化已实现。
用户+服务双身份授权、平台管理 HTTP/控制台、空间/成员写入、Java Starter 与独立业务示例已实现，见 authorization-api.md、platform-api.md、console.md 和 ../sdk/java/README.md。完整权限服务和生产部署仍未交付。

## 与用户身份分开

每个服务客户端绑定一个应用。服务客户端、凭据和 Token 使用 V7 的三张独立表，与用户登录会话/Token 表隔离。
服务身份没有 userId，不等同于平台管理员或应用中的某个用户；不能用 Service Token 调用用户自身账号 API。
用户 Access/Refresh Token 也不能在服务身份解析器中通过。

客户端 ID 由 Auth 内部生成 `svc_<UUID>`。这是避免标识混用的实现命名空间，不是用户必须填写的账号。
同 ID 若也出现在用户登录客户端表，会默认拒绝服务身份，不能猜测应使用哪种身份；平台登录客户端登记入口拒绝 svc_ 前缀，保留这一命名空间。
服务 Secret 由安全随机数生成 256 bit，仅返回创建/轮换调用方一次，服务端只存 SHA-256 摘要，不支持取回明文。
Secret 只能交给后端；不能放进浏览器、macOS 公共客户端或 CLI 二进制。

## POST /oauth2/token

仅支持后端 `client_secret_basic`：HTTP Authorization Basic 中使用 OAuth 表单编码后的 client ID 与 Secret。
标准 application/x-www-form-urlencoded 请求体：

```text
grant_type=client_credentials&scope=authorization
```

scope 可省略，当前仅支持 `authorization`。它表示调用后续 Auth 鉴权接口的服务能力，不是任何空间或业务资源的授权结果。
请求体不能再次提供 client_id/client_secret，不能混用授权码、Refresh Token 或 assertion；带浏览器 Origin 的 Client Credentials 请求拒绝。
仅 HTTPS，loopback 开发例外。无浏览器会话 Cookie，不签发 Refresh Token，不设置 Cookie。

成功为 OAuth 标准响应，而不是业务 JSON 信封：

```json
{
  "access_token": "一次返回的随机不透明服务 Token",
  "token_type": "Bearer",
  "expires_in": 300,
  "scope": "authorization"
}
```

当前 5 分钟为实现初始值，不是新确认的生产参数；生产验收时需评估。服务方需在到期前重新使用凭据换 Token，
Java Starter 已合并同实例并发的服务 Token 获取，不保存用户 Refresh Token；到期提前获取，服务 401 后下一次显式调用重新认证，不自动重试失败决策。
成功/错误均 no-store；X-Request-ID 由 Auth 生成并与签发审计关联，不采信客户端自选审计 ID。

错误：错误/撤销/禁用的 Basic 凭据返回 401 invalid_client 和 Basic challenge；非法 scope 为 400 invalid_scope；
数据库或事务故障为 503 temporarily_unavailable，不能被误归类为普通权限拒绝，也不能让业务默认放行。
服务认证请求使用独立认证请求类型，避免 Spring 继续尝试其他 Provider 而覆盖原始不可用错误。

## 轮换、禁用与事务

生命周期由 ServiceIdentityService 实现。create、rotate、disable 仍是内部可信调用方法；
平台 HTTP 入口先校验有效用户及部署白名单，再调用 createLocked、rotateLocked、disableLocked，使管理员校验锁、凭据修改和审计处于同一事务。
传入 actorUserId/requestId 本身不等于权限校验，不得直接绑定客户端提交的任意用户 ID。

- 创建：应用须有效；原子保存服务、一个有效凭据和审计。Secret 在提交成功后返回一次。
- 轮换：锁定应用/服务后，原子撤销旧凭据、创建新凭据并审计；唯一索引保证每服务最多一个有效凭据。
  当前实现立即失效旧凭据及其全部 Service Token，不提供双凭据宽限期。接入方部署轮换期间必须处理重新认证失败，不能缓存最终 Allow/Deny。
- 禁用：原子标记服务禁用、撤销其凭据并审计。Token 解析每次检查当前应用、服务及凭据状态，不等待 5 分钟自然过期。
- 框架中的凭据认证和 Token 签发不是同一步；签发时重新锁定并检查当前凭据，期间轮换/禁用不能凭早先的认证结果继续签发。
- Token 签发与 `service.token.issue` 审计同事务；创建、轮换、禁用同样审计失败即回滚。

锁顺序为应用共享锁→服务排他锁，Token/凭据在该服务锁内重新读取；使用 READ COMMITTED 和 MyBatis STATEMENT 缓存策略。
此处先保证多实例正确性；高吞吐并发基准和只读锁优化尚待生产参数验收，不能只凭测试通过推断容量。

## 已验证与仍待完成

ServiceIdentityIT 的 9 项真实 Spring HTTP/MySQL 测试覆盖：哈希持久化、5 分钟不透明 Token、无 Refresh、
用户/服务类型隔离、scope 升级、浏览器来源和混合凭据拒绝、重复 Basic、轮换/禁用/到期、框架阶段间状态变更、
并发签发与禁用、审计回滚，以及数据源故障保留 503 语义。

平台白名单、客户端管理 HTTP 和应用停用/恢复编排已接入，并有独立 PlatformHttpIT 验证；详见 platform-api.md。
服务凭据操作界面和部署初始化已接入；尚需其完整浏览器提交验收和生产 HTTPS/反向代理验收。

服务 Token HTTP 签发现在必须启用 `AUTH_EPHEMERAL_ENABLED=true` 并连接 Redis；缺少共享限流器或 Redis 故障返回 503，不回退本机限流。初始实现限额为每连接 IP 120 次/分钟、每声明 clientId 30 次/分钟，均使用摘要键；部署前需容量复核。不采信任意 X-Forwarded-For。
限流返回 429 `rate_limited`，Retry-After 为保守的 60 秒。SDK 不自动重试。
`invalid_client`、`invalid_scope`、可识别为服务请求的 `invalid_request` 及限流拒绝均记录 `service.authentication` DENIED 和服务端 requestId；不持久化声明的 clientId、Secret、Token 或 Basic 内容。审计失败返回 503，不能签发 Token。
Java Starter 已实现并通过真实合同测试，支持外部凭据 Provider 和 mTLS HTTP 传输扩展点；真实 mTLS 认证仍待联调，不代表可用证书代替现有服务身份凭据。
AuthorizationService 已在同一事务中结合用户 Token 的应用、服务应用、应用权限目录、空间成员和动作进行检查；Service Token 有效本身不允许访问任何业务数据。
