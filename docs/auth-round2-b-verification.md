# Auth 第二轮 B 节点重试与集成验收

| 用途 | 提交 |
| --- | --- |
| 原基线 | `29381204d2c70fdf664d1bc4e93ce2523ed59778` |
| A 接口读合批与页面并发 | `25a2a416e60b9f01d957c8d25e60d5305a8d5ec9` |
| B-1 索引、密码池与读副本评估 | `1ec04153c27b331dc74a62ce256100c2b2a5a752` |
| C 静态资源、登录首屏与 Worker 冷启动 | `793690ecb04eede2baaa4726bea631a99f103207` |
| B-2 工作树起点，已包含 A、C | `a7af6045ec7686d9a4ca47d4b8c334dc50c32ea5` |

使用 `git merge-tree $(git merge-base HEAD 1ec0415) HEAD 1ec0415` 复现上次冲突，定位到 D1 测试夹具的探针入口和响应头。B-2 在 A、C 基础上重放 B-1 差异。夹具同时保留 A 的计数和暂停，以及 B 的真实分页 SQL 与绑定采集。两处会话相关文件的三方文本结果保留 A 的当前会话与 activity 路径、C 的策略缓存，以及 B 的 refresh JOIN。候选是 B-2 工作树内容，交由集成服务暂存和提交。

## D1 迁移与分页

使用 Wrangler `4.166.0`，将 `d1 migrations apply auth-local --local --config <临时配置> --persist-to <临时目录>` 分别用于空库和已登记 `0020` 的隔离 D1。两条路径的 ledger 均依序包含 `0020_auth_baseline.sql` 和 `0021_perf_indexes.sql`，五个索引都存在，`PRAGMA foreign_key_check` 均返回空。升级保留了预置的 client/application 行。`0020` 的 Git blob 为 `323c42c2f57c7d59c00342c7c5e7ed42d05b0c0c`。`node --test worker/tests/schema.test.ts` 通过 7 项。

迁移校验沿用已有的 ledger 检查，它扫描当前迁移目录并要求登记每个文件。

`node --test worker/tests/tenants.test.ts` 在本地 workerd/D1 通过 17 项。夹具包含 2,048 行无关的转移、邀请、客户端及审计记录（各表），还有 512 个无关成员、512 个邮箱、512 个手机号及 256 个租户。运行 `ANALYZE` 后在真实请求路径捕获分页用的 SQL 和绑定值，并逐页执行 `EXPLAIN QUERY PLAN`。首页及游标页结果如下。

| 路径 | 业务大表访问 |
| --- | --- |
| `transfer.list` | `ix_tenant_membership_user` 按用户和成员状态查两路成员，`ix_ownership_transfer_from`、`ix_ownership_transfer_to` 分别按参与方和 `id > ?` 查转移。 |
| `invitation.list-mine` | `ix_tenant_invitation_user`、`ix_tenant_invitation_email`、`ix_tenant_invitation_phone` 分别按目标、`PENDING`、到期边界查邀请。邮箱及手机号由 `ix_user_email_user` 及 `ix_user_phone_user` 查绑定。 |
| `member.list` | `ix_tenant_membership_tenant_status_id` 按租户、状态和 `id > ?` 查成员。邮箱投影按 `ix_user_email_user` 查。 |
| `client.list` | `ix_client_application_id` 按应用和 `id > ?` 查客户端，产品按客户端主键索引查。 |
| `billing.tenant-audit` | `ix_management_audit_tenant_id` 按租户和 `id > ?` 查审计。 |

五条分页的业务表均显示索引 `SEARCH`。转移和邀请保留合并候选结果及临时排序，成员计划也保留临时排序。授权 CTE 有环境配置表及参数虚表扫描。`limit=1` 走完整游标链并重读游标页，断言返回 ID 唯一、递增，成员、客户端及审计的分页也覆盖。邀请验证指定用户、已验证邮箱和绑定手机号，并排除未验证邮箱、其他人的邮箱、过期、已拒绝与禁用租户。转移覆盖发送方、接收方、历史非活动成员、禁用租户及 PENDING 过期后的显示状态。`0020` 的活动成员唯一索引与转移两端不同的约束使有效数据下同一用户至多命中一端，查询仍保留 `UNION` 去重。

## 密码计算和 refresh

池包含 16 个固定名称，每次调用独立选槽。选槽与密码、盐、账号及绑定状态无关。同槽请求可能等待，运行时可以回收实例。原有 PBKDF2-HMAC-SHA256 600,000 轮、16 字节盐、32 字节派生结果及失败处理继续由现有实现执行。 [Cloudflare Durable Object 生命周期](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)

Refresh 使用 token hash 将 refresh token 与会话连接到一次读取中。先处理客户端策略和 IP 限流，再处理无效 grant、已使用 token 的重放和存活判断。保留轮换事务的 client/session/token guards，以及并发冲突后的撤销。密码交易创建与密码验证各自在原请求阶段计数，本轮沿用原限流调用。

对照版本取 B-2 候选源码，只将 `worker/rust/src/password_kdf.rs` 换回 `a7af604` 中的逐次唯一 ID 实现。对照和候选使用独立 `CARGO_TARGET_DIR`、Rust `1.96.0`、`worker-build 0.8.6` 和锁定依赖。对照 WASM SHA-256 为 `0ea39cb371dbb4c6a6aa0a3fc211594f2eee44b5e2aa4cefff50c3f6e4c393eb`，池化候选为 `35b08d4b791e2f64895f23035e593fc10cff003e2337e6b176cf84786f4b7195`。固定池名称只出现在候选产物。

```sh
CARGO_TARGET_DIR="$control_target" npm --prefix "$control_root/worker" run build:rust
CARGO_TARGET_DIR="$candidate_target" npm --prefix worker run build:rust
node worker/scripts/benchmark-password-kdf.mjs "$control_root/worker/rust/build" worker/rust/build
```

基准走真实密码登录路径与真实 KDF DO，D1 使用本机内存库。不存在的合成邮箱触发一次完整派生，预期内部返回 200，外部返回 `401 INVALID_CREDENTIALS`。每种模式两个新 workerd 运行，每次三批、每批八个并发请求，按基线、候选、候选、基线顺序运行。DO 进入时间是从发起 stub 请求至进入处理器的耗时，含本地调度和初始化。KDF 往返还包括处理器内的计算与等待。入场耗时无法单独刻画同槽的全部计算排队，因此一并记录每批重复目标数。

本机 Node `26.4.0`、workerd `1.20261119.1`。延迟单位为毫秒，分位数按 nearest rank 计算。

| 指标 | 基线 | 16 槽候选 |
| --- | ---: | ---: |
| 密码请求 p50 / p95 | 3017.1 / 3077.0 | 3055.2 / 3689.4 |
| KDF 往返 p50 / p95 | 1887 / 2259 | 1875 / 2240 |
| KDF 处理器进入 p50 / p95 | 1 / 3 | 1 / 2 |
| 每次运行的唯一 DO 数（各 24 次请求） | 24、24 | 13、12 |
| 同批选择已被该批另一请求选中的对象 | 0 | 9 |
| 意外响应或异常 | 0/48 | 0/48 |

全量回归和打包结束后单独跑基准。该样本观察到对象复用和批内同槽，池化候选的 KDF 往返 p95 下降 19 ms，端到端 p95 同时上升 612.4 ms（19.9%）。本机结果受 workerd 调度和共享 CPU 影响，Cloudflare 上的冷启动收益、排队和跨区耗时待实测。

## A、C 集成复核

- A 的 D1 探针对权益读取、登录方式和当前会话分别断言 1 读、0 写，活动写入断言 1 读、1 写。Chrome 回环实测，成员首页在租户列表返回后 0.90 ms 发出，当时邀请和转移响应仍由测试挂起。首屏登录方式请求先于 activity 42.20 ms。切换账号在登出派发前 0.20 ms 中止被挂起的旧账号读取，旧账号排队的 activity 派发次数为 0。线上权益 P95 待同口径实测。
- C 的静态路由在终审后恢复 Worker 优先。登录网络请求、Worker 调用量、CSS 和生产 WASM 体积以修订快照的同工具链实测为准。[C 集成复验](auth-round2-integration-verification.md)

## 本地回归

| 命令或范围 | 结果 |
| --- | --- |
| `npm run contracts:check` | 生成文件校验通过，合同测试 8 项，消费者校验 1 项。`git diff 2938120 -- contracts` 为空。 |
| `npm test` | 全量通过。环境配置 4 项、合同 8 项和消费者 1 项、Rust 25 + 26 项、workerd/D1 203 项、Web 56 项，均零失败。完整套件使用的 fixture WASM 与当前工作树产物的 SHA-256 相同。 |
| `npm --prefix worker run check` 与 `node worker/scripts/rust-check.mjs test` | 两套 feature 检查通过，默认及生产 feature 分别通过 25 和 26 项 Rust 测试。 |
| `MOLIS_WORK_SOURCE=/Users/zhuanghaozhe/IdeaProjects/molis-work npm run test:browser` | 31 项浏览器检查通过，使用临时 Chrome profile、回环服务及内存 D1。 |
| `npm run build` | Web 构建和 Worker fixture dry-run 通过。 |
| `node worker/scripts/verify-production-bundle.mjs` | 14 个哈希资源和 4 个 HTML 资源引用通过检查，生产准入和 Wrangler fixture dry-run 通过。生产 WASM 与 bundle 的 SHA-256 均为 `da99cfb2f350d59b96ee6490369dcb660794784b94bc067221d933c68cfc544a`。 |
| `npm run deploy -- --env test --dry-run` | 隔离快照使用 test 登记配置和合成的本地占位绑定通过打包预检，Wrangler 输出 `--dry-run: exiting now.`。该命令验证目标绑定与包结构，实际凭据、远端 D1 状态和部署仍待后续验证。 |

命名 DO 并发处理不同密码和盐，600,000 轮结果与 Node PBKDF2 一致。非法参数返回 400，缺少 KDF 返回 503，账号数量及交易状态保持原值。错误客户端重放返回 `INVALID_GRANT`，接着用新 access token 读取同一会话仍成功。正确客户端重放返回 `INVALID_GRANT` 并吊销本会话的新 token，另一会话仍可读取。并发 refresh 冲突与浏览器租约围栏也通过。

工作树路径含空格，合同测试的 URL 路径处理可能把空格编码当成文件名的一部分。尝试无空格软链接时，`--preserve-symlinks-main` 还影响了 npm 自身入口解析。改用真实的无空格临时源码快照运行原命令。Miniflare、Chrome 与 Wrangler 本地迁移需要临时回环端口，默认沙箱返回 `EPERM` 后用授权的本地隔离执行。基准、迁移和回归日志目录为 `/private/tmp/auth-b2-verify.MlKUas`。

## Test 环境待测

后续使用隔离 test 流量测量 KDF 冷启动与空闲恢复、不同并发档的队列尾延迟、对象分布与失败率。对测试数据核查索引创建耗时和实际分页访问，再决定是否应用迁移及部署。副本、跨地域 RTT、bookmark 与另一会话发起读取时的撤权验收见 [D1 读副本评估](d1-read-replication-assessment.md)。
