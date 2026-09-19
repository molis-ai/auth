# Browser Auth SDK（开发中）

框架无关的 TypeScript/ESM 用户登录客户端，无运行时依赖，不依赖 Vue。当前为私有本地包，不发布到 npm。
已实现托管/自定义密码登录、第三方登录入口交接、PKCE 回调、按需轮换、当前身份和退出；真实 HTTP 联动已验证，真实浏览器完整联合验收尚未通过，不是完整 V1 交付。
Auth 账号确认/浏览器绑定及本机跨来源 SDK 浏览器密码链路已验证；Google/Apple 的邮箱补证明/关联和真实联调仍待完成。注册/找回快捷 API、账号/空间管理 API 与 Java Starter 不在本包当前实现中。

## 构建

Node 22.18+、npm（Node 仅用于构建/测试，运行面向支持 Web Crypto、fetch 和私有字段的现代浏览器）：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
npm pack --dry-run
```

在仓库根也可执行 `npm run build`，构建 SDK、Vue 页面和 Worker 部署包（dry-run，不部署）。
SDK 产物为 dist/index.js 和 dist/index.d.ts，不会自动发布。接入项目可先引用本地构建包。

## 托管页面

每个产品页面生命周期创建一个实例；示例配置须替换为后台已登记的 WEB 客户端、精确回调、HTTPS Auth origin。
`account` scope 用于读取自身身份和退出；不是平台管理员权限。

```ts
import { AuthClient, AuthError } from '@molis/auth-browser'

export const auth = new AuthClient({
  issuer: 'https://auth.example.com',
  clientId: 'product-web',
  redirectUri: 'https://product.example.com/auth/callback',
  scopes: ['account'],
})

// 回调页应在加载分析脚本/其他第三方资源前执行；页面自身也应设置 no-referrer。
try {
  const completed = await auth.handleRedirect()
  if (completed) {
    const user = await auth.currentUser()
    // 用 user 渲染已登录页面；不要将 Token 写入日志或存储。
  }
} catch (error) {
  if (error instanceof AuthError) {
    // 显示本地化错误并让用户重新开始；不要重试已消费的 code/refresh。
  }
}

// 登录按钮：await auth.signIn()
// 需要主动完整认证：await auth.signIn({ forceLogin: true })
// 非回调页面启动恢复：await auth.restore()
```

`restore()` 不是无感 iframe：允许恢复时会顶层跳到 Auth；Auth 页读取自己的 Cookie，再回到产品回调。
普通退出后返回 false，不跳转；必须由用户点击登录，调用 signIn/beginLogin 才解除暂停。
不要在回调失败分支循环调用 restore；应显示重新登录入口，避免跳转循环。

## 产品自己的登录页

```ts
// 提交按钮处理中禁用重复点击；email/password 来自当前表单，提交后清空密码。
await auth.signInWithPassword(email, password)
```

SDK 自动创建绑定客户端和 PKCE 的认证事务，密码直接 HTTPS POST 给 Auth，随后顶层跳到 Auth 完成交接。
Auth 现在显示账号/目标并等待明确确认，不会加载后自动设置登录 Cookie；确认和取消都需要浏览器绑定与一次性证明。这个步骤由 Auth 页面完成，产品 SDK 调用方式不变，见 [确认合同](../../docs/login-confirmation.md)。
也可先调用 beginLogin 取得托管 loginUrl，再选择自定义密码提交。SDK 不记忆密码，不从邮箱后缀推断 Google/Apple 身份。
这不是 OAuth password grant；Token 仍由单次授权码加原 PKCE verifier 兑换。

产品自己的第三方按钮可以调用：

```ts
await auth.signInWithProvider('google') // 或 'apple'
```

SDK 创建新的 forceLogin=true 事务和 PKCE/state，顶层跳转到固定 Auth `/provider#transaction=…&provider=google`。
Auth 页面清除片段、展示目标应用，用户明确确认后再同源发起供应商登录。产品不读写供应商 Cookie、不收取供应商 Token、不直接调用 Provider start API。
未知供应商在任何网络或状态修改之前拒绝；退出/新流程使在途旧请求失效。创建响应丢失返回 RESULT_UNKNOWN，不自动重试或跳转。
Auth 仅显示部署显式配置的供应商；默认关闭。用户可以改用其他登录方式，取消/失败后可用短期上下文明确重开，不重试旧 code。
**当前不能作为生产可用的 Google/Apple 登录交付**：`/complete` 已加入账号确认/浏览器绑定，不再自动切换身份；但补证明、账号关联和真实供应商 HTTPS/Cookie 验收仍未完成。

## Token 与退出

`getAccessToken()` 返回内存中的用户 Access Token；临近过期（30 秒内）触发按需刷新，同实例并发共享一次刷新请求。
没有后台刷新定时器。业务请求只将 Access Token 发送给该产品受信任的 HTTPS 后端；后端仍必须向 Auth 进行身份和权限校验。
`authenticated` 仅表示本实例持有会话材料，不证明服务端当前仍允许任何操作。

```ts
const result = await auth.logout() // 仅当前产品授权会话
// await auth.logout({ all: true }) // 所有设备/产品及 Auth 恢复会话
if (!result.serverRevoked) {
  // 本地 Token 已清除，但服务端撤销未获确认；如有需要提示用户重新认证后全部退出。
}
if (!result.restorePaused) {
  // 浏览器存储不可用，不能承诺刷新页面后仍记住“暂停恢复”；当前实例仍暂停。
}
```

退出不注销 Google/Apple 本身、不解绑或删除账号。服务器失败、超时或返回无效撤销确认，均不会被当作撤销成功。
若退出时刷新已经开始，等该次结果后用最新 Access Token 撤销；进行中的旧登录/刷新不能重新填入本地 Token。
结果不确定时不盲目重试消费型请求。SDK 不能保证网络完全中断时服务端撤销，因此显式返回确认状态。

## 存储与边界

- Access/Refresh Token 仅在实例私有内存中；不得由接入方写入 localStorage、sessionStorage、Cookie、URL 或日志。
- 跨顶层跳转需要 sessionStorage 短期保存 PKCE verifier、state、创建时间，最长接受 10 分钟；兑换前删除。
  此处没有 Access/Refresh Token。存储失败时终止登录，不降级为失去 state 绑定的流程。
- 暂停自动恢复标记也使用 sessionStorage，限当前标签页；不提供跨标签页、关闭浏览器后或存储清除后的永久退出偏好同步。
- 同标签页/同客户端只保留一个待处理登录事务；新事务替代旧事务。一个页面不要创建多个并行管理同会话的实例。
- 默认请求超时 12 秒，可配置 1–30 秒；credentials:omit、cache:no-store、redirect:error，不携带 Auth Cookie 做跨域 AJAX。
- 身份 API 用 Bearer Access Token；代码交换、刷新无客户端 Secret。SDK 永远不存后端服务 Secret。
- 浏览器内存和 sessionStorage 均不能防御已经在产品 origin 执行的恶意脚本；接入方仍须配置 CSP、限制第三方脚本、防止 XSS。

24 项 Node 协议/状态测试使用受控 HTTP 替身、真实 Web Crypto，不等同于真实浏览器 CORS/Cookie 或 Google/Apple 联调证据。

账号安全中心通过独立 API 确认当前根会话已撤销后，可调用 `await auth.logout({localOnly:true})`：仅清除本地 Token/流程、使在途刷新结果失效并保存恢复暂停标记，不请求刷新或二次退出，返回的 serverRevoked 始终为 false。不要用它代替服务端撤销；与 all 不可同时使用。restorePaused=false 表示暂停标记未能持久保存，应明确提示用户关闭页面。

## 真实服务联调与本机演示

仓库根运行 `npm test` 验证 SDK、前端及 Worker；启动 `npm run dev` 后执行 `npm run test:e2e` 验证本地 Workers 与 D1 的真实 HTTP 链路。
SDK 并发刷新和回调状态由 SDK 单元测试覆盖；端到端脚本覆盖注册、登录、PKCE、刷新重放、退出、团队和邀请，但不是完整浏览器 Cookie/CORS 验收。

`demo/` 是本机独立产品登录页，不进入 npm 包，也不提供业务后端。
准备专用测试用户、已登记 WEB 客户端及精确 `http://127.0.0.1:41980/callback` 回调后，从仓库根启动：

```sh
AUTH_DEMO_CLIENT_ID=已登记测试客户端ID node sdk/browser/demo/server.mjs
```

默认 Auth origin 为 http://127.0.0.1:8787；可用 AUTH_DEMO_ISSUER 与 AUTH_DEMO_PORT 调整，仍仅接受 loopback。
本页不预置用户/Secret，不显示 Token，不开启生产服务；提供自定义登录、Auth 托管登录、顶层恢复、身份和退出按钮。
Auth 通过根目录 `npm run dev` 启动；仅前端演示服务不具备任何认证后门。

2026-09-15 嵌入式浏览器实际检查：跨来源创建事务及密码请求成功，Auth 审计记录登录成功，但 SDK 调用导航后浏览器停留原页，
未完成 Auth 交接/回调。临时诊断证实调用到达导航函数；assign、replace、href 写法均未改变观察结果，因此未把改写导航当作已修复，
恢复原实现并移除诊断输出。原因尚未确定，须继续在可用浏览器环境复核；不能将上面的 HTTP 联调等同于这一浏览器验收通过。
# 主动绑定（仅 Auth 同源安全页面）

`await auth.bindProvider('google', displayedUserId)`（或 apple）先比对当前账号，再发起强制认证事务并进入提供方验证。页面应在调用前明确确认绑定目标，提示五分钟内完整认证要求，以及“提供方验证成功即绑定，之后取消登录不撤销绑定”。产品跨域页面不能直接调用；应进入 Auth 安全页。

绑定请求携带内存中的原 Access、同客户端认证事务，并仅对此同源接口允许安全 Cookie 响应。SDK 不保存旧 Token，不自动重试结果不明的写操作，不允许跳到非预期提供方域名。失败后重新登录并检查绑定列表。此功能不等同于自动邮箱合并。
