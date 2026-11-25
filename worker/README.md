# Molis Auth Worker

后端位于 `rust/`，使用 Rust 编译为 WASM，在 Cloudflare Workers 上运行并通过 D1 持久化数据。

- [本地开发与验证](../README.md)
- [后端架构与安全边界](../docs/architecture.md)
- [Cloudflare 环境配置与部署](../docs/cloudflare-deployment.md)

## Billing 内网传输

- 将同一份高熵 32 字节随机值以无填充 base64url 写入两服务各自的私有配置。Auth 使用 `secrets/<env>.properties` 的 `MOLIS_INTERNAL_SECRET`，线上按环境分别配置。Worker 间通过 `X-Molis-Internal-Secret` 传递。
- test/prod 的 Auth 配置生成 `BILLING` Service Binding，指向同环境 Billing Worker 的 `BillingInternal` 命名入口。Billing 反向绑定同环境 Auth Worker 的 `AuthInternal` 入口，通过绑定调用 `/internal/v1/sessions/introspect` 和 `/internal/v1/subjects/verify`。线上 Auth 公网入口对 `/internal/v1/*` 返回 `404 NOT_FOUND`。
- 本地 dev 由 Auth 的现有启动器监听 `127.0.0.1:8787`，出站固定为 `127.0.0.1:8788`。test 的本地启动配置保持封闭。缺少线上绑定或共享密钥时，出站返回 `503 BILLING_UNAVAILABLE`。
- 同源 BFF 验证浏览器会话和 CSRF 后，调用 `rust/src/runtime/billing-transport.js` 中的 `billingFetch(env, { method, path, query, body, idempotencyKey, requestId, accessToken })`。必填的 `accessToken` 来自当前服务端网页会话。出站重建 Authorization 和共享密钥头，禁止重定向，账务结果按同源 BFF 合同返回。
- `AuthInternal` 接受两条 POST。introspect 接收 `{}` 并返回 `data.userId`。verify 接收 `{product:"WORK",owner:{kind,id}}` 并返回 `data.{userId,product,owner,role}`，个人 ID 可省略。两条路由只接受当前环境 `AUTH_WEB_CLIENT_ID` 下有效的中央访问凭证，网页 Token 不经过浏览器。这项许可限于 Work 账务。
- verify 在一次 Auth D1 读取中复核会话和所选团队的当前状态及成员角色，两条路由均不续活。Billing 在敏感写入及幂等回放前重新验证。验证返回与 Billing D1 提交之间存在跨库时间窗口，后续请求重新读取 Auth 权限。
