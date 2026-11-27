# Auth 订阅与账单的同源转发

账号中心调用 `/api/account/billing/*`。Auth 校验 HttpOnly Cookie 会话及写请求 CSRF，将路径挂载到 Billing 的 `/api/v1/*`，转发原方法、查询串、JSON 和可选的 `Idempotency-Key`。出站请求只携带服务端会话凭据、共享密钥及固定的协议头。账务的路由、字段、业务校验、角色限制与错误码以 [Billing v1 接口合同](https://github.com/molis-ai/molis-billing/blob/main/docs/billing-v1-contract.md) 为准。

Auth 保留上游成功及业务错误的状态码，返回 `{data, requestId}` 或 `{error: {code, message}, requestId}`。响应头的 `X-Request-Id` 与响应体一致。超时、不可达、重定向或无效响应返回 `503 BILLING_UNAVAILABLE`。

test/prod 经同环境 `BILLING` Service Binding 调用 `BillingInternal`。本地 dev 连接固定回环端口 8788。Billing 通过 Auth 的私有入口复核身份、团队角色或平台审计权限。详见[Worker 传输说明](../worker/README.md#billing-内网传输)。
