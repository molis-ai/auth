# Auth、Club、Work 三环境改造 · 第二版执行方案

本版从三个 IDEA 项目目录现有的未提交实现继续开发。第一版的业务约定、ENV-01 至 ENV-20 定义和历史执行结果见[原方案](./environment-unification-plan.md)。执行顺序、补充验收和后续决策以本版为准。

## 交付目标

开发者在本机只启动 Club，明确选 test，能从业务页面登录远程测试 Auth，回到原页面并访问预期的测试数据。Work 使用同样的环境选择方式，账号、云端业务和本机 Home 各自有明确的归属。开发 Auth 自身可单独启动本地 test 实例。

| 环境 | 入口与数据 |
| --- | --- |
| dev | 显式本地启动，Auth 8787、Club 3000、Work 4207，连接本地业务资源 |
| test | 本地沿用各服务固定端口；远程 Auth 为 `https://auth.test.molis.ai`，远程 Club 为 `https://test.molis.ai`。默认使用远程测试数据 |
| prod | 正式部署与发行客户端使用已核准的正式资源。本地源码启动拒绝 prod |

每个服务从所选环境的普通 properties 和独立密钥文件读取配置，启动时校验，重启生效。真实邮件、短信和第三方登录适用于三环境。供应商凭据可相同，业务资源按环境隔离。test 邮箱、手机号白名单由 Auth 执行，移除后在下一次登录时检查。切换环境重新登录，同环境正常重启沿用现有会话规则。保留已有业务数据、表结构和 Work 项目文件。平台负责远程数据库维护。

## 实施与验收顺序

| 顺序 | 实施决策 | 完成证据 |
| --- | --- | --- |
| 1. 固定基线与部署边界 | 记录三仓当前分支、HEAD 和已有差异。Auth、Club 在调用部署工具之前校验账户、Worker、路由、D1 及服务归属。将跨环境比较所需的非敏感资源标识统一声明，允许各环境使用同一个平台账号。校验依据须能识别当前文件自身填错的目标。 | 分别测试 test 中误填正式 Worker、路由、D1 和不匹配账户，均在首次远程操作前失败。正确 test 配置能生成预期部署包。 |
| 2. 本地 Club 登录 | 确认 test 资源归属和客户端登记，本地产品入口固定为 `http://127.0.0.1:3000`。复用可信来源、精确回调、state 和 PKCE；返回路径限定于当前应用。 | 从带查询参数的页面进入登录，回到该页，读取预期测试数据。记录使用的域名、客户端和非敏感资源标识。 |
| 3. 数据连接与备选 | 对每个相关服务经本地 Worker 绑定执行只读查询，核对绑定身份和必要结构。若确认代理集成持续不可用，按服务显式选择独立本地 test 库，保留远端 test 服务的资源配置。启动失败直接报错。 | 记录平台 API、本地绑定、业务读取各自的结果。若启用备选，验证与 dev 的持久化目录隔离，日志和界面显示实际数据位置。 |
| 4. Work 登录与同步 | 将选定环境的同步地址从 properties 传到实际同步模块。沿用现有同步协议、权限和用户启用方式。本地项目文件与 Home 按既定边界保留。核对发行版 4173 和开发入口 4207 的实际监听与客户端登记。 | 在隔离 Home 完成登录；用获准的测试项目执行现有同步操作并确认目标。无可用测试同步服务时单列阻塞，记录发行端口与回调核对结果。 |
| 5. 本地 Auth 与会话 | 单独核对本地 Auth test 入口和同库客户端登记。覆盖邮箱、手机号、Google 及已绑定 GitHub 的白名单检查。验证每个客户端切换时旧凭据、待完成事务和迟到请求的处理。 | 完成 dev→test→dev、同环境重启、移除白名单后的新登录和既有会话检查。记录旧凭据是否仍存储以及能否被恢复。真实渠道使用获准的测试收件人。 |
| 6. 三仓回归与交付 | 运行各仓库所需检查和受影响的正常入口。在原矩阵基础上补充下列证据，列明每仓差异和可复现命令。 | 核对 IDEA 原目录的分支与实际文件；分别列出已通过、失败、未验证及有条件不适用的项。 |

平台接入与本机可开发的工作可并行推进。正式 Auth 缺表是此前的只读观测，只影响正式发布判断；先核对已部署版本和绑定身份。发现需要正式迁移、删除数据或真实人员授权时保留现场，独立工作继续。旧基础设施的命名不能作为复用或删除资源的依据。

## 实施决策与交付记录

执行者自主决定常规技术取舍，并记录触发条件、选择、影响范围和验证结果。一次渠道失败不能自动改变数据目标。真实白名单及供应商密钥通过私有配置提供，仓库示例使用虚构值。用户未指定的正式发布或破坏性操作另行处理。

| 补充验收 | 证据要求 | 当前状态 |
| --- | --- | --- |
| V2-01 部署目标归属 | 错配拒绝与正确目标生成结果 | 离线通过。两仓拒绝错配账户、正式 Worker、域名和 D1，test dry-run 生成各自的 staging 包。 |
| V2-02 Club 单服务 | 浏览器回到原页且读取预期测试数据 | dev 隔离浏览器通过。真实 test 阻塞于测试 DNS、Auth 登记及 D1 代理。 |
| V2-03 Work 同步 | 配置传递、实际目标及测试项目结果 | 通过隔离夹具。实际同步模块发送到 properties 指定的测试来源。真实同步入口和项目待提供。 |
| V2-04 状态隔离 | 同环境重启、跨环境重新认证、旧事务与凭据处理 | 通过专项夹具。真实 test 登录与切换待平台接入。 |
| V2-05 IDEA 交付 | 三仓原目录、分支、变更文件及验收结果 | 源码直接在三个 IDEA 原目录。基线和复现命令见下。 |

实施位置均为 `/Users/zhuanghaozhe/IdeaProjects` 下的 `auth`、`molis-club`、`molis-work`，当前分支均为 `codex/environment-unification`。直接在原目录增量修改，保留其他人的编辑和 stash。最终在此记录决策、检查结果及真实外部阻塞，让下一位开发者从 IDEA 可见的代码继续。

### IDEA 目录和基线

下表记录本轮开始时的 HEAD 及 `git status --short --untracked-files=all` 的条目数。快照中已经有环境启动器、Club 会话与回跳、Auth 白名单与会话代次、Work Home 和 payload 隔离等实现。

| 仓库 | HEAD | 已有差异条目 |
| --- | --- | ---: |
| Auth | `e4bbf306ed1765b3b6293a583cf5c2013c3ffdfd` | 39 |
| Club | `89653d22f9e134873dce9a4289724e0cc75707a9` | 38 |
| Work | `897a75cde12c8f8839ef9bb8d67f836fbd9bf04e` | 33 |

- Auth 本轮增量在 `config/platform-targets.json`、`config/test.properties`、`secrets.example/test.properties`、`worker/scripts/{environment,environment-command,local-runtime}.mjs`、`worker/tests/environment-targets.test.ts`、`worker/rust-tests/{google-live,github-live,web-session}.test.ts` 及部署文档。独立目标登记约束账户、Worker、来源及 D1，部署前以只读 SQL 检查浏览器登记和结构。真实测试联系方式经私有 properties 进入 Worker secret 绑定。
- Club 本轮增量在 `config/platform-targets.json`、`scripts/{club-environment,club-environment-command}.mjs`、`lib/account/return-path.ts`、`tests/{club-environment.test.mjs,site-http.mjs}` 与 `docs/AUTH-SETUP.md`。部署器检查 Vinext 产物并使用校验后的配置副本。回跳对 URL 归一化后的路径也做站内检查。正式 Club 路由保留待平台确认。
- Work 本轮增量在 `config/test.properties`、`scripts/{account-environments,start-account-environment}.mjs`、`apps/local-host/src/{active-release-profile,personal-sync,product-home}.ts`、`apps/local-host/src/release-profiles.json`、`apps/desktop/tooling/prepare-runtime-payload.mjs`、`tooling/release/profile.mjs`、Tauri 编译和 Home 选择、`tests/{release-profile.test.mjs,work-managed-sync.test.ts}` 及开发文档。源码启动与安装载荷传递相同的环境同步配置。dev 可选固定回环同步，test 可选已核准的 `test.molis.ai` 命名空间 HTTPS 来源。默认配置为空，保持同步未启用。测试安装版选用独立的 Bundle ID、App 名、目录授权存储和 `installed-test` Home，升级时跳过共享常驻服务注册。

### 实际平台结果与待办

- 本机 DNS 对 `auth.test.molis.ai` 和 `test.molis.ai` 的 A 查询均返回 NXDOMAIN。Club 只启动自身的真实测试登录、远程 Club 登录和 Work 真实测试登录因此阻塞。
- Cloudflare 的只读 D1 API 对两份 staging UUID 都返回成功。Club 的 `central_account_sessions`、`central_account_transactions`、`central_business_identities`、`applications`、`notes` 齐全。Auth 所查六张表缺 `auth_web_session`，由平台核对并应用该库所需的 `0012_web_sessions.sql`。现有 `unified-staging` 为旧域 `https://auth-staging.molis.ai`、投递 MOCK、供应商 LIVE；查不到第一版登记表所需的新客户端及本轮新增的测试安装客户端。
- 本机 Wrangler 的双绑定只读探针已监听，实际 HTTP 请求未在 18 秒内得到响应。第一版曾观测到 Cloudflare 内部错误。平台 API 成功与客户端代理问题分别记录，暂保留远程 D1，等待定位代理集成故障后决定是否启用显式独立本地 test 库。
- 需要平台启用两个 test 域名和已盘点 Worker，补齐第一版 12.3 的环境和客户端登记，另为 Work 安装载荷登记 `molis-work-test-desktop` 与 `http://127.0.0.1:4173/account/callback`。Work 源码登记 `molis-work-test` 与 `http://127.0.0.1:4207/account/callback`。正式安装载荷采用 `molis-work-production` 和 4173 回调，实际正式登记待平台核对。安装 Host 的既有备用端口可用于一般本机工作，账号登录依赖已登记的 4173 回调。
- 真实渠道需要获准的测试人员、联系方式、阿里云投递配置以及 Google/GitHub 的远端与回环供应商登记。Work 真实同步需要平台提供已批准的测试来源、对应业务存储和授权测试项目。
- 正式 Auth 缺表是历史记录。本轮对正式发布和正式数据未执行操作，正式 Worker 版本、绑定与 Club 正式域名留给平台核对。

### 本地复现

- Auth 从仓库根目录运行 `npm test`。按部署文档准备隔离普通配置和密钥后，可运行 `npm start -- --env dev` 与 `npm run deploy -- --env test --dry-run`。
- Club 从仓库根目录运行 `npm run check`、`npm test`、`npm run lint -- --ignore-pattern '.claude/**'`。忽略参数只排除了原目录内嵌工作树。启动隔离 dev 后运行 `TEST_ORIGIN=http://127.0.0.1:3000 MOLIS_CLUB_TEST_ORIGIN=http://127.0.0.1:3000 npm run test:http`，或运行 `npm run deploy -- --env test --dry-run` 验证测试包。
- Work 使用 Node 24.15.0、pnpm 11.9.0 执行 `pnpm install --frozen-lockfile --offline` 和 `pnpm build`。定向入口为 `node scripts/run-tests.mjs tests/work-managed-sync.test.ts tests/release-profile.test.mjs tests/runtime-payload.test.ts tests/account-session.test.ts tests/account-inflight-effects.test.ts tests/personal-auth.test.ts tests/personal-http.test.ts tests/desktop-account-entry.test.ts tests/security-invariants-personal-sync.test.ts tests/security-invariants-account-host.test.ts tests/personal-goals-sync.test.ts tests/web-home-isolation.test.ts scripts/environment-properties.test.mjs`。

### ENV-01 至 ENV-20 本轮证据

| 项目 | 结果与验收边界 |
| --- | --- |
| ENV-01、02、03、04 | 三仓选择、严格 properties、环境变量覆盖及端口占用用例。两仓额外以正式 Worker 名称注入 Wrangler CI 环境变量，test dry-run 仍使用 staging 目标。 |
| ENV-05、07 | 隔离 dev 从 Club 顶栏发起密码登录，Chrome 返回 `/community?envFixture=return#main`，读取绑定 D1 的唯一夹具留言。真实本地和远程 test 未完成。 |
| ENV-06、08、09 | Auth dev 在 8787 通过启动健康检查。Work 在隔离 Home 验证源码 4207 和试签载荷 4173 的实际监听。真实 test Auth 缺表和登记，test 本地 Worker 代理超时，两个新域名无法解析。 |
| ENV-10、11 | 隔离 WASM 通过未入名单的密码、邮箱/手机号发送拒绝及无投递断言。模拟提供方响应走生产 Google/GitHub 适配器，Google 需要已验证邮箱，GitHub 需要已绑定且有获准验证联系方式的账号。更新绑定移除 Google 白名单后新登录拒绝，已登录会话依然可用。 |
| ENV-12、13 | 代次夹具覆盖 dev→test→dev 及同环境重启保持代次。Auth 真实 WASM 装配夹具证明同代重载保留会话，两次切代后旧 Cookie 均只得到匿名会话。Club Chrome 实测同环境重启后保持已认证，旧 Club Cookie 和事务绑定旧代次。Work 旧密文可能仍在旧 Home，启动选择新代次后读取不同的密钥引用，原会话不可由该客户端恢复。中心已签发令牌的寿命依原有会话规则。Work 请求与账号切换的回归通过，实际跨环境联调仍待 test 接入。 |
| ENV-14 | 回调配置与外链拒绝用例通过。Club 增加归一化后变为协议相对路径、编码 API 路径的拒绝。 |
| ENV-15、16 | 邮件、短信与 OAuth 夹具通过。真实供应商和收件人待授权。Club Chrome 显示 DEV 与本地数据，Auth 启动显示入口和 D1；真实 test 显示待联调。 |
| ENV-17 | V2-01 通过。云端 test 与 prod 可使用同一个 Cloudflare 账号，Worker、域名及 D1 依环境分别校验。 |
| ENV-18 | Work 管理型 test Home 的真实同步模块通过协议夹具，使用配置的 test 来源并忽略 shell 覆盖。Goals 项目、历史和引用的同步恢复专项通过；真实项目与外部同步服务待提供。 |
| ENV-19 | 两仓 test dry-run 显示公开部署绑定，测试准入名单位于私有绑定。三仓的实际 `secrets/` 均被 Git 忽略且无跟踪文件，工作区新增文本通过密钥模式扫描。Work 试签载荷核对公开配置及无 secrets 目录，三个载荷回归通过。正式签名、安装和更新未验证。 |
| ENV-20 | 本轮未启用备选。本机代理超时及远端缺表由平台排查，保留各服务的显式远端 test 目标。 |

### 最终构建与回归

| 仓库 | 已通过的检查 |
| --- | --- |
| Auth | `npm test` 171 项、环境选择和端口用例、Web/SDK/WASM 与 Wrangler 构建、test dry-run、隔离 dev 健康检查。 |
| Club | TypeScript、排除内嵌工作树后的 lint、83 项测试、Vinext 构建、test dry-run、实际 dev HTTP 站点/社区/退役登录入口回归、Chrome 登录回跳与同环境重启。 |
| Work | `pnpm build`、13 个定向文件共 99 项、Tauri test 配置下 9 项宿主 Rust 测试、66 项页面资源预算。试签 test 载荷从实际 4173 监听读取健康状态，确认默认 Home 落在隔离测试目录，且忽略指向另一 Home 的环境变量。源码 dev 以独立 Home 在 4207 监听。 |

Work 并行执行安装载荷回归时的 180 秒超时已通过独立重跑恢复，最终受影响回归中的载荷用例也通过。test 发行配置检查仍报告七个本轮未修改的脚本中的值重复提示。Club 无筛选的 lint 会进入内嵌旧工作树并读到其顶层专用配置，项目自身用明示排除路径的命令验证。

三仓保持 `codex/environment-unification`，保留已有变更和 stash。没有提交、推送、远程迁移、发布或发送真实外部验证消息。

### 2026-11-18 主线集成回归

三个 IDEA 原目录均在 `codex/environment-unification`。本轮 fetch 后 Auth 与 origin/main 同为 `e4bbf30`，Club 快进至 `61f2548`（PR #31），Work 快进至 `6b0e8a4f8`。环境改动保留在工作区。Club 顶栏同时使用新版账号菜单和经校验的站内返回路径；Work 同时保留新版子任务页面资源和环境水印。

| 范围 | 实际执行结果 |
| --- | --- |
| Auth | 根目录 npm test 和 Web 构建通过，共 171 项 Rust、Worker、合同、Web 和 SDK 测试。 |
| Club | 类型检查、项目源码 lint（排除嵌套工作树）、83 项测试、生产构建、本地站点/社区/旧认证入口 HTTP 检查通过。针对本轮 Auth WASM 和临时 D1 的 CLUB-LIVE-01 / CLUB-SSO-01 通过，外部渠道使用隔离替身。 |
| Club 浏览器 | 本地 dev 预览和会话夹具下，1366px 与 390px 宽度均从带查询参数和锚点的页面进入新登录入口，认证状态恢复后回到相同地址。三种登录方式高度各自稳定在 630px、618px，背景透明度 0.86，DEV 水印可见。 |
| Work | pnpm build 通过（构建使用 Node 24.22.3，有 engine 提示）；以 .nvmrc 指定的 Node 24.15.0 运行配置及发布档案 9 项、账号/同步/子任务入口/资源预算 6 个文件 49 项，全部通过。 |

本次覆盖本地集成回归，远程 test、真实供应商及正式发行的待验项仍按上表跟踪。无推送或部署。
