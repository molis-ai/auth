# 当前账号与退出 API

更新：2026-09-15。身份、两种退出、本人登录会话管理、个人安全事件和登录方式列表/解绑已实现并通过真实 MySQL/HTTP 测试。登录会话不等于物理设备；资源授权使用独立 API。

## 登录方式与外部身份解绑

- `GET /api/v1/sessions/login-methods`：本人 account scope Bearer 及既有客户端 Origin 边界；返回 `data: {userId,password:boolean,availableProviders:["google"|"apple"],external:[{id,provider,available}]}`，不返回外部 subject/issuer 或凭据。无分页/任意 userId 参数。availableProviders 仅包含部署启用项。
- `POST /api/v1/sessions/login-methods/{id}/unlink`，请求体严格 `{}`：目标必须属于本人。完整认证距今小于五分钟，否则 403 REAUTHENTICATION_REQUIRED；这是实现默认值，恢复会话不算重新完整认证。
- 当前提供方停用的其他身份不算可用替代方式；没有剩余本地密码或启用的外部身份时返回 409 LAST_LOGIN_METHOD。未知/不属于本人返回 404 LOGIN_METHOD_NOT_FOUND。
- 用户锁内解绑、撤销本人所有 Auth 会话及审计原子完成，成功响应 `data: {unlinked:true, loggedOut:true}`。不会退出外部提供方自身账号。SDK 在验证成功结果后只做 localOnly 清理；响应丢失不重试，应重新认证后读取状态。
- 个人安全事件包含 account.external.unlink 和 account.external.bind；主动绑定见 provider-http-api.md。登录过程中同邮箱关联续办、邮箱补验证尚未交付。
受 AUTH_LOGIN_ENABLED 开关控制；正常登录另需 Redis 认证事务，参见 login-protocol.md。

## 身份约束

三个入口都要求唯一 `Authorization: Bearer <Access Token>`，并要求 `account` scope。
Cookie、Refresh Token、任意 userId/sessionId 不能代替身份。仅允许操作 Token 本人的账号/会话。
每次在 MySQL 锁内重查用户、应用/客户端、根会话、授权会话及 Token 的状态/期限；禁用与撤销不能沿用旧查询结果放行。

浏览器 Origin 必须属于该 Token 客户端的当前已登记 WEB 回调来源，或 Auth 本身。
另一产品即便也在全局 CORS 允许集合中，仍不能混用该 Token。无 Origin 的非浏览器调用仍需全部 Token 检查。
CORS 允许 Authorization 预检，不允许跨域携带 Auth Cookie。

## GET /api/v1/users/me

无请求体。返回标准 `{ data, requestId }` 信封，data 包含：

```json
{
  "userId": "当前用户内部 ID",
  "displayName": "显示名称",
  "emails": ["已验证邮箱"],
  "applicationId": "当前 Token 绑定应用",
  "clientId": "当前登录客户端",
  "sessionId": "当前产品授权会话 ID",
  "scopes": ["account"]
}
```

不返回根 Cookie/认证会话 ID、Token、密码凭据或其他用户信息。该接口不授予跨产品业务资源权限。

## POST /api/v1/sessions/current/logout

Content-Type: application/json；请求体必须为 `{}`，不接受目标用户或会话字段。
仅撤销当前 Token 所属授权会话，旧 Access/Refresh 随即不可使用；同用户其他授权会话及 Auth 根会话不变。
成功返回 `{ "data": { "loggedOut": true }, "requestId": "…" }`。
SDK 须清除本地 Token、暂停自动顶层恢复；否则保留的 Auth Cookie 仍可在新的主动登录中用于恢复。

## POST /api/v1/sessions/logout-all

相同鉴权和空 JSON 请求体，撤销本人全部根会话和产品授权会话，包括其他设备；其他用户不受影响。
浏览器仍可能留有旧 Cookie 值，但服务端已拒绝对应会话，不能再据此恢复。不会调用 Google/Apple 注销接口。

## 事务、错误与证据

撤销与 `session.logout.current` / `session.logout.all` 审计同事务提交，V6 增加应用和授权会话审计上下文。
审计写失败会回滚撤销并返回不可用，不能报告成功。所有接口 no-store，错误不包含 Token 或底层数据库细节。

- 401 UNAUTHENTICATED：缺少/错误/重复 Bearer、过期、撤销、禁用或无效会话。
- 403 ACCOUNT_SCOPE_REQUIRED / ORIGIN_NOT_ALLOWED：scope 或来源不允许。
- 400 INVALID_REQUEST：不合规 JSON 或试图指定操作目标。
- 503 AUTH_UNAVAILABLE：数据库/事务故障，不等同于业务拒绝，不允许调用方默认放行。

退出不是凭失效 Token 幂等回传成功：重复/并发退出可得到 200 与 401，只有实际撤销的一次生成成功审计。
网络丢失响应时客户端无法据此判断事务是否提交，应标明“未确认服务端撤销”；SDK 不盲目重试消费型刷新。

SelfAccountIT 的 16 项真实 HTTP/MySQL 测试覆盖身份/scope、两种退出、跨账号/客户端来源、Cookie/Refresh 拒绝、
过期/禁用、审计失败回滚、并发退出，以及候选读取后禁用的竞态。只替换未被这些接口使用的 Redis 限流依赖；
另覆盖本人根会话分页/状态、指定根及子授权撤销、当前根撤销、重复撤销/并发只写一条审计、失败回滚、个人安全事件白名单和跨用户游标拒绝。
这些测试不替代真实 Redis 登录测试，也不代表已实现可信物理设备识别、地理定位或异地登录告警。

## 本人登录会话与安全事件（V12）

| 请求 | 行为 |
|---|---|
| GET /api/v1/sessions/authentications?limit=25&cursor=… | 只列本人完整认证根会话，包含有效、过期及已撤销历史 |
| POST /api/v1/sessions/authentications/{id}/revoke，空 JSON `{}` | 撤销本人指定根及全部子授权；不影响其他根或用户 |
| GET /api/v1/sessions/security-events?limit=25&cursor=… | 只列与本人相关、明确允许展示的账号安全事件 |

沿用唯一 Bearer/account scope、客户端 Origin 和当前状态校验，不依赖 Cookie。分页 GET 仅允许单个 limit/cursor 参数；重复/未知/空参数、非法 UUID、limit 超出 1–200 返回 400。默认为 25，响应为 `data: {items, nextCursor}`。

列表按认证/事件时间倒序、UUID 倒序稳定分页，先按本人范围过滤再分页；游标只接受本范围可见记录。不提供跨请求快照，新增记录可通过重新读取第一页获得。

会话字段：id、current、authenticatedAt、lastUserActivityAt、expiresAt、revokedAt、status、applicationSessionCount。id 只是管理定位符，不能用来登录；不返回 Cookie、Token、摘要或个人 IP。current 由当前 Access 所属根计算。status 描述根会话，不保证其每个应用仍启用；应用会话数包含已签发后结束的历史。查询不延长最后活动或 90 天上限。

撤销响应 `data: {revoked: true, current: boolean}`。目标不属于本人/不存在统一返回 404 SESSION_NOT_FOUND。持有有效调用会话时重复撤销同一根可返回成功，不重复写事件；撤销当前根后旧 Token 重试返回 401。用户锁先于根/授权锁；撤销根、子授权与成功审计同事务，审计失败整体回滚并返回 503。已撤销根不能恢复、签发新授权或刷新旧 Token。

个人事件仅包含 account.register、account.login、account.password.reset、account.external.register、account.external.login、session.logout.current、session.logout.all、session.authentication.revoke。target 必须为本人，actor 只能为本人或未认证（例如失败的密码尝试）。平台和空间管理事件不在此范围。返回事件/action/outcome/requestId/时间及安全的会话/应用定位符，不返回内部变更详情。V12 新增 authentication_session_id 记录被撤销根，原 authorization_session_id 标识发起请求的授权会话，历史事件允许为空。

Vue 控制台提供双语查询、分页和默认取消的撤销确认框。撤销当前根收到成功响应后，浏览器 SDK 使用 `logout({localOnly:true})` 清除内存 Token/在途流程并暂停自动恢复，不再调用服务端退出。localOnly 本身不声称撤销任何服务端状态；响应丢失须显示结果不确定，不自动重试写入。
