# Work / Club 统一账号接入与管理说明

> 2026-11-08：尚未上线，直接使用 V2，不保留旧账号、协议或 SDK 兼容。Auth 与 Work 的实现、验证及剩余验收见 [V2 整合方案](v2-consolidation.md)。Club 未在本次两个检出核对，不以历史记录代替当前验收。

本说明对应本分支合同开发版 1.2.0。真实域名、发送服务及 Google/GitHub LIVE 联调不由本地 mock 验证证明；历史 AUTH-12 [矩阵](acceptance-matrix.md)和[摘要](delivery-manifest.json)只记录当时交付。

## 入口与 SDK 选择

Work 使用 `horizontal/account` 及 Host 的账号入口；Auth 自身页面使用同源 BFF。邮箱/手机直接在当前页面完成，Google/GitHub 则回到登记的精确回调。当前隔离验证明确使用模拟提供方。Club 的历史接入使用 `lib/account` BFF，其当前代码不在本次验证范围。

`sdk/browser` 现行导出为 `AccountClient`，用于 Auth 的同源 `/api/account` BFF；不保存中央 Token，不再导出旧 `AuthClient`。Work 继续使用自己的 Host 请求助手以满足本机控制令牌、安装登录和一次性键要求。中央公共合同是 `contracts/unified-account`，Work 使用带 SHA-256 的固定副本；没有发布新的通用 npm 包。

| 层 | 使用的入口 | 身份与存储 |
| --- | --- | --- |
| Work 页面 | Host `/api/account/*`；非凭据操作映射同一 `system.account` 动作目录 | 控制令牌、同源校验、写操作一次性键由既有请求助手处理；中央 Token 仅由 Host SecretStore 持有 |
| Auth 页面 | 同源 `/api/account/*`，第三方回到 `/account/callback` | HttpOnly Cookie + CSRF；中央 Token 在 `auth_web_session` 中加密保存 |
| Host/BFF 到 Auth | 冻结 operationId 对应 `/api/v2/*` | 可信环境、应用/client/来源和当前独立登录；不接受页面自报 userId/product/actor |
| 后续业务功能 | 调用权益服务，由业务服务复核资源范围 | 页面“允许”只是展示，不是业务授权凭证；本期未接实际收费拦截 |

## 表单协议示例

以下是 Auth 同源 BFF 的邮箱密码登录步骤，字段来自现行合同。页面先 GET `/api/account/session` 取得匿名会话及响应的 `X-CSRF-Token`，随后所有写请求使用同源 Cookie、Origin、CSRF；凭据只在表单提交中短暂存在，不记录到日志、模型输入或持久存储。

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

完成后从响应安全视图或重新 GET session 更新界面；不读取/保存中央 code、proof 或 Token。Work 同样使用短时句柄，但须经其现有 Host 请求助手处理控制头和一次性写键，不能直接套用 Cookie 示例。注册、手机号、找回和再次验证的 purpose/method/step 组合以合同及现有页面实现为准，不拼出任意上游 URL。取消或结果未知应按实际状态处理，不盲重试已消费材料。

管理写入先读取资源 `version`，再传 `expectedVersion` 与一次逻辑操作的 `Idempotency-Key`；冲突后重新读取，由用户决定重试。权益查询虽然是 POST `/api/account/entitlements/check`，仍是只读操作，不发中央写幂等键。请求只包含 `{scope, featureIds}`；两端产品专属目录不同，共享功能标为 SHARED。分别返回的 `revision` / `validUntil` 可能受当前登录与请求范围影响，不将它们跨请求相等作为事实一致性的条件。

## 配置与隔离验证

- Auth：`UNIFIED_ACCOUNT_CONFIG` 明确 environmentId/kind/authOrigin/deliveryMode/providerMode；客户端、应用、产品及精确回调另行登记。自身 BFF 另需 `AUTH_WEB_CLIENT_ID` 和稳定随机密钥 `AUTH_WEB_SESSION_KEY`，详见[部署说明](../cloudflare-deployment.md)。
- Work：`MOLIS_WORK_ACCOUNT_CONFIG`，见 Work `docs/horizontal/account.md`。本机产品入口保持数字 loopback HTTP；环境、客户端和 canonical Home 参与凭据存储隔离。
- Club：`MOLIS_CLUB_ACCOUNT_CONFIG` 与独立运行时 `MOLIS_CLUB_ACCOUNT_KEY`，见 Club `docs/AUTH-SETUP.md`。密钥为随机 32 字节的无填充 base64url，重启保持相同，不进入普通构建变量。
- 本轮 LOCAL/MOCK 采用临时 D1/Home；测试从隔离 mock 投递记录取验证码，不提供万能验证码或正常产品接口返回验证码。真实配置缺失不自动回退 mock；PRODUCTION 拒绝 MOCK。

不要为复验运行会写既有本地状态的 `npm run dev`、`admin`、`db:seed` 或对真实服务运行历史 HTTP 写入脚本。使用 [交付记录](delivery.md) 点名的隔离命令，它们创建自己的合成数据。未授权读取真实 `.dev.vars`、Home、浏览器凭据或 `.wrangler/state`。

## 平台与租户管理

### 本地首位 V2 平台人员初始化

先在隔离环境通过 V2 注册用户并记录明确的 userId。随后可在 Auth 检出根目录执行 `node worker/scripts/bootstrap-platform.ts <registered-v2-user-id>`。该工具仅使用该检出的本地 Wrangler 配置，拒绝远程参数和非本机配置；目标须是有 V2 安全记录的有效用户，平台授权表必须为空。授权与审计在同一 batch，重复初始化或已有撤销记录均拒绝，不读取旧 PLATFORM_ADMIN_IDS，也不修改用户凭据。本次只在测试的临时 D1 调用内部初始化函数，没有对现有开发数据库执行此命令。它不是生产授权工具。普通授权/回收和用户状态已实现独立的 V2 平台能力与页面，服务端每次复核当前权限和版本。

### 创建策略（1.2.0 开发版）

2026-11-08 用户将 C-16 调整为策略控制。`TENANT_CREATION_POLICY` 是 Auth 的受信部署配置，允许 `SELF_SERVICE`（缺省值）和 `PLATFORM_ONLY`；未知取值拒绝自行创建，不回退为开放。它不是页面输入，也不是成员角色或套餐设置。

已登录产品可读取 `GET /api/v2/tenant-creation-policy`。自行创建使用 `POST /api/v2/tenants`、正文 `{name}` 与 Idempotency-Key，成功返回 TenantView；所有者只能是当前会话用户。`PLATFORM_ONLY` 模式拒绝该写入。平台仍通过原 `/api/v2/platform/tenants` 指定所有者，并继续要求 `TENANT_CREATE`，两种模式下都不向普通用户开放平台代建。

本阶段通过受控更新部署配置切换策略，不提供浏览器修改配置或运行中热切换接口；每个请求使用其部署版本的配置。需要即时切换时须先停止接收创建请求、排空旧版本在途请求再切换，不把已进入旧版本的请求视为被新配置追溯撤销。切换不修改已有成员或内容。创建不授予订阅或席位。Auth 与 Work 页面均已接入策略和自行创建；Club 待在其实际检出核对。

| 身份 | 现有操作 | 不隐含的权限 |
| --- | --- | --- |
| 平台人员 | 按中央 `TENANT_CREATE/READ/STATUS` 管理租户，`SUBSCRIPTION_READ/WRITE` 管理订阅；目录发布另需 `CATALOG_WRITE` | 不因平台身份加入租户、获得付费权益或管理成员席位分配 |
| 租户所有者 | 租户资料、成员、管理员任命、席位分配/回收、发起所有权交接 | 不能仅凭 OWNER 开通订阅、增加容量或停用租户 |
| 租户管理员 | 普通成员、资料、席位分配/回收，可自行退出 | 不能任命管理员或转让所有权；管理角色不自带付费功能 |
| 普通成员 | 个人资料、登录方式、本人订阅/权益，接受邀请、退出 | 无成员管理和平台商业权限 |

首个 v2 平台人员授权仍需制定受控运维流程：测试仅在临时库初始化 `auth_platform_permission`，这不构成生产授权工具；旧 `PLATFORM_ADMIN_IDS` / v1 Console 的管理员也不能被当作已获得 v2 能力。套餐通过中央目录发布接口维护，产品页读取已发布版本；本期没有另做套餐编辑 UI。正式平台授权、套餐/席位类型清单须在真实运行前确认。

成员先经定向邀请并确认加入。所有者交接须接收人确认；交接后原所有者成为 MEMBER，现有席位不变。退出或移除在中央事务内释放当前分配。订阅到期保留当前分配记录；同类型同容量续期可恢复仍有效成员的当前分配，已结束分配不复活。减量或换类型须先明确回收，不自动挑人。

两端账号页均能进行已获授权的管理操作；一端变更后另一端重新读取中央结果。个人订阅与当前租户有效席位按功能取并集，个人订阅不绕过租户成员资格或停用。停用继续计时，恢复按原期限判断；平台延期须记录原因。

## 退出与故障

普通退出仅当前产品本次登录；全部退出覆盖该账号两产品所有登录。改密保留可信当前登录、撤销其余；找回重设撤销全部。退出远端撤销不确定时显示 UNCONFIRMED，不表示已让所有设备退出。离线缓存只能展示身份，不授权成员管理或付费功能；Work 本地能力继续可用。

Auth 的旧认证、OAuth2、Team 和权限矩阵入口已删除，Work 不读取 personal 旧凭据。新环境直接注册 V2 用户，不设计旧密码、第三方身份、Cookie 或 Token 接续。[账号迁移方案](account-migration-plan.md)中的旧演练只作历史记录，不是现行操作流程。没有对真实库执行清空或自动重建。

仍有可用方式时，登录并再次验证后绑定/换绑；仅忘记邮箱密码可走找回密码入口。全部丢失时先向邮箱服务商、运营商或 Google/GitHub 找回原方式；首期没有人工恢复，新注册账号不自动继承原账号资料或内容，也不按相同邮箱自动合并。


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

## Auth 自身的 V2 浏览器入口

Auth Vue 页面也调用同源 `/api/account`。`AUTH_WEB_CLIENT_ID` 必须登记为当前环境的 V2 WEB 客户端，回调固定到 Auth origin 的 `/account/callback`。BFF 的 opaque HttpOnly Cookie 只引用 `auth_web_session`；D1 中的会话与待办证明用 `AUTH_WEB_SESSION_KEY` 加密，绑定记录 ID。写请求同时检查 Origin 与 CSRF，所有中央写入在原 BFF revision 上提交；退出先清本地会话并提高 revision，迟到写入不能恢复它。

登录成功后，BFF 在同一 guarded batch 中创建新的加密会话引用并删除匿名引用，响应更新 Cookie 和 CSRF。旧匿名 Cookie 不获得登录后的权限，旧 CSRF 不能写入新会话；失败的登录不向匿名引用保存认证材料。浏览器仍只接触 opaque Cookie，中央 Token 不进入响应。

浏览器 SDK 为 `AccountClient`，只发同源 Cookie/CSRF 请求。`request` 不自动重试写入；退出中止旧 generation。服务票据及无消费者的服务凭据管理已退役，没有对应产品映射；用户会话 Token 仍不向浏览器交付。
