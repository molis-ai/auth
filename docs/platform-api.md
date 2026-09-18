# 平台管理 API（V1 实施切片）

状态：HTTP、MySQL 事务、白名单鉴权、平台 Vue 页面和部署初始化已实现，见 [控制台说明](console.md)；完整 OpenAPI 和生产验收仍待完成。
这不是用户注册后自动获得后台权限的机制，也不授予任何业务空间成员身份。

## 权限与配置

开启 `AUTH_LOGIN_ENABLED=true` 后注册 `/api/v1/platform/**` 路由。
`AUTH_PLATFORM_ADMIN_USER_IDS` 是逗号分隔的完整 UUID userId 白名单，对应配置 `auth.platform.admin-user-ids`。
默认空名单，没有管理员；格式错误启动失败。配置变更后重启生效，多实例应使用相同配置并完成滚动更新。
没有首个注册者特权、空间 Owner 提权、邀请管理员、修改白名单或编辑固定角色组合的 HTTP 接口。

每个请求必须携带当前有效的用户 `Authorization: Bearer <Access Token>`，并具有 `account` scope。
Refresh Token、Service Token、Cookie 或 caller 自报 userId 都不能代替该身份。
用户身份校验、白名单检查、修改及审计位于同一个 READ COMMITTED 事务，锁一直保留到提交。
白名单中的用户被停用或会话被撤销后，同样不能进入后台。

浏览器仅允许 Auth 自身 Origin；已登记的其他产品 Origin 也不能直接调用平台 API。
非浏览器可无 Origin 使用显式 Bearer，通过 HTTPS 调用；仅本机 loopback 测试允许 HTTP。
无跨域 Cookie 认证、无跨产品 CORS 开放。Secret 不得写入日志、URL、截图或浏览器持久存储。

## 公共协议

成功统一 HTTP 200：`{"data":...,"requestId":"服务端 UUID"}`。
失败：`{"error":{"code":"稳定错误码"},"requestId":"服务端 UUID"}`。
所有响应设置 no-store 和服务端生成的 `X-Request-ID`，不信任客户端提交的审计 ID。

POST/PUT 必须是 JSON 对象，最多 16 KiB；字段必须与下面接口定义完全一致，缺失/未知/重复字段、重复数组项、尾随第二个 JSON 值均拒绝。
不把数字、布尔值或 null 自动转换成字符串。POST/PUT 不接收查询参数。
只有列表 GET 接受 `cursor`、`limit`（默认 50、最大 200），重复及其他查询参数拒绝。
列表返回 `data.items` 与可空的 `data.nextCursor`。游标是服务端返回的完整 UUID，不是页号。
应用/用户/客户端/服务列表按数据库记录 id 升序；审计按发生时间、id 降序。详情 GET 不接收查询参数。

| 方法及路径（以下省略 `/api/v1/platform`） | 请求或用途 |
|---|---|
| GET `/me` | 当前 userId、platformAdministrator=true；无权限返回 403 |
| GET `/permission-catalog` | 可登记的固定应用动作目录，不可编辑角色权限 |
| GET `/applications` | 应用列表，id/name/status/version |
| GET `/applications/{appId}` | 应用详情及 actions |
| POST `/applications` | `{name,actions}`；新应用默认 ACTIVE，actions 可为空（不授予业务动作） |
| PUT `/applications/{appId}` | `{name,status,actions,version}`，完整替换可编辑配置 |
| GET `/applications/{appId}/clients` | 登录客户端列表，包含 id/clientId/applicationId/clientType/status/allowedScopes/version；allowedScopes 是空格分隔字符串 |
| GET `/clients/{clientId}` | 登录客户端详情，scopes/redirects 为数组 |
| POST `/applications/{appId}/clients` | `{clientId,clientType,scopes,redirects}`；默认 ACTIVE |
| PUT `/clients/{clientId}` | `{status,scopes,redirects,version}`；不可修改 clientId/type/所属应用 |
| GET `/applications/{appId}/services` | 服务 id/clientId/applicationId/name/status/activeCredentialId，不含 Secret 或摘要 |
| POST `/applications/{appId}/services` | `{name}`；成功仅此次返回 id/clientId/credentialId/secret |
| POST `/services/{clientId}/rotate` | `{}`；成功仅此次返回新凭据 id/secret |
| POST `/services/{clientId}/disable` | `{}`；立即停用服务及撤销凭据 |
| GET `/users` | 用户 id/displayName/status 列表，不包含凭据 |
| GET `/users/{userId}` | 用户详情及已验证邮箱列表 |
| PUT `/users/{userId}/status` | `{status}`，ACTIVE 或 DISABLED |
| GET `/audit` | 全局安全事件元数据，无密码、Token、Secret 或业务正文 |

应用名 1–120 字符，服务名 1–200 字符，不允许首尾空白和控制字符。
应用 actions 必须来自固定目录，不能在请求中创建新的动作。
登录 clientId 1–100 个 ASCII 字母/数字/`_.-`，首位字母或数字；`svc_` 保留给后端服务。
clientType 为 WEB/MACOS/CLI；scopes 为非空 `account`/`profile` 子集。

回调必须精确登记，1–20 个 ASCII URI，每个最多 1024 字符；禁止通配符、userinfo、fragment，以及已有 code/state/error 查询参数（包括编码后的参数名）。
WEB 要求 HTTPS，仅 loopback 可用 HTTP；MACOS/CLI 也可登记带 host 的反向域名自定义 scheme，例如 `ai.molis.app://oauth/callback`。
不允许 file/data/javascript 等通用非 HTTP scheme。这里只登记回调；实际登录仍执行现有 state、PKCE、事务绑定和精确匹配。

## 停用、恢复与并发语义

- 应用和登录客户端配置带递增 version。更新必须携带详情中的当前版本；冲突返回 409 VERSION_CONFLICT，重新读取后由操作者决定，不自动覆盖。
- 修改应用权限目录后，后续业务授权使用数据库当前目录；不缓存最终 Allow/Deny。
- 应用停用同事务撤销该应用全部用户授权和服务凭据。其他应用的授权及 Auth 根会话不因此撤销。
  恢复应用不复活旧授权、旧 Secret 或 Service Token；用户须重新获取授权，仍为 ACTIVE 的服务须重新轮换凭据。
  单独被停用的客户端保持 DISABLED；应用恢复不批量启用它们。
- 登录客户端任何配置更新都会撤销该客户端原有授权，包括仅修改回调或 scope 的情况。
  不改其他客户端授权，不删除根认证会话。应用本身为 DISABLED 时，即使客户端配置为 ACTIVE 也不能登录。
- 用户停用同事务撤销其全部设备根认证及产品授权；保留用户数据、成员、角色和 Owner，不自动转移所有者。
  恢复用户后必须重新认证，旧 Cookie/Token 不复活。
- 服务轮换立即撤销旧 Secret 和由它签发的 Token，不提供双凭据宽限期；已停用服务不可轮换。
  服务凭据创建/轮换/禁用复用 `ServiceIdentityService.*Locked`，不能脱离平台事务单独提交。
  原有 create/rotate/disable 仍是内部可信调用方法，不应直接暴露成未鉴权 API。
- 可以显式停用自己的用户或当前登录所属应用，成功响应后该 Token 随即失效。
  不存在“最后一个管理员”自动放行规则；恢复需要另一个有效白名单管理员或部署侧恢复流程。
- 请求超时或网络断开可能发生在提交后；创建/轮换没有自动幂等重放，客户端不能盲目重试或假定未提交。
  先查询登记状态，必要时对已确认服务重新执行一次显式轮换；旧 Secret 不可查询找回。

事务先锁管理员用户及会话，再锁目标应用/客户端；用户启停对操作者与目标 userId 排序加锁。
配置详情锁内读取版本与子配置，避免返回混合版本。多管理员交叉修改不同应用仍可能遇到数据库死锁/超时，返回 503，不能绕过锁或权限检查。
未进行生产并发容量测试，也未通过最终权限缓存换取吞吐。

## 审计与错误

平台修改记录有效 actorUserId、目标应用/登录客户端/用户、requestId、时间和非秘密变更摘要（状态、版本、数量）。
服务凭据生命周期保留原有专用审计字段。通过用户校验但不在白名单，以及无效用户凭据/缺少 scope 的平台访问拒绝，记录 `platform.access/DENIED`；事务提交后才返回拒绝。
语法、Origin 等在安全边界提前拒绝的请求当前不写数据库审计。成功的只读查询也不新增审计事件。
审计写入失败时，修改、授权撤销、凭据轮换全部回滚，并返回 503；不返回成功或普通权限拒绝。
平台白名单不参与业务空间授权，即使平台管理员也必须满足实际成员和应用动作规则。

错误：400 INVALID_REQUEST/JSON_REQUIRED/HTTPS_REQUIRED；401 UNAUTHENTICATED（Bearer challenge）；
403 ACCOUNT_SCOPE_REQUIRED/PLATFORM_ADMIN_REQUIRED/AUTH_ORIGIN_REQUIRED；404 NOT_FOUND；
409 VERSION_CONFLICT/ALREADY_EXISTS/APPLICATION_DISABLED/SERVICE_NOT_ACTIVE；413 REQUEST_TOO_LARGE；503 AUTH_UNAVAILABLE。
数据库细节及异常文本不返回给客户端。

## 验证与待交付

3 项白名单普通测试、13 项真实 HTTP/MySQL 平台测试，覆盖配置拒绝、身份类型隔离、空间 Owner 无提权、Origin/严格 JSON、版本并发、回调登记、
停用恢复不复活、凭据只返回一次、审计故障回滚、管理员停用与在途请求精确交错、平台身份不越权读取业务空间及分页审计。

部署初始化和平台 Vue 操作页已经接入，详见 console.md。空库使用部署显式开启的初始化服务创建公共控制台客户端，再走正常邮箱注册，并由部署方明确设置 userId 白名单；不使用测试夹具或“第一个注册者成为管理员”。
仍待：API OpenAPI 描述、完整服务认证失败审计/限流、凭据与账号启停的浏览器完整提交验收及生产环境验收。
