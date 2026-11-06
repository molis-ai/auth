# AUTH-12 三仓库验收矩阵

状态：2026-11-06，42 项需求已关联证据，39 项隔离通过、3 项部分完成。Work 当前 `88f595b3b` 集成 main `20bdb4c16`；K-24/K-25 已在原候选或干净主线复现并修复，42 文件 432/432 与随后 20 文件 161/161 分批通过、界面采集、账号浏览器/三端切换回退、本地门禁通过，最终远端检查待核回。Auth 最新文档 CI 通过；Club Actions 未启动经用户接受不阻塞。三个功能 PR 尚待合入授权；仅 mock/合成数据，真实提供方、存量、安装包边界不变。版本见 [交付摘要](delivery-manifest.json)，详见 [交付记录](delivery.md)。

`A` 为 Auth 检出，`W` 为 Work 的 `codex/work-01-account-foundation` 检出，`C` 为 Club 的 `codex/club-01-account-foundation` 检出。下表中的 E 编号指后面的可执行证据组；同一组可证明多项要求，不能把各行或历轮测试数量相加当成去重测试总数。

T-01 已固定提交并进入远端评审。上一轮 Work 为 327 文件、3484/3485，K-06 随后已按 ASC-53 修正并复验。最新主线 d8232983 集成后，48 个合同测试文件、11 个定向文件 131/131、六个 Work 账号专项及 Club 浏览器/联合切换回退通过；未重新执行的历史文件不重复计数。最终 head 的远端 CI 状态见交付记录第 10 节，39 项隔离通过、3 项部分完成的边界不变。

首轮账号 CI Full 的 16 分片已收齐，1,650/1,657 文件通过，7 个持续失败文件对应 K-07～K-11：底栏遮挡、包许可缺失、旧入口断言、独立 HTML 回跳和 CI 重复登记。上述问题均已修复并通过对应本地验证；原始失败、5 个重试通过文件及干净主线对照保留。这是旧候选的失败记录，不覆盖下述最终候选结果。具体版本和证据见交付记录第 10 节。

候选 `c235037f4` 已集成当时的前置队列组合；新增复验为 45 文件 765/765、六个 Work 专项、Club 浏览器和三端切换/回退通过。该轮 Full 为 14 分片通过、1 失败、1 在重试期间截止取消，1,658 文件中 1,656 首次通过；K-12 布局测试旧预期已修复并复验 12/12，K-13 Frame 预览两次观察间的竞态已改为同次读取并复验 3/3。原失败与未完成的重试保留，后续最终 head 须重新完成远端验证，前置实际进入 main 另核；上述结果不扩大真实提供方、存量和安装包的验收范围。

上一轮候选 `9cf6fe623` 已包含实际 main `3a6b292ef`；#1842/#1843/#1844 均已实际合入。该组合 61 个具名文件 891/891、六个 Work 专项、Club 浏览器和三端切换/回退通过；最终 Verify `42147893187`、Full `42147888320` 均成功。Full 1,660/1,660 个 Linux 文件通过，含两个既有重试通过项（plugin-tab-groups、issue-home-locale），排除 57 个 macOS 文件，live 未执行；Verify 产品子集 409/409、安全回归 288/288，无重试通过项。K-07～K-13 的最终 CI 验证闭合，历史失败保留；这些集合与历史轮次不相加为去重覆盖数量。需求通过范围仍保持 39 项隔离通过、3 项部分完成。

## 需求覆盖

本轮保留 `f5c690d5f` 的 Full 1,662/1,664 及 `db1cafd2d` 的 Full 1,663/1,665 失败历史，两者 Verify 均成功。K-19/K-20 经干净主线对照后修正，再集成 #1859 的 Frame 修复，最终 `cdff8cea9` 的本地 24 文件 342/342、合成切换/回退与门禁通过，远端 Verify 重跑后通过、Full 1,664/1,665，Frame 的持续失败已由后续 K-22 定位并修正，当前候选另行验证。前一阶段 120 文件 1,576 项按修正后的各文件最新结果归并，八个账号专项/联合脚本通过；这些不同版本与重叠集合不相加。39 项隔离通过、3 项部分完成的边界不变，真实服务、存量和安装包缺口继续保留。

PR 检查补查发现 Auth、Club 的 Cloudflare Workers Builds 均失败（K-14）。已从日志确认：Auth 构建环境初始化超时、尚未执行源码；Club 部署构建缺少账号配置，被现有检查拒绝，本地同错复现及账号配置/合同 7/7 通过。此前的自动构建禁用判断已撤回：Auth 文档推送仍触发新构建，已在上传前主动停止，Cloudflare 记为 failure。两条历史外部检查仍失败。后续已获授权关闭两仓 Cloudflare 非生产分支自动构建，新增仅构建/测试的 GitHub 工作流；本地 Auth 各测试组与构建、Club 77/77 及合成构建通过，新 head 的远端结果另行核回。本地隔离证据不代替远端成功。详见交付记录第 10 节。

| 需求 | 本轮归类 | 已有证据及覆盖 | 证据组 | 尚未证明或留后续 |
| --- | --- | --- | --- | --- |
| UAS-01 | 隔离通过 | 两产品重新登录同一中央 userId，不再创建产品密码身份 | E-X1、E-C7 | 不承诺跨产品自动登录 |
| UAS-02 | 隔离通过 | 产品内邮箱/手机、取消/失败隔离；Work 浏览器及桌面桥回跳 | E-W2、E-C2、E-A3 | Tauri 安装包实际系统浏览器链路未验 |
| UAS-03 | 部分 | 新邮箱验证注册、改密及找回；迁移后中央改密接口可用 | E-A3、E-A5、E-W2、E-C2 | 旧未验证邮箱补验证、Club 独立旧密码接续待 D-09；真实发信待接入 |
| UAS-04 | 隔离通过 | +86 自动注册/登录；用途、次数、重放、并发与发送限制拒绝 | E-A3、E-W2、E-C2 | 真实短信送达、供应商限制待接入 |
| UAS-05 | 隔离通过 | Google/GitHub mock 稳定身份、无邮箱、成功/拒绝回跳 | E-A4、E-W2、E-C2 | 真实提供方应用与官方页面联调待接入 |
| UAS-06 | 隔离通过 | 昵称跨端互见；头像 PNG 解码、重编码、更新/移除及拒绝 | E-X1、E-A5、E-W2、E-C2 | 生产存储与真实环境未验 |
| UAS-07 | 隔离通过 | 再次验证、新身份验证、绑定/换绑、并发冲突不合并 | E-A5、E-W2、E-C2 | 真实提供方绑定另验 |
| UAS-08 | 隔离通过 | 最后方式保护；两端登录与安全页可展开帮助、收起后继续原流程，先找回原方式且不提供人工恢复 | E-A5、E-W2、E-C2 | 外部邮箱、运营商或第三方自身的恢复不属于 Molis 实现 |
| UAS-09 | 隔离通过 | 当前会话退出，独立登录不受影响，迟到登录/刷新不复活 | E-A2、E-W1、E-C1、E-X1 | 多台真实设备环境未验 |
| UAS-10 | 隔离通过 | 全产品多会话撤销与后续核验、退出名称和结果范围 | E-A2、E-W1、E-C1、E-X1 | 不表示退出 Google/GitHub 自身会话 |
| UAS-11 | 隔离通过 | client/应用/环境/来源、state/PKCE、超时、取消、重放拒绝 | E-A1、E-A2、E-A4、E-W1、E-C1 | 正式域名及回调登记待准备 |
| UAS-12 | 隔离通过 | 个人/多租户上下文、分页与切换、越范围拒绝 | E-A6、E-W3、E-C3 | 不包含共享业务存储 |
| UAS-13 | 隔离通过 | 邮箱/手机号/用户定向邀请，先注册并确认，错误身份拒绝 | E-A6、E-W3、E-C3、E-X1 | 真实邀请通知渠道尚未接入 |
| UAS-14 | 隔离通过 | 非成员拒绝；退出/移除原子结束资格，其他范围仍可用 | E-A6、E-A9、E-A11、E-W3、E-C3、E-X1 | 已验资源合同夹具，真实共享产品另期 |
| UAS-15 | 隔离通过 | 合成资源夹具以真实 Work/Club 会话校验成员；无订阅/席位可查看和下载，回收/到期不取消基础访问 | E-A11 | 仅资源访问合同夹具；真实共享存储、路由、长下载和执行中撤权另期 |
| UAS-16 | 隔离通过 | 角色、主体注入拒绝，唯一所有者与接收人确认，原所有者提前退出拒绝 | E-A6、E-W3、E-C3 | 平台初始授权的运维流程见 T-05 |
| UAS-17 | 隔离通过 | 个人订阅跨本人所属租户，不授予未加入租户访问 | E-A9、E-W4、E-C4、E-X1 | 具体付费业务拦截另期 |
| UAS-18 | 隔离通过 | 当前成员分配只在购买租户有效，退出后不再授权 | E-A8、E-A9、E-W4、E-C4 | 不包含业务用量额度 |
| UAS-19 | 隔离通过 | 库存/并发/保留分配、类型容量、回收后减量与幂等 | E-A7、E-A8、E-W4、E-C4 | 大规模线上容量压测未验 |
| UAS-20 | 隔离通过 | 功能并集、独立来源失效、起止边界、停用继续计时、记录保留 | E-A7、E-A9、E-W4、E-C4、E-X1 | 无离线付费许可 |
| UAS-21 | 隔离通过 | 成员退出/移除与席位释放同事务；失败、竞态与重试 | E-A9、E-C3 | 仅当前同 D1 架构，不代表跨服务事件实现 |
| UAS-22 | 隔离通过 | 受控平台开通/变更与审计；租户管理角色不能自增权益 | E-A7、E-W4、E-C5、E-X1 | 平台初始授权和套餐发布操作见 T-05 |
| UAS-23 | 隔离通过 | 实际持久订阅/席位/成员决定，Work 动作与 Club BFF 读取 | E-A9、E-W4、E-C4、E-X1 | 业务入口收费拦截另期 |
| UAS-24 | 隔离通过 | 到期、回收、撤销、停用及范围变更重读；离线不沿用授权 | E-A9、E-W4、E-C4、E-X1 | 线上延迟/缓存压测、执行中撤权另期 |
| UAS-25 | 隔离通过 | 匿名/离线本地页面可用，Home 与本地 actor 保持 | E-W1、E-W5、E-W6、E-X1 | 不等同 Work 全仓功能回归 |
| UAS-26 | 隔离通过 | Host/BFF 仅公开安全 DTO；证明不进动作/页面存储，刷新串行与失败关闭 | E-A2、E-A5、E-W1、E-C1 | 未进行生产日志或第三方观测系统审计 |
| UAS-27 | 部分 | 合成旧 ID、外键、署名与新写留言保持，审核映射双向唯一 | E-A10、E-C6、E-X1 | 实际账号数量、归属衔接覆盖率和旧密码可用性未观察，见 T-02 |
| UAS-28 | 隔离通过 | 同邮箱不合并；无邮箱用户使用 NULL；冲突不替换旧身份 | E-A4、E-A5、E-A10、E-C6 | 真实冲突清单仍待 D-09 |
| UAS-29 | 部分 | 旧 Cookie/personal 凭据/回调拒绝；同 ID 重登、其他产品会话保持 | E-A10、E-W5、E-C7、E-X1 | 真实旧 Client 全清单、旧第三方身份与密码接续未验，见 T-02 |
| UAS-30 | 隔离通过 | 合成迁移幂等、失败原子回滚、一致备份与独立恢复、外键保留 | E-A10、E-C6、E-X1 | 没有执行真实副本或生产恢复；不是远程迁移工具 |
| UAS-31 | 隔离通过 | 登录、换号、离线、退出、成员和席位操作不改变原 Home/actor | E-W5、E-X1 | 真实 Home 未读取或迁移 |
| UAS-32 | 隔离通过 | 文档/产品说明区分模拟、真实及后续业务范围 | E-D1、E-C7 | 不以本表宣称上线、支付或共享完成 |
| UAS-33 | 隔离通过 | 两端页面分别走真实管理接口；同 Auth 下跨端资料、成员、订阅、席位/历史和 SHARED 权益互见 | E-W2、E-W3、E-W4、E-C2、E-C3、E-C4、E-C5、E-X1 | 未穷举每种角色与每个页面操作的跨设备组合；各产品专属功能按目录区分 |
| UAS-34 | 隔离通过 | 平台创建/指定所有者/启停，普通用户和租户角色拒绝 | E-A6、E-W3、E-C5 | 真实平台人员授权未执行 |
| UAS-35 | 隔离通过 | 停用保留事实并拒绝成员/权益；原期限继续，个人及其他租户独立 | E-A6、E-A7、E-A9、E-A11、E-W3、E-C3、E-C4 | 已验夹具查看/下载拒绝；真实共享产品另期 |
| UAS-36 | 隔离通过 | 原订阅续期沿用当前分配，已结束/换绑/退出分配不恢复 | E-A7、E-A8、E-A9、E-W4、E-C4 | 不含自动支付续费 |
| UAS-37 | 隔离通过 | 套餐/类型变更不改期限；保留分配先回收，不自动换类型 | E-A7、E-A8、E-W4、E-C4 | 正式套餐清单随业务另定 |
| UAS-38 | 隔离通过 | 持久恢复、30/90 天、活动与后台区分、撤销不恢复、过期本地可用 | E-A2、E-W1、E-C1、E-X1 | Tauri 安装包、多台真实设备未验 |
| UAS-39 | 隔离通过 | 可替换投递边界与 mock 成功/失败，真实挑战生命周期，生产拒绝 mock | E-A1、E-A3、E-W2、E-C2 | 真实供应商适配/发送验证待准备，不自动回退 mock |
| UAS-40 | 隔离通过 | 提供方适配边界、模拟 state/nonce/PKCE/绑定/一次性消费，生产拒绝 | E-A1、E-A4、E-W2、E-C2 | Google/GitHub 正式应用及官方授权未验 |
| UAS-41 | 隔离通过 | 改密保留可信当前会话；找回撤销全部；原子性、旧事务/迟到刷新拒绝 | E-A5、E-W2、E-C2 | 真实邮件发送另验 |
| UAS-42 | 隔离通过 | 原所有者变 MEMBER、保留席位，可另升 ADMIN；随后退出正常释放 | E-A6、E-A9、E-W3、E-C3 | 真实租户数据未操作 |

## 证据目录

AUTH-12 汇总轮复验 E-A1 至 E-A10；两产品本轮复验基础检查、E-X1 及 Club 构建旧路由。其余页面证据引用前阶段已执行记录，未冒充本轮全量重跑；准确命令、测试数量和日期在交付记录中分别列出。K-03/K-04 补齐轮另外复验 E-A11、E-A9、两端帮助浏览器及相关页面回归，未重新运行所有历史证据。

| 编号 | 文件或脚本（仓库前缀） | 证明范围 |
| --- | --- | --- |
| E-A1 | `A:contracts/unified-account/validate.test.ts`、`A:worker/tests/unified-configuration.test.ts`、`A:worker/tests/unified-schema.test.ts`、`A:worker/rust-tests/unified-boundary.test.ts`、`A:worker/rust-tests/unified-policy.test.ts` | 合同、环境、v1/v2 与主体/权限隔离 |
| E-A2 | `A:worker/rust-tests/login-sessions.test.ts` | 独立会话、活动、时钟、刷新与撤销 |
| E-A3 | `A:worker/rust-tests/registration.test.ts` | 邮箱/手机验证和 mock 投递 |
| E-A4 | `A:worker/rust-tests/external-login.test.ts` | Google/GitHub mock 授权与回调 |
| E-A5 | `A:worker/rust-tests/account-management.test.ts` | 资料、头像、身份管理、密码与安全撤销 |
| E-A6 | `A:worker/rust-tests/tenants.test.ts` | 邀请、角色、交接、平台与启停 |
| E-A7 | `A:worker/rust-tests/subscriptions.test.ts`、`A:worker/tests/subscription-migration.test.ts` | 套餐、订阅、期限/容量与审计 |
| E-A8 | `A:worker/rust-tests/seats.test.ts` | 席位生命周期、并发与历史 |
| E-A9 | `A:worker/rust-tests/entitlements.test.ts`、`A:worker/tests/entitlement-migration.test.ts` | 成员释放原子性、功能并集和失效 |
| E-A10 | `A:worker/tests/account-migration.test.ts`、`A:worker/rust-tests/account-migration.test.ts`、`A:worker/scripts/rehearse-club-mapping.mjs` | 盘点、切换、回退与合成保留 |
| E-A11 | `A:worker/rust-tests/shared-resource-fixture.ts`、`A:worker/rust-tests/entitlements.test.ts` | K04-01：真实中央成员检查后才读取合成内容；两种操作、两产品会话，无席位可访问，非成员/停用/撤销/故障拒绝 |
| E-W1 | `W:tests/account-client.test.ts`、`W:tests/account-session.test.ts`、`W:tests/security-invariants-account-host.test.ts`、`W:scripts/central-account.test.mjs` | 固定协议、Host 与持久会话 |
| E-W2 | `W:scripts/account-authentication.test.mjs`、`W:scripts/account-provider.test.mjs`、`W:scripts/account-management.test.mjs` | 注册/登录/第三方/资料安全页面 |
| E-W3 | `W:scripts/account-tenants.test.mjs` | 租户、邀请、角色、交接与启停页面 |
| E-W4 | `W:scripts/account-billing.test.mjs`、`W:tests/account-entitlements.test.ts` | 商业页面、唯一动作目录与权益来源 |
| E-W5 | `W:tests/web-home-isolation.test.ts`、`W:tests/goal-management-identity.test.ts`、`W:tests/security-invariants-account-host.test.ts` | Home/actor 保留与旧登录隔离 |
| E-W6 | `W:tests/model-first-setup.e2e.test.ts`、`W:tests/knowledge-cards.test.ts`、`W:tests/security-invariants-knowledge-lifecycle.test.ts`、`W:tests/project-arrival.e2e.test.ts`、`W:tests/onboarding-journey.e2e.test.ts` | K01-01/K05-01/K05-02：配置后知识卡完成、准确计量和修订；排除/删除停止队列；个人空间中英文、横屏和明暗布局。K-01/K-02/K-05 定向复验通过，整合 CI 另验 |
| E-C1 | `C:tests/account-foundation.test.mjs`、`C:tests/account-sessions.test.mjs`、`C:scripts/test-account-sessions.mjs` | BFF 合同、Cookie/CSRF、持久会话 |
| E-C2 | `C:tests/account-authentication.test.mjs`、`C:tests/account-management.test.mjs`、`C:scripts/test-account-authentication.mjs`、`C:scripts/test-account-browser.mjs` | 注册、资料、绑定及密码页面 |
| E-C3 | `C:scripts/test-account-tenants.mjs`、`C:tests/fixtures/account-tenants-browser.mjs` | 租户和成员接口/页面 |
| E-C4 | `C:scripts/test-account-billing.mjs`、`C:tests/fixtures/account-billing-browser.mjs` | 订阅席位与权益接口/页面 |
| E-C5 | `C:scripts/test-account-platform.mjs`、`C:tests/fixtures/account-platform-browser.mjs` | 平台入口及撤权 |
| E-C6 | `C:tests/business-identities.test.mjs`、`C:scripts/test-business-identities.mjs` | 保留原身份、NULL 邮箱与审核映射 |
| E-C7 | `C:tests/account-cutover.test.mjs`、`C:scripts/test-account-routes.mjs`、`C:docs/ACCOUNT-CUTOVER.md` | 旧路由拒绝、导航、切换边界 |
| E-X1 | `C:scripts/test-account-cutover.mjs`、`C:tests/fixtures/cross-product-account.mjs` | 同一 Auth + Work Host + Club BFF，跨端管理/权益、重启/退出/回退与历史保留 |
| E-D1 | `A:docs/unified-account/requirements.md`、`A:docs/unified-account/account-migration-plan.md`、`W:specs/unified-account/spec.md`、`C:specs/unified-account/spec.md`、`C:content/site/privacy.ts` | 范围与前阶段验证记录；文档不是运行成功证明 |

## 文档验收编号

- **AUTH12-01** 42 个 UAS 编号不遗漏、不重复；每项有可定位证据和未覆盖范围。`worker/scripts/account-delivery.mjs check` 校验编号、引用和文件存在性；它不会推断测试通过。
- **AUTH12-02** 三份冻结合同逐字节一致；交付记录标识三仓库被验源码基准、源码未提交状态、输入摘要及迁移文件。上述命令复核摘要漂移，基准须为当前 HEAD 的祖先；文档提交不代替源码或测试证据。
- **AUTH12-03** 同一 Auth 中两产品的管理修改互见，按来源/功能比较权益，独立登录的有效期分别校验。`tests/fixtures/cross-product-account.mjs` 由联合脚本实际执行。
- **AUTH12-04** 已执行、前阶段证据、已知问题、未执行项分列，mock 与真实服务分开；生产迁移与发布未被标为完成。交付记录由本轮源代码核对与日志汇总验证，不以代码扫描代替运行证据。

- **K03-01 / K03-02** Work / Club 的登录和安全页均可发现“无法使用登录方式？”帮助；说明可用方式换绑、邮箱找回、全部丢失先找回原方式与不提供人工恢复。展开/收起不改变表单或账号。证明分别为 `W:scripts/account-authentication.test.mjs`、`C:scripts/test-account-browser.mjs` 的同名断言。
- **K04-01** 共享资源 VIEW/DOWNLOAD 的基础权限与付费权益分离；Auth 不可用或返回不匹配租户时拒绝，拒绝时不读取资源内容。夹具合同和范围见[接入说明](integration-guide.md#共享资源访问合同夹具)。

- **K01-01 / K05-01 / K05-02** Work 基线修复的具体断言与结果见 E-W6 和[交付记录](delivery.md)。原 3 项失败已定向通过；搜索索引的同源整数问题一并修复，K-02 生命周期也恢复为 3/3。此证据不扩大账号验收范围，矩阵仍为 39 项隔离通过、3 项部分完成。

- **T01-01 / T01-02 / T01-03** 仅提交验收文档不使被验源码基准过期；修改、暂存、新增、删除源码仍标为未提交，非祖先基准拒绝。证明：`A:worker/tests/account-source-revision.test.ts`。提交后的源码字节仍由交付摘要工具检查；此处不把工具通过记为业务测试通过。

- **K06-01 / K06-02** 丢失 HTTPS 确认时，读取严格限制总共 3 次，POST 只发送 1 次；两者均保持可信 unknown、原 DB/文件，并拒绝后续失败记账。证明：`W:tests/security-invariants-sandbox-signed-background.test.ts`；现行重试规则来自 ASC-53，复现及版本见交付记录第 9 节。

- **T01-LAYOUT-01** 进入页侧栏及分隔条不能覆盖底栏，手机、横屏、桌面及明暗主题中真实点击可达；原 ISSUE-45 提交与撤销继续成立。证明：`W:tests/issue-draft-preview.e2e.test.ts`。
- **T01-FRAME-01** 在同次浏览器求值中捕获就绪预览及其内容、禁止控件、当前页面与展开数量，原断言与等待期限保留，避免两次读取间的重绘影响断言。证明：`W:tests/workbench-frame-container.e2e.test.ts`。
- **T01-ACCOUNT-ENTRY-01** 项目内账号入口可打开表单，关闭后恢复焦点；Goals 快照仅改变已确认的登录按钮属性和提示。证明：`W:tests/project-home-start.e2e.test.ts`、`W:tests/goals-page-golden.test.ts`。account 包许可证及独立载荷分发由 `W:tests/license-materials.test.ts`、`W:tests/runtime-payload.test.ts` 的既有断言覆盖。
- **T01-CALLBACK-01** 第三方回跳只返回无凭据、不可缓存的纯文本提示，原账号弹窗恢复状态；保留来源、state、重放、取消及重启拒绝。证明：`W:scripts/account-provider.test.mjs`、`W:tests/security-invariants-account-host.test.ts`，整页限制继续由 `W:tests/shell-page-gate.test.ts` 执行。
