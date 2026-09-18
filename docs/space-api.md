# 空间、成员与邀请 API

更新：2026-09-15。V11 邀请迁移、HTTP 事务服务及双语 Vue 空间管理页已实现。
本说明不代表 Auth/SDK 整体交付；Owner 交接范围待用户明确确认，未实现交接端点、迁移或页面。

## 身份和边界

开启 `AUTH_LOGIN_ENABLED=true`，创建团队和发送邀请还需可用的共享 Redis 限流器（`AUTH_EPHEMERAL_ENABLED=true`）。
请求携带唯一的 `Authorization: Bearer <用户 Access Token>`，要求 `account` scope；Cookie 不作为这些 API 的身份依据。
这是 Auth 自身的账号空间管理 API，不是业务服务的双身份资源鉴权 API，也不要求平台管理员白名单。
浏览器来源必须属于当前 Token 的登录客户端；HTTPS、JSON 严格解析、16 KiB 上限、no-store/no-referrer 沿用服务安全边界。
注册的来源允许预检，但不允许凭 Cookie 跨域请求。非浏览器客户端无 Origin 的处理沿用登录客户端策略。

返回格式 `{data,requestId}`；列表为 `data: {items,nextCursor}`。可选 `cursor` 和 `limit`（默认 50，1–200）；使用响应游标，不自行推导。
空间/成员/邀请按 UUID 升序分页，审计按时间与 UUID 倒序。返回的时间为 UTC ISO 8601。
空对象操作必须显式发送 JSON `{}`；POST/PUT 禁止查询参数、重复或未列出的 JSON 字段。

## 端点

下列路径前缀均为 `/api/v1`。

| 方法和路径 | 请求体/行为 | 当前权限 |
|---|---|---|
| GET /spaces | 本人的成员空间列表；分页前过滤 | 有效账号 |
| POST /spaces | `{name}`；创建 Team 和本人的 Owner 成员关系 | 有效账号 |
| GET /spaces/{space} | 空间详情与本人角色 | 当前空间成员 |
| PUT /spaces/{space} | `{name,version}` | 活跃 Team 的 Owner/Admin |
| PUT /spaces/{space}/archive | `{archived,version}`；归档/恢复 | Team Owner |
| GET /spaces/{space}/members | 成员列表，不暴露成员邮箱 | 当前空间成员 |
| PUT /spaces/{space}/members/{user}/role | `{role}` | 下述目标角色约束 |
| POST /spaces/{space}/members/{user}/remove | `{}` | 下述目标角色约束 |
| POST /spaces/{space}/leave | `{}`；只移除自己 | Team 非 Owner 成员 |
| POST /spaces/{space}/invitations | `{email,locale}`；locale 为 en 或 zh-CN | 活跃 Team Owner/Admin |
| GET /spaces/{space}/invitations | 空间全部状态的邀请，分页 | Team Owner/Admin |
| POST /spaces/{space}/invitations/{invitation}/revoke | `{}` | Team Owner/Admin |
| GET /invitations | 与本人当前已验证邮箱匹配、未过期的待处理邀请 | 有效账号 |
| GET /invitations/{invitation} | 查看本人邀请；不会入组 | 对应已验证邮箱持有人/原接受者 |
| POST /invitations/{invitation}/accept | `{}`；明确同意 | 对应已验证邮箱持有人 |
| POST /invitations/{invitation}/decline | `{}`；明确拒绝 | 对应已验证邮箱持有人 |
| GET /spaces/{space}/audit | 空间范围审计，分页 | 当前 Owner/Admin |

空间详情字段：`id,name,spaceType,status,version,role`。成员字段：`id,displayName,status,role`。
邀请字段：`id,spaceId,spaceName,invitedEmail,inviterUserId,inviterName,status,expiresAt`。
创建和改名的名称必须为 1–120 字符、无控制字符及首尾空白。版本冲突返回 409，不静默覆盖。

## 成员规则

- Owner 可调整非 Owner 为 Admin/Member/Viewer，可移除非 Owner。
- Admin 只能在 Member/Viewer 之间调整，或移除 Member/Viewer；不能修改自己或其他 Admin。
- Member/Viewer 可查看所属空间及成员，但不能管理成员或邀请。
- 任何这些 API 都不能赋予 Owner、移除 Owner 或让 Owner 退出，因此团队不会通过这些操作失去 Owner。
- 个人空间仅本人的 Owner 关系有效，拒绝 Team 管理操作；不能邀请、退出、移除成员或单独归档。
- 归档保留读取、移除非 Owner、成员主动退出和撤销邀请；禁止普通写入、改角色及新成员加入。恢复不重建已移除成员。
- 被停用账号不能操作或成为角色修改目标；允许移除已停用的非 Owner。移除/退出不删除业务数据。

## 邀请及邮件

当前实现默认期限为 7 天（后续可通过配置适配调整，不代表已确认所有运营参数）。
新成员只有在登录并明确同意后才加入，初始固定 Member；请求不接受自定义初始角色。
已有成员接受邀请保留其角色，不降级；重复接受已经成功的邀请不会重复入组，之后被移除也不能用旧邀请重新加入。
接受时再次检查邀请未过期/撤销、邀请人账号有效且仍为当前 Owner/Admin、空间未归档。
新账号先通过正常注册验证目标邮箱，再在控制台看到邀请；不能仅提交 userId 或邀请 ID 加入。

同一空间/邮箱已有未过期 PENDING 邀请时返回原记录，不重复发信；过期记录在下一次处理时落为 EXPIRED。
读取也会按当前数据库时间呈现 EXPIRED，不需要依赖定时任务才拒绝过期接受。没有人工重发或修改收件人 API。
默认创建团队每用户 20 次/小时；邀请每邀请人 20 次/小时，同时共用每邮箱 3 次/10 分钟发送限制。Redis 故障拒绝操作，无本机放行回退。

创建邀请与 `SPACE_INVITED` 通知 Outbox、审计同事务。通知为中英文固定内容，链接仅到 `${AUTH_ISSUER}/console`，
没有可直接入组的 bearer secret 或 GET 接受链接；邮件扫描或单纯打开页面不会接受邀请。
SMTP 未启用时任务只排队，不表示已投递。实际 SMTP 收件尚未验收，详见 [邮件运行说明](mail-delivery.md)。

## 并发、审计和错误

参与用户按 UUID 排序加数据库行锁，然后锁当前空间；锁内核对会话、用户、成员和邀请状态，多实例不依赖 JVM 锁。
团队创建、成员关系变化、角色变更、归档、邀请及成功审计同事务提交；数据库/审计/邮件排队异常回滚。
权限拒绝写 DENIED；协议解析/限流/基础设施异常不保证生成业务审计，不能宣称已覆盖所有失败事件。

常用错误：401 `UNAUTHENTICATED`；403 `ACCOUNT_SCOPE_REQUIRED`/`SPACE_FORBIDDEN`；404 `NOT_FOUND`；
409 `VERSION_CONFLICT`/`TARGET_INACTIVE`/`INVITATION_NOT_PENDING`/`INVITATION_EXPIRED`；
429 `RATE_LIMITED` 携带 Retry-After；503 `AUTH_UNAVAILABLE`。前端不显示内部异常，也不自动重试写请求。
对于丢失响应或 5xx，应先读取当前状态，不能据此断言操作未提交。

## 验证与未完成项

- SpaceHttpIT：16 项真实 HTTP/MySQL 测试，覆盖当前身份/来源、个人空间、角色目标约束、归档、并发邀请/接受、过期/撤销/拒绝、默认 Member、已有角色保留、移除后的重放、邀请人禁用竞态，以及审计/邮件失败回滚。
- 上述空间 HTTP 测试的 Redis 限流器使用替身；共享限流原语另有真实 Redis 测试，不能混称空间端点的真实 Redis 压测。
- 前端新增 3 项角色约束/传输测试，邮件新增 1 项固定通知和无 secret 链接测试。
- 本轮完整回归：75 普通 Java + 178 集成 + 18 前端 + 18 SDK = 289 项，无失败、错误或跳过。
- 最终 Jar 的真实浏览器检查：空平台白名单账号通过 SDK 恢复，创建空团队、查看 Owner 成员、给自身测试邮箱创建并明确接受邀请，角色保持不变，站内待办及管理列表同步更新；空间审计可读取对应 SUCCESS/requestId。
- 浏览器测试发现并修复接受后管理列表未刷新；390×844 和 1280×900 检查完成，390px 时页面内容宽度也是 390px，无整页横向溢出，未捕获 JS error。
- 上述邀请浏览器操作只作用于自身隔离测试账号，未扩展他人权限；跨账号加入默认 Member 由 HTTP 集成测试覆盖。未启用 SMTP，任务排队不代表真实投递。
- Owner 交接、账号完整安全中心、人工重发邮件、生产 SMTP 和独立主域名联合验收不包含在本切片完成项中。

范围待确认：历史用户表述为“第一期先不支持转移”，而计划文件包含团队 Owner 交接。写入审查因此暂停交接部分。
交接会改变团队最高管理权，在得到用户明确确认前，不实施该项；本轮只实现无争议的空间、成员和邀请功能。
