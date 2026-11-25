# 账号中心 Billing 接口

从 Auth 页面调用同源 `/api/account/billing`。登录 Cookie 由浏览器自动发送，写入沿用账号中心客户端保存的 CSRF 值。调用方使用同一个 `AccountClient` 实例，并以已登录的账号和当前选中团队构造查询。

| 方法 | 路径后缀 | 成功状态 | `data` 类型 |
| --- | --- | --- | --- |
| GET | `/catalog/plans` | 200 | `{ items: BillingPlan[] }` |
| GET | `/subscriptions` | 200 | `BillingSubscription` |
| GET | `/orders` | 200 | `BillingPage<BillingOrder>` |
| GET | `/orders/:id` | 200 | `BillingOrder` |
| POST | `/orders` | 201 | `BillingOrder` |
| POST | `/orders/:id/mock-pay` | 200 | `BillingOrder` |
| POST | `/orders/:id/refund` | 200 | `BillingOrder` |
| GET | `/credits/balance` | 200 | `BillingBalance` |
| GET | `/credits/ledger` | 200 | `BillingPage<BillingLedgerEntry>` |
| POST | `/entitlements/check` | 200 | `BillingEntitlement`，取决于 Billing 是否提供可选能力 |

数据类型见 [billing-types.ts](../web/src/lib/billing-types.ts)。金额为币种的最小单位，Credit 为整数，时间为 UTC Unix 毫秒。目录和余额等接口缺省使用 `product=WORK&ownerKind=USER`，个人 ID 通常省略。团队使用 `ownerKind=TENANT&ownerId=<tenantId>`。订单列表与流水支持 `limit`（默认 20，范围 1–100）和 `cursor`（原样使用上一页的 `nextCursor`）。团队成员读取团队余额和授权范围内的流水，团队订单读写需要当前 OWNER 或 ADMIN 角色。

## 页面调用示例

以下示例的导入路径适用于 `web/src/lib`。

```ts
import type { AccountClient } from "./account-client";
import type {
  BillingBalance, BillingOrder, BillingPage, CreateBillingOrder,
} from "./billing-types";

export function billingCalls(account: AccountClient, tenantId?: string) {
  const query = new URLSearchParams({
    product: "WORK",
    ownerKind: tenantId === undefined ? "USER" : "TENANT",
  });
  if (tenantId !== undefined) query.set("ownerId", tenantId);
  const path = (suffix: string, cursor?: string) => {
    const params = new URLSearchParams(query);
    if (cursor !== undefined) params.set("cursor", cursor);
    return `/billing${suffix}?${params}`;
  };
  return {
    balance: () => account.request<BillingBalance>(path("/credits/balance")),
    orders: (cursor?: string) => account.request<BillingPage<BillingOrder>>(path("/orders", cursor)),
    create: (input: CreateBillingOrder, key: string) =>
      account.request<BillingOrder>(path("/orders"), input, "POST", key),
    pay: (orderId: string, key: string) =>
      account.request<BillingOrder>(path(`/orders/${encodeURIComponent(orderId)}/mock-pay`), {}, "POST", key),
    refund: (orderId: string, key: string) =>
      account.request<BillingOrder>(path(`/orders/${encodeURIComponent(orderId)}/refund`), {}, "POST", key),
  };
}

// 按用户动作生成一次 key，并在同一动作重试时复用它。
const purchaseKey = crypto.randomUUID();
const input: CreateBillingOrder = {
  planId: "work-personal-test",
  interval: "MONTH",
  billingTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};
// 已登录后调用 billingCalls(account).create(input, purchaseKey)。
```

三个订单写入操作各自需要 `Idempotency-Key`。付款与退款可以省略请求体或传 `{}`。新操作使用新键，同一操作重试保留原键和参数。请求 ID 可通过 `X-Request-Id` 传入，缺省由 Auth 生成，响应头和 JSON 的 `requestId` 一致。

页面打开对应账单视图时加载数据。主体切换时清空旧数据，并用当前账号和主体的标识丢弃迟到响应。`AccountClient` 将失败封装为带 `code`、`status` 和 `requestId` 的 `AuthError`。例如 `403 TENANT_DISABLED`、`409 ORDER_EXPIRED`、`409 ORDER_NOT_REFUNDABLE` 用于业务提示，`503 AUTH_UNAVAILABLE` 与 `503 BILLING_UNAVAILABLE` 用于面板内的重试提示。余额读取失败时保留错误状态。
