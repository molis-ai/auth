# Auth 第二轮 5.2 · D1 读副本评估

核查日期为 2026-11-25，原代码基线为 `29381204d2c70fdf664d1bc4e93ce2523ed59778`，在 B-2 的 A/C 集成基线 `a7af6045ec7686d9a4ca47d4b8c334dc50c32ea5` 上复核。本文记录路由决策与 test 验证方案。副本开关、Sessions API 接入、部署和应用迁移分别留待后续决定。

## 配置与测量范围

| 环境 | 仓库登记的 Worker | 仓库登记的 D1 | 远端副本模式与实际服务地域 | 本轮实测 Worker → D1 RTT |
| --- | --- | --- | --- | --- |
| `test` | `molis-auth-test` | `molis-auth-test` (`a40965f5-e9e9-4d97-b471-d4e76368630e`) | 未读回 | 未测 |
| `prod` | `molis-auth-production` | `molis-auth-prod` (`649fadf9-f897-4d37-915c-b404ec336e69`) | 未读回 | 未测 |

上述目标在环境 properties 和平台目标登记中一致。部署器生成 `DB` 绑定及迁移目录。回环 `test` 显式使用远端测试库，本轮的隔离测试应使用本地 fixture。副本模式由 D1 实例配置，不能从绑定声明推知。`Store` 直接对 `D1Database` 调用 `prepare`、`batch`，基线无 Sessions API 调用。按 Cloudflare 的路由规则，即使实例已开启副本，这些绑定调用仍走主库。 [目标登记](../config/platform-targets.json) · [test 配置](../config/test.properties) · [prod 配置](../config/prod.properties) · [绑定生成](../worker/scripts/environment.mjs) · [Store](../worker/rust/src/store.rs) · [Cloudflare 全局读副本](https://developers.cloudflare.com/d1/best-practices/read-replication/)

原方案给出的 `NRT`、约 `80–90 ms` 以及启用副本后约 `10 ms` 都缺少本轮采样。当前记录无法确认请求所在 Worker colo、实际服务 D1 地域、跨区 RTT 或副本命中率。本地 workerd/SQLite 能核验 SQL、批处理、错误码与并发围栏。Cloudflare 的实际地域、复制延迟及网络往返需要远端 Worker 样本。 [Cloudflare D1 响应元数据说明](https://developers.cloudflare.com/d1/best-practices/read-replication/#check-where-d1-request-was-processed)

## 路由与一致性决策

Cloudflare 异步复制主库提交。`withSession('first-unconstrained')` 可从任意副本版本起读。`first-primary` 将首次查询送往主库，后续查询仍可能使用副本。已有 bookmark 只保证读取到至少该版本的数据。同一 D1 Session 提供顺序一致性。当前主库绑定可继续承载所有要求最新授权状态的读写。如果将来接入 Sessions API，应把凭据、客户端策略、授权判断和受保护结果放在首次 `first-primary` 的同一批事务内，保留现有错误优先级。多次独立调用且每次都依赖最新状态的路径继续用主库绑定。 [D1 Database 与 Sessions API](https://developers.cloudflare.com/d1/worker-api/d1-database/) · [副本延迟与模型](https://developers.cloudflare.com/d1/best-practices/read-replication/#background-information)

| 路径 | 路由决定和依据 |
| --- | --- |
| `POST /api/v2/entitlements/check`、当前会话、认证后的 `/api/account/session`、`/api/account/me`、登录方式、租户、平台与账单读 | 走主库。其读取依赖最新的会话、账号状态、会话 epoch、客户端登记与策略，或成员、平台权限、权益状态。已有只读批处理应保留同批授权与数据读取。 |
| 带浏览器会话 cookie 的 `/api/account/session` | 走主库。请求在读取 `auth_web_session` 前无法可靠区分匿名与登录状态。快照滞后还可能读到旧浏览器会话版本，干扰续期、冲突处理和账号切换。缺失或无效 cookie 的分支可能创建匿名会话，也走主库。 |
| 租户、管理和账单分页 | 走主库。GET 路径可写入游标，保留初始 `READY` 浏览器会话版本、权限检查与依赖的重试语义。 |
| 刷新、重放吊销、注销、改密、账号或成员撤权 | 走主库。保持当前事务、写入守卫和重复拒绝行为。 |
| 无需读取账号状态的公共信息 | 仅在业务接受暂时返回旧版本时评估 `first-unconstrained`。`/api/account/auth/capabilities` 虽然匿名，仍检查已登记的客户端与应用、环境策略。应先确定策略停用后能否容忍短期显示旧登录选项。在确认前继续走主库。 |

**跨会话撤权。** 例如浏览器 A 撤销 B 的会话，或管理员 A 移除 B 的租户成员关系、撤销平台权限或禁用账号。B 的 cookie 或客户端仍可能携带撤权前的 bookmark。`withSession(bookmark_B)` 可读到撤权前的版本，因而无法单独保护 B 的下一次账号或租户读取。A 收到写入确认后，B、Work、Club 发起的受保护读必须在主库上按原契约检查失效状态，返回对应错误且不携带受保护数据。将授权查主库、业务数据查副本的拆法会打破现有同一快照约束，分页也可能生成错误的游标结果。 [浏览器会话与免租约路径](../worker/rust/src/web/web_session.rs) · [客户端及中央会话校验](../worker/rust/src/auth/login_sessions.rs) · [权益检查](../worker/rust/src/billing/entitlements.rs) · [分页协议](../worker/rust/src/tenants/protocol.rs)

**Bookmark 的适用范围。** 仅用来为允许副本读取的数据提供同一逻辑会话的写后读或单调读。成功写入后从参与该写入的 D1 Session 读取 `getBookmark()`。若以后携带 bookmark，应绑定环境、数据库和当前浏览器会话代次，注销或账号切换时清除。服务端保存方案需要计入提交后保存的额外读写成本，并通过版本围栏处理并发响应。通过响应头或 Cookie 携带时应保证完整性并考虑旧值重放及乱序返回。在无有效 bookmark 或无法判断是否足够新时，要求写后读一致性的路径回到主库。保持现有 token、Cookie 与第三方应用契约，避免使用 bookmark 作为凭据或记录其原值。 [Cloudflare bookmark 保证](https://developers.cloudflare.com/d1/best-practices/read-replication/#start-a-session-from-previous-context-bookmark)

## 后续 test 验收

1. 只读核对 Dashboard 的 D1 Settings 或读取 `GET /accounts/{account_id}/d1/database/{database_id}?fields=name,uuid,jurisdiction,running_in_region,read_replication`。分别记录 test 和 prod 的 `read_replication.mode`。模式为 `auto` 时由 Cloudflare 安排部署，实际服务地域以测试请求元数据为准。 [获取 D1 数据库元数据](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/) · [D1 数据地域](https://developers.cloudflare.com/d1/configuration/data-location/)
2. 获批后，在隔离 test 数据及同一版本 Worker 中，对相同 SQL、参数和负载比较当前主库绑定、`first-primary`、`first-unconstrained`、带写后 bookmark 的首个读。按 Worker colo、D1 服务地域、主库标记及冷热状态记录样本数、Worker 内 D1 调用耗时和路由总耗时的 p50/p95/p99、错误率、副本命中率。用 `meta.served_by_region` 和 `meta.served_by_primary` 核实命中，分开记录 SQLite 执行时间与 Worker 观察到的 D1 往返。对同一份数据测量写入确认至可见时间及 bookmark 等待成本。 [D1 路由可观测性](https://developers.cloudflare.com/d1/best-practices/read-replication/#check-where-d1-request-was-processed)
3. 至少使用两个独立浏览器会话和原生客户端，从不同 colo 重复测试。对改资料、建租户等验证同一逻辑会话写后读。对撤销 B 的会话、密码修改导致 epoch 推进、移除成员、租户停用、撤销平台权限和停用 client policy，先等待 A 看到写入成功，再由 B 携带之前的 cookie、token、bookmark 和游标调用受影响的读。检查 `/api/account/session`、`/api/account/me`、登录方式、租户/平台分页以及权益，断言每个接口既有错误优先级、响应无受保护数据、游标仍按原契约处理。覆盖复制滞后、账号切换、绑定轮换以及并发响应乱序。

## 核查记录

```sh
git rev-parse HEAD
git show HEAD:config/platform-targets.json
git show HEAD:config/test.properties
git show HEAD:config/prod.properties
git show HEAD:worker/scripts/environment.mjs
git grep -n -E 'read_without_lease|/api/account/session|/api/account/auth/capabilities|fn batch_read|withSession|with_session|fn active_lookup|fn active_actor' HEAD -- worker/rust/src web/src
git show HEAD:worker/rust/src/web/web_session.rs
git show HEAD:worker/rust/src/store.rs
```

本地源代码检查确认两套目标登记、Store 的主库绑定调用和浏览器会话的 DB 依赖。B-1 只读核查时，Wrangler 缓存的 OAuth access token 已过期，现有浏览器会话的 D1 仪表盘重载后仍停在“正在加载仪表板”。B-2 复核 `CLOUDFLARE_API_TOKEN`、`CF_API_TOKEN` 和对应 API key 环境变量，四项均未设置。两库远端副本模式和服务地域仍待授权会话读回。 [目标账户的 D1 仪表盘](https://dash.cloudflare.com/200c8682734af6babc8d4ae4afaff221/workers/d1)
