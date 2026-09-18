# 跨域登录的账号确认与浏览器绑定

更新：2026-09-15。用户已确认接受 Auth 的“确认以此账号继续”步骤。已实现并接入 Vue；不改变业务产品自己的密码输入页面，不需要产品读取 Auth Cookie。

## 用户看到的流程

产品自有密码页 → Auth `/complete` → 显示已验证邮箱、账号 ID 和目标应用 → 用户确认 → 产品原回调 → SDK 校验 state 并以原 PKCE 兑换。

打开链接不会自动登录。当前所有 Auth 完成交接统一经过确认，包括托管密码、注册、供应商登录和 WEB Cookie 恢复。恢复仍复用原根会话，不延长原始认证期限；只是在返回产品前明确确认账号。
“不是我的账号，取消”只终止此次交接，不退出已有 Auth 会话、不注销供应商、不新增授权会话。用户可重新开始完整登录。

确认页仅显示服务端从已认证事务定位的用户与已验证邮箱，不能用 URL 中的 userId/email 或前端传入的身份代替。浏览器没有当前原产品的 PKCE/state 时，即便完成 Auth 步骤，产品 SDK 仍须拒绝不匹配的回调。
这里的绑定在**确认预览阶段**建立，不声称凭可转发链接就能识别最初输入密码的物理设备；安全性来自不自动切换身份、明确展示账号，以及随后确认不能跨浏览器冒用。

## 接口合同

共同要求：HTTPS、精确 Auth Origin、唯一有效 `X-Auth-Transaction`、JSON 正文、no-store。仅已有的 loopback 开发例外可使用 HTTP。产品 origin 不可直接调用以下步骤。

| 路径（均 POST /api/v1/auth/transactions） | JSON 正文 | 返回 data / 行为 |
|---|---|---|
| /confirmation | `{}` | `confirmation` 一次性证明、`account: {userId, emails}`；设置短期绑定 Cookie，不发 Code/Token/登录 Cookie |
| /complete | `{confirmation, confirmed: true}` | 校验 Cookie 与证明，原子消费事务后发码；data 为 `redirectTo`，需要时设置 Auth 登录 Cookie |
| /cancel | `{confirmation}` | 同样校验 Cookie 与证明并消费事务，返回 `{cancelled:true}`，不发码、不撤销原会话 |

原 `/complete` 的空正文不再有效；不能把 `confirmed:true` 单独当作身份凭据。
上述请求由 Auth 页面同源发出；浏览器 SDK 仍只需原来的 signInWithPassword/signIn/signInWithProvider/handleRedirect 接口。原生客户端同样经过 Auth 确认页，不再直接以无 Origin/空正文调用完成 API。

## 绑定与一次性语义

- Cookie 名为 `__Host-auth_confirm_<事务摘要>`，随机值独立生成；Secure、HttpOnly、SameSite=Strict、Path=/、无 Domain。HTTP loopback 使用 `auth_confirm_dev_` 前缀，不宣称有生产 Secure 保证。
- JSON 中的 confirmation 与 Cookie 值相互独立。JSON 永不包含 Cookie 值；前端证明只在页面私有内存，不写 URL、存储或日志。
- Redis 同一事务键保存两者的 SHA-256 摘要。Lua 原子绑定与消费，不依赖同一 JVM/节点；只允许 AUTHENTICATED 状态，无 TTL、过期或异常超过 10 分钟的 TTL 拒绝。
- 第一个成功预览的浏览器占有该确认；另一个没有同 Cookie 的浏览器不能重绑定。相同 Cookie 可再次预览，但会轮换页面证明，旧页面的确认立即失效；原 TTL 不延长。
- 错误/缺失/重复 Cookie、错误证明或其他事务的材料不会消费有效事务。确认与取消竞争时只允许一个消费成功；已消费状态不可恢复或重放。
- 首次绑定响应丢失、Cookie 被禁用或丢失时不降级绕过绑定；用户须从原应用重开。确认/取消响应未知时不自动重试，不显示成功。
- 预览每 IP 60 次/分钟；浏览器无当前事务 Cookie 且已有 5 个待确认 Cookie 时拒绝新增。Cookie 头上限 8 KiB。成功确认/取消只清除本事务短期 Cookie。

MySQL 中发码和登录 Cookie 摘要仍同事务提交，锁内复核账号、客户端、应用、scopes、回调及根会话当前状态。预览后账号被禁用时不能使用旧预览完成登录。
Redis 消费与 MySQL 提交不是分布式事务；发码失败或响应丢失不重建已消费凭据。取消不删除之前认证产生但未授权的根记录，该根没有本次新发的 Cookie/Code/Token。

## 页面与部署边界

`/complete` 现在只加载确认页面及预览，不自动 POST `/complete`。因此和其他公开入口一样，可以接收 GET + Sec-Fetch-Mode=navigate + Sec-Fetch-Dest=document 的跨站顶层导航，不返回跨站 CORS 许可。
API、POST/iframe 导航与重复 Origin 的限制没有放宽；CSP frame-ancestors none、无第三方脚本与 no-referrer 继续生效。

发布须将新后端与对应 Vue 静态资源作为同一个 clean 构建的 Jar 部署；需要结束旧版本认证流量并重新发起在途流程，不要混用仍支持旧完成合同的实例与新界面。没有 DB migration，Redis 新字段随短期事务自然失效；不需要清空整个 Redis。

## 验证证据

10 项 CompletionHttpRedisIT 使用实际 Spring MVC/安全链和隔离 MySQL/Redis，覆盖身份预览不发码、双证明与明确确认、跨浏览器/跨事务、同浏览器轮换、重复 Cookie、并发/重放、取消保留原会话、中途禁用、TTL、来源/正文和 Cookie 数量边界。
6 项前端测试验证加载只预览、明确点击才提交、取消、并发/未知结果不重试、无效响应拒绝和双语。现有登录/注册/Provider/SDK HTTP 用例已改为先预览再明确确认。

实际浏览器 + 打包 Jar + 隔离 MySQL/Redis + 已编译 SDK，在 `127.0.0.1:41980` 产品页和 `localhost:41880` Auth 间完成密码登录 → 账号确认 → 回调 URL 清理 → SDK 身份读取。
确认前数据库新根 Cookie 摘要为空且授权会话数为 0；确认后为 1。随后恢复登录并取消，原根仍未撤销，授权会话数仍为 1。长邮箱桌面布局与取消提示可见。
这些是独立 loopback 来源测试，不代替生产独立主域名/HTTPS、多机器和真实 Google/Apple 的 Cookie 策略验收。Google/Apple 补证明、账号关联/解绑及真实 SMTP 仍待完成。
