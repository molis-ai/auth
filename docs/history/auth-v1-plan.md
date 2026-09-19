# Auth V1 决策与开发计划

更新时间：2026-09-14。本文记录用户逐项确认的实施基线；与历史宏观方案冲突时以本文为准。
状态：开发开始，尚未完成交付。不得以代码存在或模拟测试通过宣称真实第三方联调完成。

2026-09-15 范围待确认：本文下方记录了团队 Owner 交接，但可见用户历史另有“第一期先不支持转移”。
因该语义冲突，写入审查暂停交接实施；原计划记录暂保留，在用户明确确认前不实施 Owner 交接。本轮已实现空间、成员和邀请，见 implementation-status.md。

## 交付边界

- 独立 HTTP Auth Server、托管网页、用户账号/空间管理页、平台后台。
- 框架无关的浏览器 TypeScript SDK、Java Spring Boot Starter、最小 Spring Boot 示例服务。
- macOS 接入协议说明；不开发原生 App，不改 GoalBoard 仓库。
- 所有跨机器生产调用 HTTPS。业务服务保存资源与 Project→Space 归属，Auth 不保存 Project Catalog 或业务事实。
- Auth 保存用户、空间、成员、固定角色和权限，作出决策；业务服务执行决策及工作流约束。

## 已确认技术

Java 21、Spring Boot、Spring Security、Spring 官方 Authorization Server 组件（先验证关键适配）。
MySQL、MyBatis 显式 SQL、Flyway；Redis 用于短期认证事务、验证码、共享限流。
不缓存最终 Allow/Deny。Vue 3 + TypeScript + Vite + Element Plus；浏览器 SDK 不依赖 Vue。
前后端同仓库分目录，开发分别启动；发布将网页静态产物打包进 Auth Jar。
外部 application.yml / 环境变量；V1 无配置中心依赖，预留接入。SMTP 供应商后定。
生产组件具体版本、部署环境、域名、外部凭据尚未确认；不得写入真实密钥。

## 账号与登录

- 邮箱+密码注册，先验证邮箱；User、Personal Space、Owner Membership 原子创建。
- Google / Apple 首次成功登录自动注册，无需设置本地密码；未来可扩展登录方式。
- 内部 userId 不可变，不作为用户必须输入的登录账号；外部身份使用可信 issuer+subject 标识。
- 同邮箱不同登录方式须在登录过程中验证已有账号，成功后关联；关联前不重复创建用户/个人空间。
- 主动绑定、解绑须校验身份；不能解绑最后一个可用登录方式。
- 本地密码找回使用短期单次邮件链接；重置后撤销全部会话。纯外部身份不能借找回流程静默新增本地密码。
- 禁用撤销全部会话，保留数据、成员及角色，恢复后重新登录；不自动转移 Owner。
- V1 不提供永久注销。

## 会话与客户端体验

- 短期随机不透明 Access Token，15 分钟；服务端只保存 Token 哈希。
- 随机不透明 Refresh Token 每次轮换；检测到重放撤销对应会话。需处理合法并发/网络重试而不能静默放宽重放保护。
- AuthSession 连续 30 天未使用过期、绝对上限 90 天；纯后台刷新不能无限延长闲置登录。
- 托管登录与第一方自定义页面共用 Authentication Transaction；密码直接交 Auth。
- 2026-09-15 已对齐：产品自有密码页验证后，Auth 增加“确认以此账号继续”。实现统一账号确认/取消页与短期浏览器绑定，不凭转发的完成链接自动切换浏览器身份；产品 SDK 方法保持不变。
- Authorization Code 单次、短期有效，绑定 client、redirect URI、PKCE S256 和认证事务；Code 不等于完成所有前半段安全校验。
- Web 支持独立主域名。Token 仅保存在 SDK 内存，刷新页面通过顶层 Auth 跳转恢复，不能依赖第三方 Cookie/隐藏 iframe。
- 顶层恢复依赖 Auth 自己的安全 Cookie；必须区分 Auth 浏览器认证会话与每应用授权会话，防止恢复重新设置 90 天上限。
- Web 普通退出撤销当前产品会话并暂停自动恢复；用户主动点击登录才重新开始。全部退出撤销产品会话及 Auth 恢复会话。
- macOS 每次进程重新启动须重新认证，仅记住账号/登录方式，Token 不跨启动持久化；第三方交互由 Provider 决定。
- 退出不注销 Google/Apple 自身登录、不解绑、不删除数据。多设备会话可分别撤销。

## 应用、服务及授权边界

- 每个产品登记一个应用，包含登录客户端、后端服务身份、该应用的权限目录。
- 服务独立 Client Credentials 换短期 Service Token；只存 Secret 哈希，支持轮换与禁用，预留 mTLS 适配。
- 服务 Token 与用户 Token 类型严格区分；客户端程序不能持有后端服务 Secret。
- 用户 Token 绑定应用；内部鉴权核对服务应用和 Token 应用，以及应用允许的权限域。
- Auth 自有账号/会话接口显式允许适当的用户 Token，不开放任意跨应用资源访问。
- 请求同时确认用户与服务身份，再接受业务服务提供的 spaceId；resourceType/id 只作为资源上下文和审计信息。
- 列表接口返回具备指定动作的 Space 范围；业务 SQL 在分页/统计前过滤。单资源仍重新鉴权。
- 页面一次查询 allowedActions，业务服务可再按状态缩小范围；按钮不替代执行时鉴权。
- Unknown action、无成员、无身份、应用不匹配默认拒绝；Auth 不可用不得放行业务，故障与业务拒绝应区分。

## 空间与成员

- 用户、Space、Membership 跨产品共用；同一 Space 每用户一个 Role，不跨空间合并权限。
- Personal Space 每用户唯一、仅本人、不能邀请、转团队、转所有者或单独归档/删除。
- 任意有效用户可创建 Team Space，创建者是唯一 Owner，可设多个 Admin。
- Owner/Admin 邀请；邀请没有角色选择，接受后统一 Member。系统内外同一状态、站内通知+邮件提示。
- 未注册受邀者验证受邀邮箱后可接受；邮件链接不自动加入，可拒绝/撤销/到期，重复接受幂等。
- Owner 可调整/移除任何非 Owner；Admin 只能调整/移除 Member/Viewer，不能任免其他 Admin。
- 非 Owner 可主动退出；退出/移除不删除团队数据或历史记录，后续授权及时拒绝。
- Owner 交接给有效成员，须对方接受，可撤销/拒绝/到期，每空间最多一个待处理申请。
- 接受时重新校验双方及空间，用事务原子变更唯一 Owner，原 Owner 变 Admin。
- Owner 归档/恢复团队；归档保留按权限读取，禁止常规写入、邀请、普通角色变更；保留退出/移除/交接。
- V1 无空间永久删除、项目跨空间转移、项目级成员/角色/覆盖。

## 固定权限矩阵

| 操作 | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| space.read / space.member.read / role.read | 是 | 是 | 是 | 是 |
| space.update | 是 | 是 | 否 | 否 |
| space.archive / 恢复 / space.owner.transfer | 是 | 否 | 否 | 否 |
| 成员邀请、管理 | 是 | 受上述目标角色约束 | 否 | 否 |
| project.read / goal.read / session.read / feed.read / planning.read | 是 | 是 | 是 | 是 |
| project.create / project.update | 是 | 是 | 是 | 否 |
| project.delete | 是 | 是 | 否 | 否 |
| goal.advance | 是 | 是 | 是 | 否 |
| goal.approve | 是 | 是 | 否 | 否 |
| session.manage / planning.update | 是 | 是 | 是 | 否 |
| feed.manage | 是 | 是 | 否 | 否 |

四角色固定，无自定义或管理页面编辑权限组合。项目创建者无额外特权。
工作 Session 与 AuthSession 不同。Feed 读取不暴露 Connector 凭据。
业务状态、指定审核人、禁止自审等由业务服务额外限制。

## 平台与审计

- 平台管理员由部署侧 userId 白名单显式指定，不能通过注册顺序或管理页面授予；V1 改配置后重启生效。
- 平台可管理用户启停、应用/服务/客户端配置、服务凭据及 Auth 全局安全审计；不自动获得业务内容访问权。
- 用户查看自身安全事件；Owner/Admin 查看本空间管理审计；Member/Viewer 无空间管理审计入口。
- 记录登录/退出/重置/身份绑定、空间/成员/邀请/角色/所有权/归档变化、服务凭据、账号启停和鉴权拒绝。
- 关联 requestId/decisionId；Auth Allow 不代表业务操作已成功。无密码、原始 Token 或项目正文。
- 中文和英文页面/邮件；稳定 API 错误码，未知语言邀请使用系统默认语言。
- 邮件任务与业务记录同事务保存，后台有限重试、失败可重发；不新增消息队列。
- SMTP 接收只能说明提交发送；邮件失败不跳过邮箱验证、不丢邀请。

## API 与交付

业务 REST JSON /api/v1，统一分页、错误语义及 OpenAPI；OAuth 标准端点保留规范参数和响应格式。
Java Starter 不保存用户刷新 Token，只负责服务认证/HTTP/错误及授权调用。TS SDK 负责用户登录生命周期。
示例服务必须验证可信资源解析、数据库列表过滤、页面动作与执行权限的区别。

## 实施与证据

1. 工程基线、决策记录、协议/存储适配验证。门槛：真实框架测试覆盖 PKCE、公共客户端刷新和哈希存储。
2. MySQL/Flyway/MyBatis 与 Redis 基座；账号认证和会话纵向闭环。
3. 应用与服务身份、跨应用隔离、配置白名单。
4. Space/Membership/邀请/唯一 Owner/归档及并发约束。
5. 固定 RBAC、byAction、allowedActions、可访问空间查询。
6. Vue 双语页面、TS SDK、Java Starter、示例。
7. 审计、可靠邮件、多实例安全及故障测试。
8. 打包、接入文档、运行手册、端到端验收；真实 Provider/SMTP 联调单独列证据。

外部依赖尚未准备：Google/Apple 开发者账号及应用凭据、生产 SMTP、正式域名/部署环境。
测试替身只能用于测试，不能作为生产认证入口。没有真实联调证据时相应能力标记“待联调”。
首期无历史 GoalBoard 数据迁移；只交付 Auth 自身可重复执行/校验的版本迁移。
