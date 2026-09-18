# 独立业务后端示例

本示例只依赖 Java Starter，经 HTTP 调 Auth；自己的 MySQL 库只存 Project→Space、名称、状态和版本。
它不包含 Auth 数据表、不授予管理员、不改 GoalBoard；示例操作用于证明接入边界，不是完整项目产品。

## 启动准备

1. 按 Auth 控制台文档部署 Auth。由部署白名单管理员为测试产品登记应用、公共登录客户端和后端服务；应用目录至少包含 `project.read`、`project.update`。
2. 将后端服务的 clientId/Secret 放进示例的外部环境变量。用户通过该应用的公共登录客户端和浏览器 SDK 登录；不能拿另一个应用（例如默认控制台）的用户 Token 混用。
3. 创建独立的空业务数据库及专用数据库账号。`DEMO_DB_URL` 不得指向 Auth 或 GoalBoard 的数据库；JDBC URL 使用 UTC connectionTimeZone。
4. 配置环境变量，然后构建并运行：

```text
AUTH_ISSUER=https://auth.example.com
AUTH_SERVICE_CLIENT_ID=<Auth 创建的后端 clientId>
AUTH_SERVICE_CLIENT_SECRET=<一次性取得的后端 Secret>
DEMO_DB_URL=jdbc:mysql://127.0.0.1:3306/molis_auth_demo?connectionTimeZone=UTC
DEMO_DB_USER=<业务库专用账号>
DEMO_DB_PASSWORD=<业务库密码>
```

```bash
# 在 Auth 仓库根目录
./mvnw -B -ntp -f sdk/java/pom.xml clean install
java -jar sdk/java/example-service/target/auth-example-service-0.1.0-SNAPSHOT-exec.jar
```

主类显式加载 `demo.properties`，默认只监听 127.0.0.1:41990。生产需要 HTTPS；本机联调可显式设置 `DEMO_ALLOW_LOOPBACK_HTTP=true`，
该开关同时允许本机入站 HTTP 和 loopback Auth issuer。不能把这个开关当成公开部署配置，也不信任任意 X-Forwarded-*。
示例暂无跨域浏览器 CORS 或登录页，只接受后端 REST 调试/同部署受控调用。前端产品自己的 CORS/BFF 方案需单独配置并验收。

启动只迁移 `demo_project`，不自动创建项目或 Auth 空间。通过 Auth 正常创建空间后，开发者可在专用示例库放入测试项目：

```sql
-- 替换成真实测试 UUID；不要在 Auth/GoalBoard 数据库执行。
INSERT INTO demo_project(id,space_id,name,state)
VALUES ('<project-uuid>','<属于测试用户的真实-space-uuid>','Demo project','EDITABLE');
```

这是一项显式的开发夹具准备，不是对外创建资源 API。对外业务创建接口将来仍须校验目标空间的 project.create。

## 接口和安全含义

统一携带 `Authorization: Bearer <该应用用户 Access Token>`。只接收 Access，不接收用户 Refresh、Cookie、userId 或角色。

| 接口 | 行为 |
|---|---|
| GET /demo/projects?limit=50&cursor=UUID | 取得完整授权空间（最大 1000），在 SQL WHERE 中过滤，再 LIMIT 和 COUNT；空范围为 1=0 |
| GET /demo/projects/{id} | 先查业务数据库的可信 spaceId，再向 Auth 验证 project.read |
| GET /demo/projects/{id}/actions | 先验证可读，再查询空间动作，并按项目状态缩小页面动作 |
| PUT /demo/projects/{id} | JSON `{name,version}`；行锁保护可信归属，重新检查 project.update、业务状态和版本，再改名 |

项目为 LOCKED 时即使 Auth 允许也拒绝修改。已经显示的按钮不作为之后写入的许可；降为 Viewer 后再次提交返回 403。
修改接口不接收 spaceId；额外字段、重复 JSON、尾随内容、重复查询参数以及超过 16 KiB 的请求体拒绝。
未知资源也要通过一次当前双身份查询后才返回 404，不能让伪造 Token 利用 401/404 探测存在性。
无身份/用户失效返回 401，权限不足 403，业务锁定/版本冲突 409，Auth 或后端服务凭据故障 503。任何故障都不执行业务写入。

示例最多收集 1000 个授权空间，超过上限返回故障而不是漏数据；不假定生产 IN 列表可无限扩张。
分页结果不承诺跨 Auth/业务数据库的全局一致快照；单资源重查与本地数据库锁仍不可省略。
这里保留 Auth requestId/decisionId 用于错误关联，但没有完整的业务成功审计系统；Auth Allow 不表示改名一定提交成功。

## 验证证据

JavaSdkHttpIT 启动独立的业务 Spring/HTTP 上下文和真实 Auth HTTP，业务库与 Auth 库分开：
无权项目在排序最前面也不挤占第一页，统计只包含授权范围；伪造 spaceId 被拒绝；普通改名成功；状态锁定/角色降级/服务禁用/审计故障不写数据。
业务流程另有 5 项单元测试。独立可执行 Jar 已启动冒烟验证，无 Bearer 请求返回 401；该冒烟使用无效测试凭据，不冒充真实签发验证。
真实授权集成证据来自前述合同测试，不是仅靠 Jar 能启动。生产 MySQL 版本、TLS、容量与产品浏览器接入尚待验收。
