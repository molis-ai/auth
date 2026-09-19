# Vue 认证网页：构建、运行与验收

更新：2026-09-15。登录、注册、找回、邮件确认、认证交接、平台控制台及空间管理页面已实现；完整账号安全中心及 Auth/SDK 整体尚未交付。
Google/Apple 入口已按有效部署配置接入，默认关闭；完成页账号确认已实现，邮箱补证明/关联和真实联调未完成，不能据此开放生产登录。

## 当前页面

| 路径 | 行为 |
|---|---|
| /、/login | 带有效认证事务时登录；WEB 非强制认证可顶层恢复已有 Auth Cookie |
| /provider | 产品 SDK 顶层交接；显示目标应用和供应商，明确点击才发起，可改用其他方式 |
| /register | 请求注册邮件，用户确认后输入显示名/新密码，接登录完成链路 |
| /forgot-password | 请求找回邮件，确认后重置；提示旧登录已失效，并新建事务重新登录 |
| /verify-email | 用户明确点击按钮才确认邮件；加载页面不 POST、不创建账号或改密码 |
| /complete | 展示真实账号/目标应用，建立短期浏览器绑定；明确确认才消费发码，取消保留原会话 |
| /console、/console/callback | 复用独立浏览器 SDK 的控制台及回调；普通用户管理本人空间/邀请，部署白名单管理员另有平台功能 |

所有认证网页需要 AUTH_LOGIN_ENABLED=true 和相应后端配置；注册/找回还要求有效邮件配置。
GET /api/v1/auth/ui-configuration 返回 Auth origin、邮箱流程开关、启用供应商名称列表及控制台公共客户端配置，不包含凭据或管理员名单。
无事务时展示“从原应用发起登录”，不接受任意 userId/redirect 等直接发码参数。
平台控制台初始化与操作见 [控制台说明](console.md)，空间和邀请见 [空间 API](space-api.md)。完整个人安全中心仍在后续切片；Owner 交接须先确认范围。

中文/英文可切换。语言与用户主动勾选的邮箱是唯一写入 localStorage 的值；密码、事务密钥、邮件 secret、Code、Token 均不持久化。控制台另外沿用 SDK 的短期 PKCE/state sessionStorage 与退出暂停标记，不保存 Token。
页面读取 fragment 后立即 replaceState 清除地址片段，密钥只在当前页面内存；刷新认证页面会丢失流程上下文，需要从应用重新发起。
第三方跳转前另以 sessionStorage 保存最多 10 分钟的允许字段重开提示（客户端、回调、challenge/state/scopes），不含原事务 secret、verifier、密码或 Token。
取消返回时读取即删除；重开必须由用户点击，服务端重新核对注册并强制完整登录，不能恢复已经消费的授权码。
注册/找回邮件必须在保留原流程页面的情况下确认，再回到原页面完成；只打开邮件链接不会替代原客户端事务。
密码每次提交后从表单清空。网络/服务未知结果不会自动重试提交；可重新创建绑定相同客户端/PKCE/state 的新事务并完整登录。
“记住邮箱”存储被浏览器禁用时不会阻止正常登录。

## 构建到同一个 Jar

需要 Java 21 和 Node 22.18+（本次本机验证 Node 26.4.0）；npm 必须位于 PATH。
前端依赖为固定版本，web/package-lock.json 纳入版本管理。Maven web profile 依次执行 npm ci、前端测试、类型检查和 Vite 构建，再把 web/dist 放入 Jar。
页面与业务端点共用 Auth origin，无 CDN 脚本、外部字体或分析追踪依赖。

```bash
./mvnw -B -ntp clean -Pweb package
```

生成 target/auth-0.0.1-SNAPSHOT.jar，静态资源位于 static/auth-ui；原 npm dist 不需要单独发布。
普通 ./mvnw test 不要求 Node 或数据库，也不会构建前端；不带 web profile 的干净 Jar 不包含 UI，开启登录时页面明确返回 503。
不要把不带前端的开发 Jar 当作完整交付物。发布前请始终 clean，避免残留旧哈希资源。

全量联合验收（只连接隔离测试库/Redis）：

```bash
./mvnw -B -ntp clean -Pweb,full-it \
  '-Dauth.it.jdbc-url=jdbc:mysql://127.0.0.1:43316/auth_test_example?connectionTimeZone=UTC' \
  -Dauth.it.redis-port=46379 verify
```

账号/Redis、邮件加密与 SMTP 配置沿用 [登录协议](login-protocol.md) 和 [邮件运行说明](mail-delivery.md)。
生产 AUTH_ISSUER 必须是外部 HTTPS Auth origin；反向代理受信任配置和真实生产部署仍待验收，不允许用任意转发头绕过安全检查。

## 分开启动开发服务

后端使用本机数据库/Redis，启用登录流程，并将 AUTH_ISSUER 设为浏览器真正访问的 Vite origin，例如 http://localhost:5173；后端自身监听 127.0.0.1:8080。
邮件确认链接也沿用此 issuer。Vite 的 /api 与 /oauth2 请求代理到后端，保留浏览器 Origin；不能让后端返回 8080 而前端运行在 5173 后忽略来源检查。

```bash
# 在后端已按上述环境变量配置并启动后
cd web
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

浏览器使用 http://localhost:5173；客户端登记的产品回调地址仍需精确匹配。
开发模式 base=/，生产资产 base=/auth-ui/。Vite 只绑定 loopback；其 HMR/CSP 行为不是生产验收证据。
完整 Cookie/路由/部署验收应使用已打包 Jar，而不只是 Vite 预览。

## 安全响应与测试证据

网页和静态资产沿用 HTTPS/loopback 边界、no-store；Referrer-Policy=no-referrer，禁止被 frame 嵌入。
CSP 限制脚本与连接为 self，无 unsafe-eval、第三方脚本或 iframe 登录恢复。Element Plus 的动态样式需要 style-src unsafe-inline；这不放宽 script-src。
跳转前前端再次核对 Auth 完成地址/事务、登记回调和原 state；标准产品 SDK 仍须独立验证自己的 state 与 PKCE，不能以 Auth 页面检查替代它。

- 前端 34 项 Node 测试：8 项认证协议、7 项控制台、3 项空间、3 项会话安全、7 项第三方协议、6 项账号确认状态/取消/不重试/双语测试。
- vue-tsc 与 Vite 生产构建通过；前端 JS/CSS 和页面已在实际 Jar 中核实。
- LoginHttpRedisIT 检查所有页面路由、实际 JS 资源、CSP/no-referrer/no-store，以及未启用邮件时 capability=false。
- 真实浏览器检查：窄屏及 1280×900 桌面布局、中英文切换、错误密码提示/密码清空、登录进入完成页。
- 真实浏览器顶层 Cookie 恢复后，跳至独立来源的本机回调接收器；接收器校验随机 state 并以原 PKCE verifier 兑换，HTTP 200 收到 Access/Refresh（不显示/持久化 Token）。

上述浏览器环境是 localhost:41880 与 127.0.0.1:41980 的隔离测试，不是生产独立主域名部署验收。
2026-09-15 新增第三方 UI 检查使用 127.0.0.1:43089 的临时静态构建预览与无认证能力的接口夹具：确认页目标显示、切换本地/Google/Apple、失败安全提示、取消返回片段清理、中英文提示已在实际浏览器操作验证。它不连接数据库/供应商，不证明 Token/Cookie/真实 TLS。
`/complete` 已改为明确账号确认并校验浏览器绑定，现允许受限的顶层 GET 导航，接口来源检查不放宽。真实 Jar/SDK/数据库在产品 127.0.0.1:41980 与 Auth localhost:41880 间验证密码→预览（无授权会话）→明确确认→SDK 成功回调；恢复后取消不增加授权且原会话未撤销。详见 [确认流程](login-confirmation.md)。
回调接收器只是临时测试进程，不是已交付的 SDK/示例服务。浏览器自动化没有创建或重置用户真实凭据。
注册/找回完整业务链路已通过真实 HTTP + 开发收件箱测试，但其 Vue 表单与实际收件的浏览器全链路尚待继续验收。
控制台同源 SDK 真实浏览器登录/恢复/退出与应用修改、白名单显示和双语列表已验证，边界见 console.md；这不代替独立主域名接入验收。
Google/Apple/SMTP 真实联调、完整账号安全中心、Owner 交接范围确认与 TS SDK 独立域名浏览器验收仍未完成；Java Starter 与独立业务示例已通过真实 HTTP/MySQL 联合验收，见 [Java SDK](../sdk/java/README.md)。
