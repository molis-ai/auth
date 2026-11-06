# Work / Club 统一账号接入与管理说明

本说明对应合同 1.1.0 和 AUTH-12 本地交付。只介绍现有实现；真实域名、发送服务、Google/GitHub 应用和存量迁移尚未接入。验收范围见 [矩阵](acceptance-matrix.md)，交付版本见 [摘要](delivery-manifest.json)。

## 入口与 SDK 选择

Work 使用 `horizontal/account` 及 Host 的账号入口；Club 使用 `lib/account` BFF。两者各自显示注册登录页面，邮箱/手机直接在产品内完成。Google/GitHub 的外部授权在当前隔离环境走明确标为模拟的提供方，再回到登记的精确产品回调。

`sdk/browser` 保留 v1 托管登录与账号确认流程，**不是这次 Work/Club 的 v2 接入 SDK**。它的浏览器 Token、托管恢复和 Google/Apple 示例不能套到 v2。现阶段没有另行发布一个通用 v2 npm SDK；公共合同是 `contracts/unified-account`，Host/BFF 使用带 SHA-256 的固定副本。

| 层 | 使用的入口 | 身份与存储 |
| --- | --- | --- |
| Work 页面 | Host `/api/account/*`；非凭据操作映射同一 `system.account` 动作目录 | 控制令牌、同源校验、写操作一次性键由既有请求助手处理；中央 Token 仅由 Host SecretStore 持有 |
| Club 页面 | 同源 `/api/account/*`，第三方回到 `/account/callback` | HttpOnly Cookie + CSRF；中央 Token 在 BFF/D1 加密保存 |
| Host/BFF 到 Auth | 冻结 operationId 对应 `/api/v2/*` | 可信环境、应用/client/来源和当前独立登录；不接受页面自报 userId/product/actor |
| 后续业务功能 | 调用权益服务，由业务服务复核资源范围 | 页面“允许”只是展示，不是业务授权凭证；本期未接实际收费拦截 |

## 表单协议示例

以下是 Club 产品边界的邮箱密码登录步骤，字段来自现行合同。页面先 GET `/api/account/session` 取得匿名会话及响应的 `X-CSRF-Token`，随后所有写请求使用同源 Cookie、Origin、CSRF；凭据只在表单提交中短暂存在，不记录到日志、模型输入或持久存储。

```http
POST /api/account/auth/transactions
Content-Type: application/json
X-CSRF-Token: <本次浏览器会话的 CSRF>

{"purpose":"LOGIN","method":"EMAIL_PASSWORD"}
```

从响应 `data.handle` 取得产品内短时句柄，依次向 `/api/account/auth/transactions/{handle}/submit` 提交：

```json
{"step":"PASSWORD_LOGIN","email":"<用户输入>","password":"<用户输入>"}
```

```json
{"step":"COMPLETE"}
```

完成后从响应安全视图或重新 GET session 更新界面；不读取/保存中央 code、proof 或 Token。Work 同样使用短时句柄，但须经其现有 Host 请求助手处理控制头和一次性写键，不能把 Club Cookie 示例直接搬过去。注册、手机号、找回和再次验证的 purpose/method/step 组合以合同及现有页面实现为准，不拼出任意上游 URL。取消或结果未知应按实际状态处理，不盲重试已消费材料。

管理写入先读取资源 `version`，再传 `expectedVersion` 与一次逻辑操作的 `Idempotency-Key`；冲突后重新读取，由用户决定重试。权益查询虽然是 POST `/api/account/entitlements/check`，仍是只读操作，不发中央写幂等键。请求只包含 `{scope, featureIds}`；两端产品专属目录不同，共享功能标为 SHARED。分别返回的 `revision` / `validUntil` 可能受当前登录与请求范围影响，不将它们跨请求相等作为事实一致性的条件。

## 配置与隔离验证

- Auth：`UNIFIED_ACCOUNT_CONFIG` 明确 environmentId/kind/authOrigin/deliveryMode/providerMode；客户端、应用、产品及精确回调另行登记。
- Work：`MOLIS_WORK_ACCOUNT_CONFIG`，见 Work `docs/horizontal/account.md`。本机产品入口保持数字 loopback HTTP；环境、客户端和 canonical Home 参与凭据存储隔离。
- Club：`MOLIS_CLUB_ACCOUNT_CONFIG` 与独立运行时 `MOLIS_CLUB_ACCOUNT_KEY`，见 Club `docs/AUTH-SETUP.md`。密钥为随机 32 字节的无填充 base64url，重启保持相同，不进入普通构建变量。
- 本轮 LOCAL/MOCK 采用临时 D1/Home；测试从隔离 mock 投递记录取验证码，不提供万能验证码或正常产品接口返回验证码。真实配置缺失不自动回退 mock；PRODUCTION 拒绝 MOCK。

不要为复验运行会写既有本地状态的 `npm run dev`、`admin`、`db:seed` 或对真实服务运行历史 HTTP 写入脚本。使用 [交付记录](delivery.md) 点名的隔离命令，它们创建自己的合成数据。未授权读取真实 `.dev.vars`、Home、浏览器凭据或 `.wrangler/state`。

## 平台与租户管理

| 身份 | 现有操作 | 不隐含的权限 |
| --- | --- | --- |
| 平台人员 | 按中央 `TENANT_CREATE/READ/STATUS` 管理租户，`SUBSCRIPTION_READ/WRITE` 管理订阅；目录发布另需 `CATALOG_WRITE` | 不因平台身份加入租户、获得付费权益或管理成员席位分配 |
| 租户所有者 | 租户资料、成员、管理员任命、席位分配/回收、发起所有权交接 | 不能仅凭 OWNER 开通订阅、增加容量或停用租户 |
| 租户管理员 | 普通成员、资料、席位分配/回收，可自行退出 | 不能任命管理员或转让所有权；管理角色不自带付费功能 |
| 普通成员 | 个人资料、登录方式、本人订阅/权益，接受邀请、退出 | 无成员管理和平台商业权限 |

首个 v2 平台人员授权仍需制定受控运维流程：测试仅在临时库初始化 `auth_platform_permission`，这不构成生产授权工具；旧 `PLATFORM_ADMIN_IDS` / v1 Console 的管理员也不能被当作已获得 v2 能力。套餐通过中央目录发布接口维护，产品页读取已发布版本；本期没有另做套餐编辑 UI。正式平台授权、套餐/席位类型清单须在真实运行前确认。

成员先经定向邀请并确认加入。所有者交接须接收人确认；交接后原所有者成为 MEMBER，现有席位不变。退出或移除在中央事务内释放当前分配。订阅到期保留当前分配记录；同类型同容量续期可恢复仍有效成员的当前分配，已结束分配不复活。减量或换类型须先明确回收，不自动挑人。

两端账号页均能进行已获授权的管理操作；一端变更后另一端重新读取中央结果。个人订阅与当前租户有效席位按功能取并集，个人订阅不绕过租户成员资格或停用。停用继续计时，恢复按原期限判断；平台延期须记录原因。

## 退出、故障与回退

普通退出仅当前产品本次登录；全部退出覆盖该账号两产品所有登录。改密保留可信当前登录、撤销其余；找回重设撤销全部。退出远端撤销不确定时显示 UNCONFIRMED，不表示已让所有设备退出。离线缓存只能展示身份，不授权成员管理或付费功能；Work 本地能力继续可用。

Club 旧 `/api/auth` 路由已关闭，旧 Cookie 不接受；Work 不读取 personal 旧凭据。旧账号、资料和内容继续保留，但真实旧密码/第三方身份接续仍待 D-09。切换与回退按 [账号迁移方案](account-migration-plan.md)；不能恢复旧 Token、重新开放 Better Auth 写入口或整库覆盖切换后新事实。

两端登录页和账号安全区均有“无法使用登录方式？”折叠帮助。仍有可用方式时，登录并再次验证后绑定/换绑；仅忘记邮箱密码可走原找回密码入口。全部丢失时先向邮箱服务商、运营商或 Google/GitHub 找回原方式；首期没有人工恢复，新注册账号不自动继承原账号资料或内容。展开/收起帮助保留当前表单和会话。发现映射归属争议应保持待处理，不能通过新建同邮箱账号或替换映射接管历史内容。


## 共享资源访问合同夹具

K04-01 的 [测试资源 owner](../../worker/rust-tests/shared-resource-fixture.ts) 只由 [真实 Auth 专项](../../worker/rust-tests/entitlements.test.ts) 加载，不进入部署产物，不提供业务共享服务或对象存储。资源记录、内容、账号和订阅都是合成数据，临时 D1 在结束后销毁；外部服务继续 mock。

| 边界 | 约定 |
| --- | --- |
| 夹具请求 | `GET /resources/{resourceId}?operation=VIEW` 或 `DOWNLOAD`；这是测试本地 Request 的形状，不是新增中央 API 或产品公开路由 |
| 可信身份 | 资源服务通过 Host/BFF 持有的当前中央 bearer 校验；浏览器不持有该 Token。用户/角色请求头不转发；多余查询字段（如 tenantId/userId）拒绝 |
| 资源范围 | 用资源 owner 的记录查出所属 tenantId，再调用现有 `GET /api/v2/tenants/{tenantId}`。不接受页面选择的租户代替资源范围 |
| 基础开放 | 中央会话有效、该租户启用且用户为有效成员即可；OWNER/ADMIN/MEMBER 相同，不调用付费权益接口，无个人订阅和租户席位也允许 |
| 返回内容 | Auth 返回匹配合同且 tenantId 相同、状态 ACTIVE 后才读取合成正文；VIEW 返回 inline，DOWNLOAD 返回 attachment，均 no-store；不发长期公开下载 URL |
| 拒绝 | 无有效登录为 401；不存在/非成员统一 404；停用/无权为 403；Auth 网络故障、非成功或不合法/跨租户响应为 503。所有拒绝都没有正文内容或下载头 |
| 失效 | 每次查看和下载重新校验；退出/移除、租户停用、会话撤销后，下一次请求拒绝；另一租户/个人订阅不受影响，也不能绕过拒绝 |

无订阅/席位、角色、个人付费非成员、回收/到期/停用订阅、租户停用恢复、成员退出/移除/重入、两个产品的独立会话及中央故障已有 6 组场景。实际共享路由、存储、缓存/CDN、预签名 URL、分页/范围下载与执行中撤权需要后续业务接入时单独设计和验证；本夹具只证明每次请求放行点的合同，不承诺长下载期间的持续授权。
