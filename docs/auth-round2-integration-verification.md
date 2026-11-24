# Auth 第二轮本地集成验收

## 验证快照

| 用途 | 提交 |
| --- | --- |
| 原基线 | `29381204d2c70fdf664d1bc4e93ce2523ed59778` |
| A 接口读合批与页面并发 | `25a2a416e60b9f01d957c8d25e60d5305a8d5ec9` |
| C 静态资源、登录首屏与 Worker 冷启动 | `793690ecb04eede2baaa4726bea631a99f103207` |
| A、C 合并 | `a7af6045ec7686d9a4ca47d4b8c334dc50c32ea5` |
| B 索引、密码计算池与读副本评估，同时为首次验收 HEAD | `8c293b7af0242ce9a23a7077118eda197ecd22b0` |
| 静态路由复验基点 | `15f9b8c1d9d6e434f17e8b9bf8d5748f26274cda` 加 C-2 工作树补丁 |

`git merge-base --is-ancestor` 核实 A、B、C 均包含在 HEAD。B 直接基于 A、C 的合并提交。首次验收由 HEAD 导出无空格的临时源码副本，执行前逐字节比对工作树的 257 个跟踪文件。Web、Worker 和 Rust 的锁文件均与前置安装记录一致。工具链为 Node 26.4.0、npm 11.17.0、Rust 1.96.0、worker-build 0.8.6、Vite 8.3.8、Binaryen 123.0.0、Wrangler 4.166.0、workerd 1.20261119.1 和 Chrome 158.0.8127.38。

`git diff --exit-code 2938120 HEAD -- contracts worker/migrations/0020_auth_baseline.sql` 退出 0。Auth 合同目录的 Git tree 在两端均为 `ed5a44ec3c7ebff43534ce1f6f8376396a1edd8a`。另对本地 Work `f27ce05e724a84a01f2d7a3abe740b61e55439af` 和 Club `f0fe9139f067e20f7fe597036ab9626dccb85583` 的消费者快照检查六份复制文件及各自清单里的 SHA-256，均为 6/6 匹配。

| 交叉改动 | 核对结果 |
| --- | --- |
| `web/src/App.vue` | A 的首屏活动调度、取消和账号代次检查与 C 的异步控制台、资料和安全编辑器共存。Chrome 覆盖读写顺序、登出中止、切换账号及按需加载。 |
| `worker/rust/src/auth/login_sessions.rs` | A 的当前会话单读与 activity 事务返回、B 的 refresh JOIN、C 的配置缓存都在 HEAD。用例覆盖凭据与策略错误优先级、重放吊销、并发 activity 和配置轮换。 |
| `worker/rust/src/app.rs` | A、B 的 API 路径与 C 的资源派发及已校验绑定共用入口。用例覆盖登录文档元数据、别名、GET/HEAD、缺失静态资源、API 路由和安全头。 |

## §4 首次本地门禁

| 命令 | 结果 |
| --- | --- |
| `npm run contracts:check` | 通过。生成物一致，8 项合同测试和 1 项消费者校验测试通过。 |
| `npm test` | 通过。环境配置 4 项、合同 8 + 1 项、Rust 默认 25 项与生产 feature 26 项、Worker/D1 203 项、Web 56 项，均零失败。 |
| `npm run build` | 通过。Vue 类型检查、Vite 构建和 Worker fixture 打包预检成功。 |
| `node worker/scripts/verify-production-bundle.mjs` | 通过。校验 14 个哈希资源、4 个 HTML 引用、生产准入和 Wrangler dry-run。生产 WASM 与 bundle 的 SHA-256 均为 `4ecd10728dfbb11a13c08315e40f8220ebba307e13ceff60027584de1fc591be`。 |
| `MOLIS_WORK_SOURCE=/Users/zhuanghaozhe/IdeaProjects/molis-work npm run test:browser` | 通过。隔离 Chrome 与 workerd 完成 31 项检查，含注册、登录、资料、租户、改密、退出、会话撤销及模拟 Google/GitHub 回调。 |
| `npm run deploy -- --env test --dry-run` | 通过。使用登记的 test 配置和临时合成绑定，输出 2,609.26 KiB，gzip 909.34 KiB。Wrangler 输出 `--dry-run: exiting now.`。 |

## A · D1 往返和浏览器并发

`npm test` 中的权益、账号管理、会话和浏览器 BFF 用例直接记录隔离 workerd/D1 绑定调用。一次 D1 batch 计为一次往返，batch 中的 SQL 条数另计。下表覆盖中央 API。浏览器 BFF 的会话读取和租约单独验证。

| 请求 | 本地 D1 实测 |
| --- | --- |
| `POST /api/v2/entitlements/check`，个人和租户 | 1 读，0 写 |
| `GET /api/v2/users/me/login-methods` | 1 读，0 写 |
| `GET /api/v2/sessions/current` | 1 读，0 写 |
| `POST /api/v2/sessions/current/activity`，首次、重复和并发重放 | 1 读，1 写，重放不新增活动，返回事务内最新活动时间 |

权益用例覆盖凭据或客户端策略错误优先、租户成员权限、撤销、过期、100/101 个特性、1,000/1,001 个来源与跨激活边界的 `409 VERSION_CONFLICT`。用 `python3 /private/tmp/auth-a1-round2.99QtlW/entitlements-cap.py` 从集成源码提取个人权益生产 SQL，在内存 SQLite 上得到 100,000 行、100,001 行溢出哨兵，撤销后为 0 行。浏览器用例和 Worker 租约回归共同覆盖账号切换与旧活动请求的中止。

首次 V 验收的隔离 Chrome 中，成员首页在 `tenants` 响应完成后 3.50 ms 发出，此时邀请与转移响应均被夹具挂起。首屏 `login-methods` 完成后 39.70 ms 才发出 `activity`。显式登出在派发前 0.50 ms 中止被挂起的活动，切换账号在登出派发前 0.10 ms 中止旧账号的 `login-methods`，旧账号排队的 `activity` 发出 0 次。写后并行刷新核对跨页租户详情、成员角色和邀请归属。时间差由 Chrome 请求轨迹计算。

## B · 索引、游标和密码计算

用 `wrangler d1 migrations apply auth-local --local --config <临时配置> --persist-to <临时目录>` 验证空库安装和从 `0020` 升级。两条路径的 ledger 均依序登记 `0020` 和 `0021`，五个索引均已创建，`PRAGMA foreign_key_check` 返回空。升级保留了预置的应用与客户端关联。

隔离 workerd/D1 的 `tenants.test.ts` 在合成放大数据上运行 `ANALYZE`，从五条实际路由捕获首页和游标页 SQL 及绑定值，再执行 `EXPLAIN QUERY PLAN`。`transfer.list`、`invitation.list-mine`、`member.list`、`client.list`、`billing.tenant-audit` 的业务大表均为索引 `SEARCH`。计划保留部分中间结果扫描与临时排序。`limit=1` 遍历与重读覆盖了邀请和转移的去重、顺序与游标幂等。

`password-kdf.test.ts` 和 `login-sessions.test.ts` 覆盖 600,000 轮派生、KDF 不可用时拒绝、错误客户端重放、正确客户端重放吊销本会话及其他会话仍有效。基准走真实密码登录路径与 KDF DO，使用合成邮箱、隔离 workerd 和内存 D1。对照取 B 的集成源码并把 `password_kdf.rs` 换回 A、C 合并版的逐次唯一 ID 实现，已比对 `worker/`、`contracts/`、`config/` 的 155 个跟踪文件，差异仅在该文件。每种模式两轮，每轮三批，每批 8 并发，共 48 个请求。P95 按 nearest rank 计算。

执行 `node worker/scripts/benchmark-password-kdf.mjs <对照构建目录> <集成 fixture 构建目录>`，按对照、候选、候选、对照的顺序启动四个独立 workerd。对照和候选的 WASM SHA-256 分别为 `0ea39cb371dbb4c6a6aa0a3fc211594f2eee44b5e2aa4cefff50c3f6e4c393eb`、`bbdd6a68e270e049ab9ede343857f8d1f8df363faa9cda26e315e4d897e431d9`。入场时间从 stub 调用至进入 DO 处理器，KDF 往返还包括计算和等待，端到端计完整密码请求。

| 本轮实测 | 逐次唯一 DO | 16 槽池 |
| --- | ---: | ---: |
| 端到端 p50 / p95 | 2,900.3 / 3,608.9 ms | 2,877.6 / 2,915.5 ms |
| KDF 往返 p50 / p95 | 2,130 / 2,812 ms | 1,781 / 2,149 ms |
| KDF 入场 p50 / p95 | 1 / 3 ms | 1 / 2 ms |
| 批内重复选中同一 DO | 0 次 | 8 次 |
| 意外错误 | 0/48 | 0/48 |

本轮端到端 P95 下降 19.2%，B 节点前一组同口径实验上升 19.9%（3,077.0 → 3,689.4 ms）。两组实验的端到端变化方向不同，本机数据尚不足以确认池化对尾延迟的稳定影响。 [B 节点前次记录](auth-round2-b-verification.md)

## C · 登录首屏、Assets 和生产 WASM

C-2 在 `15f9b8c` 上复现了真实 Assets 路由对已有哈希 JS 的 POST 返回空正文 405，带 `public, max-age=31536000, immutable` 且无 `X-Request-ID`。环境配置和 Wrangler fixture 恢复 `run_worker_first: true`，生产包检查沿用环境配置。Worker 按原始 HTTP 方法判断 GET/HEAD 并通过 `ASSETS` 绑定读取实体。Miniflare 本地实测，Rust SDK 会把已送达 Worker 的 PROPFIND 和 MKCOL 映射为 GET，因此这两种方法也纳入回归。

`node --test worker/tests/routes.test.ts` 在真实 Miniflare Assets 路由复验。下列请求均有 Worker 的 `X-Request-ID`，所有 HEAD 响应正文为空。

| 路径 | GET | HEAD | 缓存与实体 |
| --- | ---: | ---: | --- |
| 已有哈希 JS、CSS | 200 | 200 | `public, max-age=31536000, immutable`，GET 实体与文件一致，保留 CSP、HSTS、`nosniff`、`DENY` 和 `no-referrer` |
| 缺失哈希 JS | 404 | 404 | `no-store`，保留静态路径安全头 |
| `/login` | 200 | 200 | `no-store`，GET 含环境和邀请渠道动态元数据 |
| `/index.html` | 404 | 404 | `no-store`，直接请求由 Worker 拒绝 |
| `/api/v2/health` | 200 | 501 | `no-store`，保留该 API 的既有方法语义和安全头 |
| 别名 `/login?from=alias` | 302 | 302 | `no-store`，保留查询参数并跳转到规范域名 |

已有 JS 和 CSS 的 POST、已有 JS 的 PUT/PATCH/DELETE/OPTIONS/REPORT/PROPFIND/MKCOL、缺失 JS 的 POST 均返回 405，JSON 中 `error.code` 为 `METHOD_NOT_ALLOWED`，`requestId` 等于 `X-Request-ID`，缓存为 `no-store`。

在同一工具链分别从 `2938120` 和修订快照构建 Web、fixture WASM 和生产 WASM。用 `node <临时目录>/login-network.mjs <baseline|candidate> <源码目录> <fixture 构建目录>` 通过真实 Assets 路由冷开 `/login`。两次使用回环服务、全新的 Chrome profile 和内存 D1。按响应 `X-Request-ID` 统计进入 Auth Worker 的请求，排除 favicon。CSS 取首屏实际返回的实体，压缩值使用 Node zlib gzip level 9。生产 WASM 体积只计生产 feature 产物。

| 指标 | 原基线 | 修订快照 | 变化 |
| --- | ---: | ---: | ---: |
| HTTP 请求数 | 6 | 7 | 多 1 个共享 JS 请求 |
| API 请求数 | 2 | 2 | 0 |
| 进入 Worker 的全部请求数 | 6 | 7 | +1 |
| 进入 Worker 的静态请求数 | 3/3 | 4/4 | +1 |
| 首屏 CSS 原始体积 | 59,639 B | 27,193 B | −54.4% |
| 首屏 CSS gzip-9 | 11,218 B | 6,109 B | −45.5% |
| 生产 WASM 原始体积 | 3,198,239 B | 2,610,459 B | −18.4% |
| 生产 WASM gzip-9 | 1,019,227 B | 913,975 B | −10.3% |

用 `npm --prefix <基线快照>/worker run build:rust:production -- --out-dir <基线产物目录>` 构建基线生产 WASM。对修订源码再用 `worker-build --release --no-opt --out-dir <对照目录> . --locked --no-default-features` 构建同 feature 的未优化对照。修订源码在 `-Os` 前为 3,198,321 B，gzip-9 为 1,019,277 B，启用 `-Os` 后分别下降 18.4% 和 10.3%。基线和未优化对照各有 1 段 `name`，`-Os` 产物有 0 段。生产构建保留 `-Os`，test dry-run 与生产包校验的 WASM SHA-256 一致。

`npm test` 和 `npm run test:browser` 覆盖按需控制台、资料与租户样式、裁图器及倒计时。修订快照的 Chrome 中，2 秒样本在 2,002 ms 到期停止，7 秒样本切换登录方式后清理，计时器总共运行 51 ms。`updateBindings` 回归覆盖原始配置和 origin 变更、AES 与 Ed25519 密钥轮换、192,000 字节载荷和会话重封装。浏览器也复验了成员请求在 `tenants` 响应后 1.10 ms 发出、`activity` 在首屏登录方式完成后 73.20 ms 发出，以及切换账号后旧账号排队的 `activity` 发出 0 次。

### 修订快照门禁

| 命令 | 本地结果 |
| --- | --- |
| `npm run contracts:check` | 9 项通过。 |
| `npm test` | 环境配置 4 项、合同 9 项、Rust 51 项、Worker/D1 203 项、Web 56 项，零失败。 |
| `npm run build` | Vue 类型检查、Web 构建和 Wrangler fixture dry-run 通过。 |
| `node worker/scripts/verify-production-bundle.mjs` | 14 个哈希资源、4 个 HTML 引用、生产准入和 dry-run 均通过。Wrangler 包为 2,609.44 KiB，gzip 909.40 KiB。包内 WASM 的 SHA-256 与生产构建一致，均为 `79c11eb312f655ccdc6f617e86d3e5d79c083e559f764d692d45036585aeafd9`。 |
| `MOLIS_WORK_SOURCE=/Users/zhuanghaozhe/IdeaProjects/molis-work npm run test:browser` | 31 项浏览器检查通过。 |
| `npm run deploy -- --env test --dry-run` | 合成绑定打包通过。Wrangler 读取 18 个目录文件，包为 2,609.49 KiB，gzip 909.44 KiB，并输出 `--dry-run: exiting now.`。 |

`node check-production-assets.mjs` 用 test dry-run 生成的生产 WASM 通过真实 Assets 路由检查 14 个实际哈希产物，共 42 次请求。GET 的实体逐字节一致，HEAD 正文为空，两者均为 200 且保留 ETag、immutable、CSP、HSTS 和其他安全头。POST 均为带匹配请求 ID 的 `405 METHOD_NOT_ALLOWED` JSON 和 `no-store`。

## 待测与执行记录

待测项目包括权益 Loki P95 是否下降至少 75%、Cloudflare 边缘 Assets 命中和 Worker 调用数、生产 Worker 冷启动、KDF 空闲回收与线上尾延迟，以及 test/prod 的 D1 副本状态、服务地域、RTT、复制延迟和 bookmark 一致性。[B 节点读副本评估](d1-read-replication-assessment.md)

默认沙箱的回环探针返回 `EPERM`，后续使用授权的隔离回环执行。首轮先从前置副本复制依赖，复核发现其中含指向 B-2 安装目录的软链接。最终使用逐字节比对的无空格源码副本和独立 npm 依赖重跑整套门禁。直接使用无空格副本、实体依赖及隔离回环可省去复跑。test 环境操作仅为合成绑定下的 dry-run，迁移实验使用本地 D1。

首次验收证据保存在 `/private/tmp/auth-round2-v.jQ6cEU/logs/`，其中 `gates.status` 记录门禁退出码，`performance.status` 记录补充复验退出码。

C-2 使用独立的 `/private/tmp/auth-round2-c2.vUjt9b/`。本轮先遇到默认沙箱的回环 `EPERM`，改用隔离回环后完成验证。扩展方法探针发现 SDK 映射问题，补齐原始方法判断后重跑全部门禁。`logs/route-before.log` 记录回归复现，`logs/consumers.log` 记录 Work 和 Club 各六份合同文件、摘要和生成类型的只读复核。`logs-final/gates.status` 汇总修订快照的命令退出码，`logs-final/tracked-source.sha256` 记录逐字节比对通过的 258 个跟踪文件。同目录保留路由、测试、浏览器、构建、生产包、dry-run、WASM 体积和登录网络的原始日志。
