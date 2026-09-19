# 当前 TypeScript 工程边界

## 请求流向

浏览器 → `app.ts`（HTTP 外壳）→ `http/router.ts`（认证边界）→ 业务模块 `routes.ts` → 业务服务 → D1 访问层。

`index.ts` 仅导出 Worker 入口。前端 `web/` 和 SDK 不导入任何 Worker 实现，也不接触 D1 绑定和服务端密钥。

## 业务模块

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| identity | 登录事务、PKCE、授权码、访问/刷新令牌、根会话 | 团队角色和平台管理 |
| account | 个人资料、关联方式、个人会话列表与安全记录 | 替其他用户管理账号 |
| teams | 团队、成员角色、邀请、团队审计 | 平台应用权限矩阵 |
| platform | 超管入口、应用、客户端、服务凭证、用户状态、权限矩阵 | 伪造团队成员身份 |
| federation | Google/Apple 外部身份、回调证明与主动绑定 | 仅凭邮箱相同自动合并账号 |
| authorization | 服务端鉴权、角色规则、可访问空间与动作 | 前端页面展示 |

identity 内部分为 `login-workflow.ts`、`token-service.ts`、`session-service.ts` 和共享类型；`service.ts` 是请求级协调入口，不能保存跨请求用户状态。
账号、团队和平台各有自己的路由文件；路由处理 HTTP 路径/方法，服务执行业务规则。

## 公共基础能力

- `infrastructure/database.ts`：参数化 D1 查询、原子 batch、写入守卫、审计记录写入。
- `infrastructure/ephemeral-store.ts`：一次性证明与限流状态，不依赖团队业务。
- `infrastructure/pagination.ts`：通用分页，不属于任何特定业务模块。
- `security/`：密码编码/策略与图片解码清洗。不能导入业务模块。
- `shared/http.ts`：通用输入校验、错误、Cookie 和编码工具，不包含特定接口路径。

当前业务 SQL 留在所属业务服务内，通过统一 D1 访问层执行；并未为了模仿 Java 而为每个查询增加空壳 Mapper。需要复杂查询复用时，在所属模块新增 repository，而不是相互调用别的模块内部 SQL。

## 依赖与变更规则

1. 公共基础层不能反向依赖业务模块。
2. 业务模块不能导入 `app.ts`、Worker 入口或全局路由。
3. 跨模块只使用明确的服务/类型/能力查询；公共分页不能通过 teams 模块获取。
4. 公开登录接口、服务对服务鉴权、用户 Bearer 接口具有不同边界，不能为了复用而统一跳过检查。
5. 同一业务操作的检查与写入需要原子性时，继续使用 D1 batch 和守卫；拆文件不能拆掉事务。
6. 重构不改变 URL、JSON 字段、错误码、密码成本或权限策略。改变这些是独立业务变更。

`worker/tests/architecture.test.ts` 检查基础依赖方向，`npm run format:check` 检查排版。行为回归由 `npm test` 和本地 `npm run test:e2e` 验证。
