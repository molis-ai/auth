# 双身份资源鉴权 API

更新：2026-09-15。三个真实 HTTP/MySQL 入口、平台配置、空间管理事务、Java Starter 和独立业务示例已实现并测试。
完整 OpenAPI、账号安全中心和生产部署仍待完成；不能把这些接口存在当作完整 Auth V1 已完成。

## 共同约束

仅业务后端通过 HTTPS 调用，loopback 开发例外。每次必须同时提供：

```text
Authorization: Bearer <该后端的 Service Token>
X-User-Token: <业务请求携带的用户 Access Token>
Content-Type: application/json
```

Service Token 需具有 authorization scope；用户 Token 当前要求 account scope。OAuth scope 不是空间角色或业务 Allow。
Cookie、用户 Refresh Token、前端自报 userId/role/applicationId 都不能代替上述身份。用户 Token 和服务 Token 必须绑定同一个应用。
不要把服务 Token/Secret 交给前端；网关和日志必须脱敏两个 Token 请求头。浏览器 Origin 请求拒绝，不提供浏览器 CORS 放行。

所有入口只接受单个 JSON 对象，拒绝查询参数、未知字段、重复 JSON 字段、尾随 JSON、超过 16 KiB 的请求体。
重复身份头无效。requestId/decisionId 由 Auth 生成，分别返回在 X-Request-ID / X-Decision-ID 中，不信任调用者传入的同名头。
响应 no-store；禁止业务服务缓存最终 Allow/Deny，也不能在故障时默认放行。

## POST /api/v1/authorization/check

对应 byAction 判断。请求例子：

```json
{
  "spaceId": "42efed29-c5e2-41a6-b5ca-14b8f5de163e",
  "action": "feed.manage",
  "resourceType": "feed",
  "resourceId": "feed_123"
}
```

spaceId 必填 UUID；action 为最长 100 字符的小写动作名。可选 resourceType/resourceId 必须成对提供，分别限制为 32/128 个安全标识字符。
资源上下文仅用于审计，Auth 不会根据 resourceId 查询业务数据库，也不会从它猜测空间。
业务后端必须先读取可信资源记录的 spaceId，再提交判断；不能直接照搬前端传来的“这个资源属于哪个空间”。

有效身份下，权限判断返回 HTTP 200：

```json
{
  "data": {
    "allowed": false,
    "reason": "ROLE_FORBIDDEN",
    "decisionId": "8adef745-39fb-45c7-8c36-1f6e1731bcde"
  },
  "requestId": "7e5f3ed8-c92d-4fda-af96-ea84f6433c5a"
}
```

允许时 allowed=true、reason=NONE。常见业务拒绝：UNKNOWN_ACTION、APPLICATION_ACTION_FORBIDDEN、NO_MEMBERSHIP、
ROLE_FORBIDDEN、PERSONAL_SPACE、ARCHIVED_SPACE。不存在的空间与非成员统一 NO_MEMBERSHIP，不泄露空间是否存在。
普通成员/Viewer 可读取 feed，只有 Owner/Admin 可管理；团队归档保留读取、拒绝普通写入，个人空间只能由其真实所有者访问。

仅 HTTP 200 且 data.allowed 严格为 true 才代表 Auth 在该判断时点允许。业务后端仍需执行工作流限制，
例如指定审核人、禁止自审、资源当前状态。Allow 不代表业务操作已执行成功，也不是跨数据库事务或永久权限凭据。
权限在判断之后仍可能变化；不得复用过去的 decisionId 跳过新的执行时鉴权。

## POST /api/v1/authorization/allowed-actions

请求为 `{ "spaceId": "UUID" }`。返回：

```json
{
  "data": {
    "allowedActions": ["feed.read", "project.create"],
    "role": "MEMBER",
    "decisionId": "8adef745-39fb-45c7-8c36-1f6e1731bcde"
  },
  "requestId": "7e5f3ed8-c92d-4fda-af96-ea84f6433c5a"
}
```

集合为固定角色规则、当前空间状态与该应用动作目录的交集，按动作名排序。业务后端可以根据工作流状态继续缩小集合。
页面初始化可经业务后端一次取得按钮集合；不能让浏览器持有 Service Token 直接查询。
角色降级、空间归档、目录撤销后，执行时重新 check 会拒绝，即使页面还显示旧按钮。
非成员返回 403 NO_MEMBERSHIP；有效成员且应用未配置动作时，集合为空。

## POST /api/v1/authorization/spaces

请求为 `{ "action": "project.read", "limit": 50, "cursor": "上一页最后一个空间 UUID" }`，cursor 可省略，
limit 默认 50、范围 1–200。返回 data.spaces（id/name/spaceType/status/role）、nextCursor 和 decisionId。
没有下一页时 nextCursor=null；空间按 id 排序。仅列出对该动作有权限的空间，不返回全局空间目录。

成员关系、角色、归档状态和个人空间真实归属条件都在 SQL LIMIT 之前过滤，不是读取一页再丢弃无权数据。
业务资源列表还须将这一范围加入自己的数据库 WHERE 条件，然后进行业务资源分页/统计；不能先查项目分页再过滤。
若空间范围本身有多页，业务后端需要完整处理范围页或使用等价的受控查询策略，不能只拿第一批空间就宣称结果完整。
跨页不保持长数据库快照，成员状态变化可能改变后续范围；单资源操作仍单独重新鉴权。

## 应用目录与事务一致性

V8 的 auth_application_permission 是应用允许使用的固定动作子集。未配置即无动作，不自动为已有应用授予所有动作。
当前目录范围来自 FixedPermissionPolicy，未知动作即使被错误写入数据库也不会放行。暂无自定义角色或权限组合。
平台配置 API 和控制台已实现，按部署白名单管理动作目录；测试目录由专用夹具创建，不应借此开放任意数据库写入给产品客户端。

每次判断在一个 READ COMMITTED 事务中重新校验用户、登录客户端/应用、根/授权会话、Access Token、
服务应用/客户端/凭据/Token、应用动作目录和空间成员。沿用 user→登录 app/root/grant→service→space/membership 的锁顺序。
后续平台/成员写入事务须保持兼容的锁顺序；不能把当前“最多一个 Owner”数据库约束当成完整所有权交接事务已实现。

判断和审计同事务提交：记录双方身份 ID、应用/授权会话、空间、请求动作、资源标识、决策和拒绝原因，不记录 Token 或业务正文。
审计失败不会返回 Allow，也不会伪装成业务 Deny，而是 503 AUTH_UNAVAILABLE。
普通身份无效/scope 不足/应用不匹配也记录拒绝；JSON/传输层拒绝还不是已执行的鉴权判断，不保证有数据库决策审计。
页面动作及空间范围查询的 SUCCESS 表示查询成功，不表示业务操作成功。

## 错误与尚未完成项

错误信封为 `{ "error": { "code": "…" }, "requestId": "…", "decisionId": "…" }`：

- 401 USER_UNAUTHENTICATED / SERVICE_UNAUTHENTICATED：Token 缺少、错误、类型混用、到期、撤销或所属身份停用。
- 403 USER_SCOPE_REQUIRED / APPLICATION_MISMATCH / BACKEND_ONLY：调用边界不允许。
- 403 UNKNOWN_ACTION / APPLICATION_ACTION_FORBIDDEN：空间范围查询的动作不允许；单 check 则返回 200 + allowed=false。
- 400 INVALID_REQUEST / JSON_REQUIRED / HTTPS_REQUIRED，413 REQUEST_TOO_LARGE：请求格式或传输不合规。
- 503 AUTH_UNAVAILABLE：数据库/事务/审计不可用；500 INTERNAL_ERROR：未预期故障。两者都不能放行业务。

14 项 AuthorizationHttpIT 已验证四角色、双身份应用绑定、Token 类型/撤销/scope、空目录/目录撤销、
角色降级前后及并发读取、个人空间异常成员、归档读写、分页前过滤、决策审计、格式/来源拒绝和故障关闭。
平台目录、团队/成员/邀请事务及目标角色限制已接入；Owner 交接范围待明确确认。
空间详情及控制台已显示服务端计算的当前角色全部固定动作和拒绝原因；这是角色层说明，不替代应用目录、资源归属或成员目标角色限制。
鉴权 HTTP 现在要求共享 Redis 限流：每连接 IP 6000 次/分钟、每服务 Token 3000 次/分钟（初始实现默认值，部署前复核容量）。429 RATE_LIMITED 附 Retry-After；Redis 未启用或故障返回 503 AUTH_UNAVAILABLE，无本机放行回退。
仍需容量/生产验收和完整 OpenAPI。
当前鉴权查询不自动延长登录闲置期限，避免后台轮询无限续期；不改 GoalBoard。

### 显式用户活动

`POST /api/v1/authorization/activity`，请求体严格为 `{}`，使用同样的服务 Bearer 和 X-User-Token 双身份。只允许同应用、有效会话及 account scope；拒绝浏览器 Origin，不接受 userId、sessionId 或客户端时间。
可信业务服务仅在识别到真实用户交互后调用，不能在刷新、定时任务、轮询或每次鉴权后无条件调用。Auth 能校验调用服务身份，但不能凭网络请求证明人类实际操作；该分类责任属于接入服务。
成功返回 `data: {recorded:true, decisionId}`，更新当前授权会话及父认证会话的闲置活动时间，绝对期限不变。活动更新与 `authorization.activity` 审计同事务，审计失败回滚；已过期/撤销会话不能复活。
Java `AuthorizationClient.recordUserActivity(userAccessToken)` 已封装，SDK 不自动调用、不重试。
Java Starter 和独立业务 HTTP/MySQL 示例已通过真实 Auth 联合验收，涵盖 201 个空间跨页、SQL 过滤、降权/凭据撤销和审计故障，见 [Java 接入说明](../sdk/java/README.md)。该证据不是生产多机器或浏览器独立域名验收。
