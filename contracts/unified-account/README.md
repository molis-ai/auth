# 统一账号可执行合同

状态：AUTH-01 合同与结构校验已实现；本目录不实现登录、租户、订阅或权益服务。业务语义来自 [API-01 至 API-10](../../docs/unified-account/api-contracts.md)，产品决定来自[需求文档](../../docs/unified-account/requirements.md)。OpenAPI 每个操作均标记 `CONTRACT_ONLY`，不能用合同存在代替运行中的接口验收。

运行实现已由 AUTH-01 至 AUTH-12 分阶段交付，实际状态见[验收矩阵](../../docs/unified-account/acceptance-matrix.md)；CONTRACT_ONLY 描述本目录只提供合同，不是运行状态查询。三端固定版本与字节摘要见[交付记录](../../docs/unified-account/delivery.md)。

## 文件与使用

| 文件 | 作用 |
| --- | --- |
| `generate.ts` | 请求/响应、认证联合类型、权限、状态与夹具的唯一维护入口 |
| `schemas.json` | JSON Schema 2020-12；所有对象明确字段，写入拒绝未知字段 |
| `openapi.json` | OpenAPI 3.1；中央 `/api/v2`、产品固定操作映射、错误和安全说明 |
| `policy.json` | 工程默认值、操作权限、状态转换、proof 绑定、原子不变量、mock 与迁移边界 |
| `fixtures.json` | 无真实身份或秘密的正反样本；每个 Schema 及联合分支都有结构样本，另有攻击/边界样本 |
| `validator-profile.json` | Rust/TS 共用的支持关键词、格式及精确正则清单；扩展前须补两端测试 |
| `validate.ts` | 无 Node 文件系统依赖的 TypeScript `validateNamed(name,value): boolean`（静态导入 JSON，可由产品构建器打包）；不是浏览器凭据 SDK |
| `validate.test.ts` | 合同、生成一致性、OpenAPI 引用、用途组合及禁止状态回转的定向测试 |
| `worker/rust/src/unified_contracts.rs`（仓库根下） | `validate_named(name,&Value)->Result<(),String>`；生产配置校验及同一组夹具的 Rust 单元测试 |

修改 `generate.ts` 后运行 `node contracts/unified-account/generate.ts` 并一同提交四份生成 JSON。`node contracts/unified-account/generate.ts --check` 只检查生成结果，不写文件。`validator-profile.json` 手工维护，由两端读取同一文件。两产品后续使用本目录固定版本，避免另抄一套业务枚举；Work 对外插件合同仍由 Work 自己的 contracts 边界决定。

定向验证：

```sh
node --test contracts/unified-account/validate.test.ts
cargo test --manifest-path worker/rust/Cargo.toml unified_contract
```

Rust 命令由仓库集成方统筹，遵循本机工具链与测试环境要求。本目录测试不会发短信、请求 OAuth、连接生产或运行数据库迁移。所有夹具中的域名、身份、code 和 proof 都是合成材料。

## 认证与产品边界

`CreateTransactionRequest` 按 purpose/method 及 operation/target 展开联合类型；未列组合拒绝。REAUTH 的目标：BIND_METHOD 用 `{method:EMAIL|PHONE|GOOGLE|GITHUB}`；REPLACE_METHOD/UNLINK_METHOD 用 `{bindingId}`；CHANGE_PASSWORD 用 `{kind:PASSWORD}`。REAUTH、BIND、REPLACE 必须有可信当前会话，OpenAPI 可选 Bearer 加 `x-session-required-purposes` 表达按 purpose 的条件，服务必须执行 `policy.authenticationFlows.requiresCurrentSession`。

LOGIN/EMAIL_SIGNUP 只能完成为 LOGIN_CODE，REAUTH 为 OPERATION_PROOF，BIND/REPLACE 为 NEW_IDENTITY_PROOF，PASSWORD_RESET 为 RESET_PROOF。只有 LOGIN/PHONE_OTP 的 `/phone` 可以自动开户；signup 仅供 EMAIL_SIGNUP。验证码验证在 LOGIN/PHONE_OTP 和 EMAIL_SIGNUP 中留下待下一步消费的 verificationProof；其他挑战用途在成功后直接令事务 VERIFIED，complete 只签发其用途的证明。服务必须按 policy 的用途与当前事务检查，不能仅验证某个 proof 字符串形状。

VERIFIED 只允许 COMPLETE；终态只能返回 NONE。产品 DTO 只暴露本地 handle、公开状态及用户视图，不能带中央 code/proof/token。Google/GitHub 的 provider state、nonce、PKCE 与产品 state/PKCE 分开；提供方 code/subject 保持其不透明字符串语义，不套本地 ID 或本地 token 的长度规则。Google/GitHub 无邮箱身份也可表达。

`LogoutRequest` 的空对象表示 Authorization 中的 access 证明；`refreshProof` 分支仅供撤销已知登录，不换发 token。两个撤销操作都带 Idempotency-Key；已撤销证明只能读取同次最小撤销结果。全局撤销仍要求请求发起时有效的登录，客户端不得凭“通过结构校验”认定已经退出全部设备。

API-08 是固定产品操作目录。Club 可按这些路径实现 BFF；Work 的非凭据操作仍映射到既有动作网关。路径不是允许任意转发的代理。Cookie/CSRF、本机授权、客户端与 origin/callback 绑定、HTTP headers 和请求体之外的证明须由各入口检查。认证表单密码与验证码不进入普通动作目录。

## 工程默认与既有行为

TTL、重发/尝试次数、分页和限流初始值集中于 `policy.defaults`。发送上限为每小时 IP 60、目标 10、客户端 1000 次，是隔离开发初始工程值；真实接入前结合供应商约束与滥用测试配置，不能关闭按目标/客户端/IP 的约束。闲置 30 天、绝对 90 天为产品规则；刷新、轮询和再次验证不延长绝对期限。

资源 `version` / `sessionRevision` 从 0 开始；不可变套餐 `planVersion` 从 1 开始。LoginPassword 不用新密码强度规则挡旧账号；NewPassword 在传输层限定 8..512 个码点，现有服务继续执行 NFC 后 8..128 个码点、原始 UTF-16 不超过 512，以及既有弱密码规则。Schema 不是密码强度实现。清洗后头像可为现存 PNG data URL、受控 HTTP 地址或 null；传入 PNG 必须继续解码、限制尺寸、重编码，字符串匹配不证明图片安全。

`EnvironmentConfig` 是中央 `UNIFIED_ACCOUNT_CONFIG` 的五字段结构：environmentId、kind、authOrigin、deliveryMode、providerMode。PRODUCTION 在 Schema 即拒绝 MOCK；LOCAL 仅允许 loopback、正式环境 HTTPS、已登记 client/允许 origin/精确回调等由 AUTH-02 语义守卫补充。`ClientEnvironmentConfig` 独立表达每个客户端的产品 origin 与回调登记，不能把 runtime 环境配置当公开请求输入。

## 校验边界

这是拒绝不支持功能的受限 JSON Schema 校验器，使用现有离线依赖。支持的关键词见 `validator-profile.json`：仅本地 `$defs` 引用、无循环、明确标量 type、对象/数组/字符串/数值边界、const/enum、oneOf/anyOf/allOf/not。未知关键词/格式、非白名单正则、远程引用、递归引用及不支持的 schema 形状在编译阶段失败，不静默忽略。`description/title/default/$schema/$id` 是注释或元数据，default 不自动填值。

- 字符串长度按 Unicode 码点；integer 限于两端都能精确表达的 JavaScript 安全整数。数字 const/enum/uniqueItems 按 JSON 数值相等，1 和 1.0 相等，对象属性顺序不影响相等。
- date-time 采用 UTC 秒或三位毫秒，拒绝无效日历日期。URI 采用 ASCII HTTP(S)，Unicode 域名先转 Punycode、路径先百分号编码；禁止凭据、空白、控制字符、反斜杠及通配符。origin 要求规范源地址，不带路径。此结构检查不能替代注册的 origin/精确回调比对。
- email 是本期明确支持的 ASCII 邮箱传输格式；地址规范化、已有邮箱兼容与身份唯一性由领域层执行。local-path 拒绝绝对/协议相对地址、反斜杠、控制符及危险编码；产品还应按可返回的页面清单检查。
- 不检查“expectedVersion 是否当前”“两个日期先后”“订阅显示状态是否符合时间”“容量是否足够”“是否成员”“proof 是否真实/已消费”“返回角色是否来自当前事实”等。它们是 `policy.json` 的领域不变量，由 AUTH-03..10 的持久化/并发/鉴权测试验证。通过 Schema 从不等于已认证或有权益。
- OpenAPI 的错误集合包括 AUTH-02 的明确拒绝码；尚未实现的 v2 入口可返回 UNIFIED_ACCOUNT_NOT_IMPLEMENTED，不能返回虚构成功数据。

## 变更记录

- 1.2.0 开发增量：API-10 增加应用与 V2 登录客户端的列表、读取、创建、修改；分别要求 APPLICATION_READ/WRITE、CLIENT_READ/WRITE。客户端与策略版本同时检查；允许登记无产品映射的 Auth 自身客户端，Work/Club 映射显式指定。服务端会话、权限、域记录、审计与幂等回执原子提交；这不表示页面、SDK 或全部 V1 替换已完成。
- 1.2.0（2026-11-08，开发中）：增加当前用户自行创建租户与读取创建策略的中央/产品映射；默认 SELF_SERVICE，可由受信部署配置切为 PLATFORM_ONLY。自行创建不接受 ownerUserId，平台代建仍要求 TENANT_CREATE；不改变旧 TEAM 记录、不赠送订阅或席位。见 [V2 收敛方案](../../docs/unified-account/v2-consolidation.md)。
- 1.1.0（2026-11-05）：新增平台订阅库存只读接口 `GET /api/v2/platform/subscriptions/{subscriptionId}/seat-pools` 及对应产品映射。要求 `SUBSCRIPTION_READ`，不要求平台人员属于租户，租户停用时仍允许平台读取；个人订阅返回空列表，分页限定当前账号/Client/订阅。席位分配仍只允许租户管理者，未增加迁移或支付。
- 1.0.0（2026-11-04）：覆盖 API-01..09；固定中央与产品 DTO、四类完成材料、认证用途联合、平台/租户权限、订阅与席位结构、mock 端口、迁移记录、工程默认值和两语言共用正反夹具。交付的是可执行合同，不是完整统一账号业务实现。
