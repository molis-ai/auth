# Google 登录

Google 的真实 OIDC 适配由 Auth 持有；Auth 页面与 Work 网页、桌面客户端共用统一账号事务接口。桌面端通过系统浏览器打开授权地址，不内嵌 Google 登录、不携带 Google Client Secret。

## 配置

Google Auth Platform 创建 **Web application** 客户端。开发与生产使用独立项目/凭据，受众 External，只请求 `openid email profile`。当前使用服务端跳转流程，JavaScript origins 留空。

授权回调登记为 `<AUTH_ORIGIN>/api/v2/auth/external/google/callback`。例如本轮本地联调为 `http://127.0.0.1:8788/api/v2/auth/external/google/callback`；正式环境必须使用实际 Auth HTTPS 域名。Work 的产品回跳地址登记在 Auth 的客户端策略中，不登记为 Google 回调。

本地在已忽略的 `worker/.dev.vars` 配置：

```dotenv
UNIFIED_GOOGLE_CLIENT_ID=111
UNIFIED_GOOGLE_CLIENT_SECRET=222
```

替换为真实值；线上 Secret 通过 Worker secret 管理。保持 `PROVIDER_STATE_KEY` 已配置；可用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成并仅存入本地 `.dev.vars` 或线上 Secret。同时使 `UNIFIED_ACCOUNT_CONFIG.providerMode`、D1 `auth_environment.provider_mode` 和 Work 环境配置一致为 `LIVE`；D1 环境变更应增加 `version`，使在途旧事务失效。这是环境级开关，切换后 GitHub 也要求真实配置，不会回退模拟提供方。日常 MOCK 测试不需要真实密钥。

## 认证与边界

Google 授权使用 state、nonce、S256 PKCE；浏览器一次性启动票据和 HttpOnly Cookie 绑定沿用统一流程。回调在服务端兑换 code，使用 Google JWKS 验证 RS256 签名，并检查 issuer、audience、azp（如有）、nonce、有效期、签发时间和 subject。Google 附加的 scope/authuser/prompt/hd 只作为回调附加字段丢弃，不作为身份依据。

身份按规范化的 `https://accounts.google.com` + `sub` 保存，不按邮箱自动合并账号。Google 邮箱不会自动变成一个邮箱密码登录方式；已有用户应先登录原账号，再绑定 Google。Google token 与 client secret 不交给 Work，不写入审计日志。交换完成后仍检查事务取消、过期及客户端/环境版本，沿用绑定、替换和敏感操作再认证机制。

## 验证

`node --test --test-concurrency=1 worker/rust-tests/google-live.test.ts worker/rust-tests/github-live.test.ts worker/rust-tests/external-login.test.ts`

先运行 `npm --prefix worker run build:rust`。测试使用临时 D1、生成的 RSA 密钥和隔离的 Google 网络响应，覆盖跨产品会话、绑定/替换/再认证、签名及 claims 拒绝、浏览器绑定、回放与取消期间的迟到响应。真实 Google 账号同意授权仍需用户在系统浏览器完成。

## 本地网络代理

在自己的 `worker/.dev.vars` 中填写完整 HTTP/HTTPS 代理地址（端口由各自代理软件决定）：

```dotenv
AUTH_DEV_PROXY_URL=http://127.0.0.1:7993
```

留空表示直连。使用 HTTP 或 mixed 监听端口，不填 SOCKS 专用端口。修改后重启服务。此配置只由本地启动脚本读取，不改变线上 Worker 网络出口、不进入产品前端；示例文件不指定团队统一端口。进程环境中同名变量优先于 `.dev.vars`。

使用 `npm --prefix worker run dev` 启动已构建、已初始化的本地服务；本轮 8788 环境用 `npm --prefix worker run dev -- --port 8788`。首次初始化仍按根目录 `npm run dev` 执行。直接调用 `wrangler dev` 不会启用此自定义出口。

脚本使用 Wrangler 本地运行时的 `outboundService` 接管 Worker 的外部 fetch，通过 Undici HTTP CONNECT 代理转发。所有外部请求（包括 Google 和阿里云）走配置的代理，回环地址保持直连；保留 TLS 验证、10 秒超时，不自动重试或跟随重定向。代理不可用时明确失败，不悄悄回退直连。只记录脱敏的失败提示，不打印密钥、令牌或请求内容。无需修改系统的全局/TUN 设置。

## Google 个人资料

从已验证签名的 ID token 读取 name、email（仅 email_verified=true）、picture。头像仅接受 HTTPS Googleusercontent 域名，Auth 页面 CSP 允许该图片来源。资料保存在 Auth；默认昵称和空头像首次补齐，已编辑的昵称、上传或主动移除的头像不会被后续 Google 登录覆盖。旧版本创建的 Google 账号需重新登录一次获取资料；不保留 Google 访问令牌做后台拉取。

本人个人资料页优先显示已绑定的本地邮箱，否则显示 Google 验证邮箱。登录方式的 Google 行显示完整邮箱，不显示 subject 尾号；缺少可信邮箱时显示“Google 账号”。现有合同字段仍叫 maskedLabel，但 Google 行返回的是完整邮箱，仅由本人账号接口提供。显示邮箱不创建 auth_user_email、不启用邮箱密码登录、不自动合并账号。解绑时提供方元数据随身份删除。

## GitHub 个人资料

GitHub 登录复用上述 Auth 资料保存机制，从认证后的 `/user` 响应读取 name、login 和 avatar_url。昵称为空时使用 login；头像仅允许 HTTPS 的 avatars.githubusercontent.com，Auth 页面 CSP 同步放行。默认名称与空头像可在再次登录时补齐，用户主动修改的资料仍保留。登录方式显示完整 `@用户名`，不显示数字身份尾号。

本地与部署数据库均需应用 `0016_external_profile_username.sql`。旧 GitHub 账号重新登录一次即可获取资料，无需重新注册或解绑。公开邮箱没有验证声明，因此不会据此创建邮箱登录方式、合并账号或作为已验证联系邮箱。

## 退出与再次选择账号

退出清除并撤销 Molis 会话，不会退出浏览器中的 GitHub/Google 网站账号。两种提供方的授权链接均携带 `prompt=select_account`，再次登录时要求选择账号；不传 login_hint 自动指定旧账号。选择账号不等于强制重新输入第三方密码。适配器测试检查授权参数，Web 会话测试检查退出后为 ANONYMOUS 且账号管理接口拒绝访问。
