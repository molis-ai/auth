# Molis Auth Web 登录与业务鉴权接入方案

> 基于当前 TypeScript Worker 与 Browser SDK 实现整理。本文是现状接入合同，不表示所有路径已完成线上验收。
> 范围：Web 登录、注册、会话恢复、续期、退出、下游后端鉴权。Google/Apple 属于需额外配置与联调的可选能力。

## 1. 目标与系统职责

Auth 统一管理账号身份、登录会话、团队成员关系及应用角色授权。业务应用管理自己的业务数据和具体资源归属。

| 组件 | 职责 |
| --- | --- |
| 业务前端（如 Goalboard） | 发起登录、处理回调、在内存保存用户令牌、调用自己的后端 |
| Auth 登录页面 | 收集密码、恢复已有身份、完成浏览器绑定与账号确认 |
| Auth Worker | 验证身份、签发和撤销凭证、提供用户与权限接口 |
| Auth D1 | 保存账号、密码哈希、登录事务、会话、令牌哈希、成员关系与授权配置 |
| 业务后端 | 保管服务凭据、向 Auth 校验权限、检查资源归属后执行操作 |

正式 Auth origin：
`https://molis-auth-production.sparkling-silence-0a49.workers.dev`

当前是自定义登录事务 + 授权码/PKCE + Token 接口，不是完整通用 OIDC Provider。
不要假设存在标准 /authorize、/userinfo、发现文档或 JWKS，也不要把用户 Access Token 当成 JWT 本地解码验签。

## 2. 接入前登记

由平台超管在 Auth 登记：
1. 应用，例如 Goalboard。
2. WEB 登录客户端，例如 goalboard-web。
3. 精确回调 URL，例如 https://goalboard.example.com/auth/callback（示例，需替换）。
4. scopes：account；需要时加 profile，必须在客户端允许范围内。
5. 应用允许的 action 和角色权限矩阵。
6. 后端服务身份及服务 Secret，用于 client_credentials。

前端 clientId 是公开标识，不是密码；后端服务 Secret 不能交给浏览器。
回调必须精确匹配已登记地址；浏览器 Origin 按已启用 WEB 客户端的回调 origin 放行，再由具体客户端检查。
account/profile scope 不是团队角色，更不是平台超管权限。
本期角色为 OWNER、ADMIN、MEMBER、VIEWER；平台超管由独立用户 ID 白名单控制。

## 3. 首次托管登录的完整时序

### A. 业务前端创建登录事务

SDK 生成随机 state、code_verifier，并计算：
`code_challenge = BASE64URL(SHA256(code_verifier))`。

state 用于校验回调属于本次登录；PKCE 用于防止授权码被其他客户端窃取兑换。

```http
POST /api/v1/auth/transactions
Content-Type: application/json
```

```json
{
  "clientId": "goalboard-web",
  "redirectUri": "https://goalboard.example.com/auth/callback",
  "codeChallenge": "<S256 challenge>",
  "codeChallengeMethod": "S256",
  "state": "<random state>",
  "scopes": ["account"],
  "forceLogin": false
}
```

Auth 检查客户端、应用状态、回调、scope 和限流，创建有效期 10 分钟的事务：

```json
{
  "data": {
    "transaction": "<opaque transaction>",
    "loginUrl": "https://molis-auth-production.sparkling-silence-0a49.workers.dev/login#transaction=<opaque transaction>"
  },
  "requestId": "<request id>"
}
```

业务前端顶层跳转 loginUrl。SDK 在 sessionStorage 暂存 verifier/state/创建时间；
不在这里保存用户 Token 或密码。Auth 页面读取事务片段后清理 URL。

### B. Auth 页面验证身份

Auth 页面通过 GET /api/v1/auth/transactions/context 读取事务，
后续事务接口通过请求头 `X-Auth-Transaction: <transaction>` 关联请求。

邮箱密码登录：

```http
POST /api/v1/auth/transactions/password
Content-Type: application/json
X-Auth-Transaction: <transaction>
```

```json
{"email":"user@example.com","password":"<user input>"}
```

Auth 根据邮箱查询账号，校验启用状态及 PBKDF2-SHA256 密码哈希，执行 IP/邮箱限流。
数据库不保存明文密码；不存在账号也执行相应密码计算，失败统一返回 INVALID_CREDENTIALS。

成功后创建根登录会话 auth_authentication，事务由 READY 变为 AUTHENTICATED，返回：
`data.continueUrl = AUTH_ORIGIN + "/complete#transaction=..."`。
密码接口不直接返回 Access Token。

注册走 POST /api/v1/auth/transactions/signup，参数为 email/password/confirmPassword。
注册仅允许 Auth 同源发起；创建账号、凭据和个人空间后进入相同的交接流程。
当前邮箱不经过验证，不能据此认定用户拥有该邮箱；暂无邮件找回密码。

### C. Auth 同源页面完成浏览器绑定

/complete 页面调用 POST /api/v1/auth/transactions/confirmation，Body 为 {}。
后端返回一次性 confirmation proof 和账号信息，同时设置本次事务的 HttpOnly 浏览器绑定 Cookie。

随后调用：

```http
POST /api/v1/auth/transactions/complete
Content-Type: application/json
X-Auth-Transaction: <transaction>
```

```json
{"confirmation":"<one-use proof>","confirmed":true}
```

后端同时检查事务状态、有效期、proof、浏览器 Cookie 和根会话状态。
成功后事务变为 CONSUMED，生成一次性授权码，设置 Auth 根会话 Cookie，返回 data.redirectTo。

重要交互规则：
- 在 Auth 页面刚完成密码登录/注册，且存在匹配的短期主动登录标记：可自动完成。
- 从其他应用复用已有 Auth 会话：通常需要用户确认账号。
- 从业务自定义密码页经 SDK 交接：当前不会自动拥有 Auth 同源的主动登录标记，可能仍显示确认。
- sessionStorage 不可用或标记丢失时回退为明确确认。
- 无论是否展示确认 UI，都不能绕过后端 proof + Cookie 校验。
- 消费型交接失败或响应丢失，不要自动重复提交。

### D. 业务回调兑换 Token

浏览器回到已登记的回调：
`https://goalboard.example.com/auth/callback?code=...&state=...`

SDK 校验回调地址、state、参数重复和请求年龄，清理地址栏的 code/state，
消费本地 pending 材料，并兑换：

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&client_id=goalboard-web&redirect_uri=<URL encoded callback>&code=<code>&code_verifier=<verifier>
```

授权码 60 秒有效、只能用一次，且绑定客户端、回调和 PKCE challenge。
用户 Token 接口不能携带 client_secret 或 Basic Authorization。

Token 成功响应没有 data 包装：

```json
{
  "access_token":"<opaque token>",
  "refresh_token":"<opaque token>",
  "token_type":"Bearer",
  "expires_in":900,
  "scope":"account"
}
```

expires_in 实际可能受根会话剩余寿命限制而少于 900 秒，应读取返回值而不是硬编码。
SDK 将 Token 保存在内存。随后 GET /api/v1/users/me，携带用户 Bearer，取得可信用户身份。

## 4. 推荐的前端 SDK 接入

SDK 在 sdk/browser，当前是私有本地包，尚未发布公共 npm 包。
下面假设接入项目已经配置好该包依赖；不代表可以直接从公开 npm 安装。

```ts
import { AuthClient } from '@molis/auth-browser'

export const auth = new AuthClient({
  issuer: 'https://molis-auth-production.sparkling-silence-0a49.workers.dev',
  clientId: 'goalboard-web', // 替换成已登记的客户端
  redirectUri: 'https://goalboard.example.com/auth/callback',
  scopes: ['account'],
})

// 登录按钮点击时
await auth.signIn()

// 回调页面最先处理，早于统计脚本和其他第三方资源
if (await auth.handleRedirect()) {
  const user = await auth.currentUser()
  // 根据 user 加载应用
}

// 调用自己的业务后端
const access = await auth.getAccessToken()
await fetch('/api/projects', {
  headers: { Authorization: 'Bearer ' + access },
})

// 退出按钮
const result = await auth.logout()
// 清理应用用户状态并返回登录入口。
// result.serverRevoked=false 表示服务器撤销未确认，不能展示“已在服务器安全退出”。
```

这些是各自事件处理中的代码，不是建议在启动时依次执行整个代码块。
需要自己的登录表单时使用 `auth.signInWithPassword(email, password)`。
密码直接 HTTPS 提交 Auth，不经过业务后端；认证仍通过 PKCE 授权码流程完成，不是 password grant。
SDK 不含独立的业务注册快捷 API，注册应进入 Auth 托管页面。

## 5. Token、Cookie 与会话关系

| 对象 | 保存位置 | 寿命/用途 |
| --- | --- | --- |
| 登录事务 | D1；前端持短期事务引用 | 10 分钟，READY → AUTHENTICATED → CONSUMED |
| PKCE verifier / state | 业务 origin 的 sessionStorage | 仅登录跳转所需，SDK 兑换前移除 |
| confirmation proof | Auth 页面内存，D1 存哈希 | 单次交接，受事务有效期限制 |
| 交接 Cookie | Auth 域 HttpOnly/Secure/SameSite=Strict | 本次事务浏览器绑定，完成后清除 |
| 授权码 | 短期回调 URL，D1 存哈希 | 60 秒、单次使用 |
| 用户 Access Token | SDK 内存；D1 存哈希 | 最长 15 分钟，受撤销与根会话限制 |
| 用户 Refresh Token | SDK 内存；D1 存哈希 | 单次刷新轮换，受根会话有效期限制 |
| Auth 根会话 Cookie | Auth 域 HttpOnly/Secure/SameSite=Lax | 持久 Cookie，用于恢复已有身份 |
| 服务 Access Token | 业务后端内存/安全缓存；D1 存哈希 | 5 分钟，仅服务鉴权使用 |
| 后端服务 Secret | 业务后端 Secret 存储 | 不发浏览器，支持轮换/停用 |

当前根会话：最近记录活动 30 天内，且创建时间 90 天内，没有被撤销，用户仍启用。
“最近活动”是后端 activity_at，不等于每次接口请求都自动延期；业务活动上报由 authorization/activity 完成。
已签发的 Cookie/Refresh Token 有自己的到期时刻，不能将这些期限理解成无条件滚动续期。

## 6. 刷新页面与跨应用恢复

业务前端刷新后，内存 Token 丢失，不能从 localStorage 读取恢复。
通用 SDK 的 restore() 会发起顶层导航到 Auth，不是后台 iframe 静默续期；
返回 true 只表示已发起导航，不等于用户已经登录成功。

Auth 页面在非 forceLogin 的 WEB 事务下，通过自己的 Cookie 调用 transactions/restore。
有效会话可复用；不存在、撤销、过期则要求完整登录。
业务应用不能读取 Auth Cookie，也不能跨域直接模拟 Auth 同源交接。

Auth 控制台是特例：
- 它与 Auth 同源，console-restore.ts 可在当前页面内完成恢复、proof、换码，不需要整页跳转。
- 直接打开 /login 会为控制台创建 forceLogin=true 的请求，显示正常登录表单。
- 本机其他应用登录过并不天然意味着能复用；必须在同一浏览器上下文存在有效的 Auth Cookie。

当前使用持久 Cookie，不能保证“关闭浏览器后重开一定重新输入密码”。
如果产品要求严格重开再认证，需要另行设计并实现会话策略，不属于已完成能力。

## 7. 令牌续期与并发

SDK getAccessToken() 在凭证临近过期（30 秒窗口）时按需刷新，没有后台定时刷新。
同一 SDK 实例的并发刷新共享一次请求。

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&client_id=goalboard-web&refresh_token=<current refresh token>
```

刷新返回新的 Access Token 和 Refresh Token，旧 Refresh Token 被标记已使用。
再次使用旧 Refresh Token 会触发对应应用授权撤销。
网络超时不能判断服务端是否消费成功，所以 SDK 不盲目重试；清除不确定凭证并引导重新登录。
每个页面生命周期使用单一 SDK 实例，不能让多个实例共享并竞争同一个 Refresh Token。

## 8. 下游后端鉴权

登录身份与业务权限分开校验。浏览器持有 Token 不意味着可操作任何团队。

1. 平台为业务后端登记服务身份，归属于同一个应用。
2. 后端使用服务凭据调用 /oauth2/token：
   - Authorization: Basic <Base64(编码后的服务 clientId:编码后的 secret)>
   - Content-Type: application/x-www-form-urlencoded
   - Body: grant_type=client_credentials&scope=authorization
   - 返回有效期 300 秒的服务 Access Token；没有服务 Refresh Token。
3. 后端收到用户请求，提取用户 Access Token。
4. 对照业务数据库确定资源真实 spaceId；不能盲信浏览器提交的 spaceId。
5. 调用权限检查：

```http
POST /api/v1/authorization/check
Authorization: Bearer <service access token>
X-User-Token: <user access token>
Content-Type: application/json
```

```json
{"spaceId":"<space UUID>","action":"project.read"}
```

成功响应示例：

```json
{"data":{"allowed":true,"reason":"NONE","decisionId":"<id>"},"requestId":"<id>"}
```

只有请求成功、响应可解析且 allowed===true，才放行；超时、异常、403 或 allowed=false 都不能放行。
Auth 要求服务与用户 Token 属于同一个 application，不允许拿 Console 用户 Token 配 Goalboard 服务 Token。
这组接口禁止浏览器 Origin 请求；服务 Secret、服务 Token 不进浏览器。

当前授权实质是应用 + 空间成员角色 + action。
可选 resourceType/resourceId 未用于具体资产归属或逐条 ACL 判定，不能作为资源级授权已经实现的证明。
check 的结果不返回 userId；业务若要绑定创建人/审计操作者，应通过 /api/v1/users/me 获取经过验证的身份，不信任前端自报 userId。

## 9. 退出与撤销的实际语义

- POST /api/v1/sessions/current/logout：撤销当前根登录会话，连带使共享该根会话的应用授权失效。
- POST /api/v1/sessions/logout-all：撤销当前用户全部根会话。
- 浏览器 SDK 清理 Token、pending 和刷新状态；业务应用额外清理当前用户/团队/缓存。
- 服务端清除 Auth 根 Cookie 的响应，在跨域调用场景不应被当作浏览器 Cookie 必然已清除的保证。
  但服务端根会话撤销后，残留 Cookie 不能恢复已撤销会话。
- 退出后 SDK 用 sessionStorage 暂停当前标签页的自动恢复，用户主动登录可解除。
- localOnly 仅清理本地状态，不撤销服务器凭证，不可用来代替正常退出。
- 不注销 Google/Apple 网站本身，不删除账号或解除提供方关联。

注意：旧 Browser SDK README 中“仅退出当前产品授权”的描述与当前后端根会话撤销行为不一致；
联调以本文及 session-service.ts 实现为准。若希望严格仅退出单应用，需要调整后端合同后再接入。

## 10. 返回格式与错误处理

普通 /api/v1 接口成功：{ data, requestId }。
错误：{ error: { code }, requestId }，结合 HTTP 状态处理。
/oauth2/token 成功是顶层 token 字段；不要默认其错误一定符合完整标准 OAuth 错误结构。

常见错误：
- INVALID_TRANSACTION：事务过期/非法/状态不允许，重新发起登录。
- INVALID_CREDENTIALS：邮箱密码错误或账号不可用，不猜测具体原因。
- LOGIN_REQUIRED / FULL_LOGIN_REQUIRED：需要完整认证。
- INVALID_GRANT：授权码/刷新凭据失效，禁止消费型自动重试。
- ORIGIN_NOT_ALLOWED / INVALID_CLIENT：客户端或回调登记错误，检查配置。
- APPLICATION_MISMATCH：服务与用户凭证不属于同一应用。
- EMAIL_FLOW_UNAVAILABLE：当前邮件相关流程不可用。

日志记录 requestId、decisionId、业务操作结果；禁止记录密码、Cookie、授权码、完整 Token 和服务 Secret。
不把登录结果发给未登记回调，不把 Token 写入 URL/localStorage/sessionStorage。
前端防重复提交、清理回调 URL、使用 Referrer-Policy，且仍需常规 XSS 防护。

## 11. 第三方登录与超管

Google/Apple start/bind 与回调代码存在，但必须配置提供方凭据、正确 HTTPS 回调并完成真实浏览器联调。
不能按邮箱后缀推断提供方；同邮箱不能作为自动合并账号的充分条件。
当前无邮件验证/找回，不能把占位页面当成可用接口。

超管不使用特殊登录协议。正常登录后，后端按用户 ID 是否在 PLATFORM_ADMIN_IDS 白名单中判定。
团队 OWNER/ADMIN 不等于平台超管。初始正式白名单为空，不存在默认线上 admin 密码。

## 12. 联调验收

- 完整 PKCE 登录回调、state 错误、回调篡改、授权码重复兑换。
- 正确/错误密码、注册密码不一致、重复邮箱、禁用账号。
- Auth 托管页与业务自定义登录页交接，确认与取消。
- 刷新恢复、无有效 Cookie、forceLogin、主动退出后不自动恢复。
- Token 过期续期、并发刷新、刷新重放、响应丢失处理。
- 根会话撤销、全部退出、切换账号后清理旧团队与页面状态。
- 同应用服务鉴权、跨应用凭证拒绝、非成员拒绝、真实资产归属检查。
- 真实 Cloudflare Free 环境密码哈希/头像处理 CPU 和 D1 额度验证。

本地测试或页面能打开，不等于以上线上链路已全部验收。不要用生产用户数据跑批量 mock。

## 13. 实现位置（仓库相对路径）

- worker/rust/src/identity.rs：事务、密码/注册、恢复与交接、用户身份及撤销。
- worker/rust/src/tokens.rs：换码、刷新与服务 Token。
- worker/rust/src/authorization.rs：下游服务权限检查。
- worker/rust/src/app.rs：CORS、错误响应、页面路由。
- sdk/browser/src/index.ts：Browser SDK。
- web/src/App.vue、completion.ts、console-restore.ts：Auth 页面与控制台恢复。
