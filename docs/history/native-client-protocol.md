# macOS 接入协议与进程生命周期

更新：2026-09-15。本文件交付协议说明，不是原生 SDK 或 App。Auth 与 SDK 独立交付，不修改 GoalBoard。
已有服务端原生强制认证/精确回调/PKCE 测试；真正 macOS 系统认证会话、回调唤起和关闭重开验收尚未完成。

## 客户端登记

部署管理员在 Auth 登记独立的 `MACOS` 公共客户端，与同产品的 `WEB` 客户端分开。客户端不包含 client_secret，也不能放入后端服务凭据。
登记应用、允许 scopes 和精确回调；`account` 用于本人身份及退出，不代表业务权限。

当前 Auth 接受有 host 的自定义 scheme，例如 `com.example.product://auth/callback`；这只是示例，实际名称由产品确定并在系统登记。
同时支持预先登记的 HTTPS 回调或 loopback HTTP 回调，但不接受任意动态端口、通配符或未登记 URI。
因此当前实现不能声称支持 RFC 8252 的动态 loopback 端口流程。不得临时放宽精确回调校验来接入 CLI。

采用系统提供的外部认证会话，macOS 可评估 `ASWebAuthenticationSession`；不把 Google/Apple 页面装进能读取网页或 Cookie 的自建 WebView。
外部浏览器与 PKCE 的安全理由见 [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)，系统接口见 [Apple 文档](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)。
具体系统版本、回调 API 与打包 entitlement 需在原生应用实施时验证，不能直接把此文视为已编译的 Swift 示例。

## 登录流程

1. 用户点击登录。原生进程生成独立的 32 字节密码学随机 verifier 和 state，使用无填充 base64url；challenge 为 verifier 的 SHA-256 再作 base64url。
2. 原生 HTTP 客户端向 Auth `POST /api/v1/auth/transactions`，发送已登记的 clientId、redirectUri、codeChallenge、`codeChallengeMethod: S256`、state、scopes、`forceLogin: true`。不伪造浏览器 Origin、不携带 Auth Cookie。
3. 验证响应 transaction 格式，以及 loginUrl 精确为配置中的 Auth origin 加 `/login#transaction=…`；在系统认证会话中打开它。不能跟随服务响应中的任意 URL。
4. 用户在 Auth 托管页使用本地账号或已配置的第三方方式。Google/Apple 原始 code、Token、密码和签名密钥只在供应商/Auth 流程中处理，不交给原生产品。
5. Auth 完成页展示真实账号和目标应用，准备短期浏览器绑定；用户明确确认后才消费已认证事务，返回登记的回调以及单次 code/state。原生类型不会设置或恢复 Auth 长期浏览器会话 Cookie，短期确认 Cookie 不属于可恢复登录态。
6. 系统回调只交给当前仍存活的待处理登录操作。严格检查 scheme/host/path/原有查询参数，拒绝重复 code/state/error、额外参数、未知 state、过期流程以及非登记回调；删除待处理状态，随后只兑换一次。
7. 向固定 Auth `/oauth2/token` POST form-urlencoded：`grant_type=authorization_code`、`client_id`、`redirect_uri`、`code`、原 `code_verifier`。不发送公共客户端 Secret，不重定向、不自动重试。
8. 校验 Bearer 类型、Token 格式、有效期和 scopes；Access/Refresh 只放在当前进程内存。业务请求携带用户 Access Token，业务后端另外使用 Java Starter/服务身份调用 Auth 鉴权。

原生程序可以保留自己的登录入口/品牌页面，但第三方密码输入始终留给官方页面。本期不承诺原生自建密码表单的完整实现。
公共页面跨域交接已加入 [浏览器绑定和显式账号确认](login-confirmation.md)。原生应用不直接以无 Origin/空正文调用完成 API，而是让 Auth 页面完成确认并回调；仍不得将目前的 HTTP 合同测试当作真实原生链路验收。

## 重开应用与“记住账号”

| 场景 | 客户端必须执行 |
|---|---|
| 进程首次启动、崩溃重启、系统重启 | 无登录态；清空遗留待处理流程，重新完整认证 |
| 仅关闭窗口，进程仍在运行 | 不等于进程重启；具体是否同时退出由产品窗口行为决定，不能偷偷解释成永久登录 |
| 同一进程内 Access 临近到期 | 可用内存 Refresh 单次轮换；合并并发刷新，未知结果清空本地会话并重新登录 |
| 用户明确退出 | 发起当前授权会话退出，始终清空本地 Token/流程，拒绝晚返回的登录或刷新结果；服务端未确认撤销时明确提示 |
| 旧回调把已退出的应用重新唤起 | 没有当前进程的 verifier/state，直接拒绝；不得从回调自行恢复身份 |

“记住账号”只保存用户选择的显示邮箱/登录方式，不能保存密码、Token、PKCE verifier、事务密钥或已完成身份验证的标记。
本期策略是不把会话 Token 写入 Keychain、UserDefaults、文件、日志、剪贴板或崩溃上报；使用安全存储也不能绕过已确认的“重开需重新登录”。
服务端不能可靠知道客户端进程何时崩溃；内存材料丢失不等于服务端根会话已经撤销。会话按期限或显式退出收敛，不声称能远程证明进程已退出。

`MACOS`/`CLI` 即使传入 forceLogin=false，服务端仍强制 true；`/restore` 返回 FULL_LOGIN_REQUIRED。
这是禁止复用 Auth Cookie 的保证，不是“Google/Apple 每次必然要求重输密码”的保证。供应商可能复用自己的登录会话；当前代码没有统一的上游强制重新认证能力。
`ASWebAuthenticationSession` 的临时浏览会话偏好也不能代替 Auth 服务端校验或保证供应商每次重新输入密码。若需要这一更强语义，须另行对齐并实测供应商能力。

## 取消、超时与并发

只保留一个进行中的登录操作，并用进程内 generation 标记区分新旧操作。退出或新登录使旧回调/刷新失效。
用户关闭系统登录窗口、网络结果未知、校验失败、10 分钟事务期限到达时，销毁待处理材料；重新发起须生成新的 verifier/state，不复用 code/Refresh。
后台服务器共享 MySQL/Redis 保持状态；不能依赖命中同一节点，也不能在 Redis 故障时改用本机内存放行。
产品退出不会注销用户的 Google/Apple 账号；不会解绑、删除身份或影响其他系统中的供应商登录。

## CLI 与验收清单

CLI 只预留 `CLI` 类型和同样的强制完整认证规则。尚无 Device Authorization Grant、动态 loopback 端口或 CLI SDK，不要求用户把授权码粘贴到终端。

原生应用实施时至少验收：系统浏览器回调、错误/重复/过期 state、回调 URI 劫持下的 PKCE 拒绝、取消重开、崩溃后旧回调拒绝、内存 Token 不落盘、刷新响应丢失、退出竞态、真实独立 HTTPS 域名、多 Auth 节点、Google/Apple 各自的完整流程。
同邮箱补证明/关联、主动绑定解绑和真实供应商凭据仍见 [外部身份待办](external-identity.md)。
