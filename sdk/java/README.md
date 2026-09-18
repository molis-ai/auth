# Java HTTP SDK、Spring Boot Starter 与独立示例

新增 `AuthorizationClient.recordUserActivity(userAccessToken)`：可信业务服务在真实用户交互后显式调用，更新该应用授权及父会话的闲置期限，不改变绝对期限。不得接在每次鉴权、刷新、轮询或后台任务后自动调用。HTTP 双身份及失败不重试规则不变；Auth Server 现在必须启用共享 Redis 才能签发服务 Token 或执行鉴权（未配置/故障返回 503，限流返回 429）。

更新：2026-09-15。三个独立 Maven 模块已实现；通过真实 Auth HTTP 和隔离 MySQL 联合验证。未发布 Maven Central，也不代表 Auth V1 整体生产就绪。
Java 21；Starter/示例当前验证 Spring Boot 4.1.1。核心客户端不依赖 Spring、Auth Server、MyBatis 或 Redis，仅依赖 Jackson 3 与 JDK HTTP。

## 构建和依赖

从 Auth 仓库根目录执行：

```bash
./mvnw -B -ntp -f sdk/java/pom.xml clean install
```

`install` 仅安装到当前机器的 Maven 缓存，不是远程发布。模块和产物：

| 模块 | 产物及用途 |
|---|---|
| auth-client | 普通 Jar：AuthorizationClient/HttpAuthorizationClient、协议、服务 Token 生命周期、错误和传输接口 |
| auth-spring-boot-starter | 普通 Jar：自动配置、外部配置绑定，不安装业务安全过滤器 |
| example-service | 普通 Jar 供合同测试使用；`auth-example-service-0.1.0-SNAPSHOT-exec.jar` 为可独立启动的业务示例 |

接入方添加一个依赖：

```xml
<dependency>
  <groupId>ai.molis.auth</groupId>
  <artifactId>auth-spring-boot-starter</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
```

非 Spring 应用可只依赖 `ai.molis.auth:auth-client:0.1.0-SNAPSHOT`，显式构造和关闭 `JdkAuthTransport`。
模块不会引入 Auth Server 的数据库或迁移，不要求业务服务共享 Auth 数据库。

## 外部配置

在接入方配置中引用部署侧环境变量，不把真实 Secret 写进仓库：

```properties
molis.auth.issuer=${AUTH_ISSUER}
molis.auth.client-id=${AUTH_SERVICE_CLIENT_ID}
molis.auth.client-secret=${AUTH_SERVICE_CLIENT_SECRET}
molis.auth.connect-timeout=3s
molis.auth.request-timeout=5s
```

issuer 必须是 HTTPS origin，不能带用户名、密码、子路径、查询或 fragment。端点由 SDK 固定追加，不能由业务请求自选。
仅本机开发可显式设 `molis.auth.allow-loopback-http=true`，只允许 localhost/127.0.0.1/::1，不允许任意 HTTP 主机。
超时可设 50ms–30s；总请求期限包含响应体读取，不只是建连。最大响应体 256 KiB；不信任 Content-Length。

引入 Starter 后默认启用，缺少配置启动失败，不生成允许一切的假客户端。`molis.auth.enabled=false` 会不创建客户端 Bean；
依赖它的受保护业务组件应因此无法启动，而不是回退放行。自定义 AuthorizationClient Bean 时默认自动配置退让。
标准配置 Provider 在启动时读取凭据；轮换后须更新配置并重启接入服务。高级部署可替换 `ServiceCredentials.Provider`，在每次获取新服务 Token 时读取最新配置。

服务 Secret 只能部署在后端，不能放进 Vue/浏览器/原生客户端/CLI 程序。请求日志和网关日志应脱敏 Authorization 与 X-User-Token；不要打印请求对象或把凭据对象序列化。

## 业务调用

构造器注入 `AuthorizationClient`，业务请求中读取用户 Access Token，然后先从自己的数据库解析资源：

```java
var project = projectRepository.find(projectId); // 可信的 Project -> Space 归属
var decision = auth.requireAllowed(userAccessToken, project.spaceId(),
    "project.update", new AuthorizationClient.Resource("project", project.id()));
// 还要检查当前工作流状态、版本、指定审核人等业务条件，然后执行写入。
```

`check` 返回明确的 allowed/reason/requestId/decisionId；`requireAllowed` 对普通业务拒绝抛出 DENIED。
不要捕获异常后继续写入。SDK 不自动执行任何业务操作，也不会把过去的 decisionId 当作可复用授权凭据。
没有把前端自报的 role/userId/spaceId 当成可信身份的通用注解；资源归属必须由业务方解析。

`allowedActions(token, spaceId)` 供页面动作展示，业务服务可以继续按资源状态缩小结果。执行动作仍重新 `check/requireAllowed`。
`spaces(token, action, cursor, limit)` 返回单页授权空间（最多 200）；需要完整列表时可以使用：

```java
var spaceIds = auth.authorizedSpaceIds(userAccessToken, "project.read", 1000);
// 在业务 SQL 的 WHERE space_id IN (...) 中使用，再进行 LIMIT、分页与 COUNT。
```

便捷方法读取所有范围页，但不无限占用内存：maximumSpaces 为 1–10000，超出抛 SCOPE_TOO_LARGE，绝不返回被截断的“完整范围”。
空范围必须变成 SQL `1=0`，不能省略 WHERE。更大规模需业务方使用受控分批/临时表等设计；不能把第一页当作全量。
跨 Auth 页与业务数据库不存在全局快照；成员可能变化。单资源仍独立重新鉴权，业务事务应保护资源归属和工作流状态。

## 服务 Token 与失败语义

- 每实例合并并发服务 Token 获取，用标准 Client Credentials + client_secret_basic，scope=authorization。
- 服务 Token 仅在内存短期缓存，到期前最多 5 秒提前失效；用单调时钟和请求开始时间计算有效期，不以响应收到时间延长寿命。
- 用户 Access Token 仅用于当前调用，SDK 没有用户 Refresh Token 接口，不保存用户登录生命周期。
- 每个 check/actions/spaces 都实际请求 Auth，不缓存最终决策。
- 服务 401 清掉对应缓存，但当前失败请求不重试；下一次显式调用再读取凭据获取服务 Token。用户 401 不清服务缓存。
- 不自动重试签发、决策或网络失败；不跟随重定向，不发送 Cookie/Origin，也不使用系统 Authenticator。
- JSON 重复字段、尾随内容、字符串形式的 allowed=true、未知拒绝原因、错误 scope/Token 类型、非法 ID 或不递增分页全部拒绝。
- 错误只含安全种类和受限关联 ID，不附带原始响应体、底层异常或凭据。即使返回的状态不符合协议，也不会被误当作 Allow。

| AuthFailure.kind | 建议业务响应 |
|---|---|
| USER_UNAUTHENTICATED | 401，客户端重新登录/恢复 |
| DENIED / FORBIDDEN | 403，不执行业务写入 |
| SERVICE_UNAUTHENTICATED | 503/运维告警，检查后端凭据，不让用户重复输密码 |
| UNAVAILABLE / INVALID_RESPONSE / INTERRUPTED | 503，故障关闭；中断标记保留 |
| SCOPE_TOO_LARGE | 拒绝本次未完整的范围查询，调整有边界的业务查询设计 |
| INVALID_INPUT | 接入代码/输入错误，不回退放行 |

可注入自定义 `AuthTransport` 或用部署配置的 HttpClient 构造 `JdkAuthTransport`，为 mTLS 等保留扩展点。
自定义 HttpClient 仍必须关闭重定向、CookieHandler 和 Authenticator；不能关闭证书/主机名验证。
该扩展点不代表 Auth 已实现仅凭 mTLS 的服务身份认证；当前仍需标准后端凭据，真实双向 TLS 尚未联调。
默认传输由 Spring 关闭；非 Spring 调用方用 try-with-resources 关闭它。

自动配置使用 Spring 官方的 AutoConfiguration.imports 和条件 Bean 机制，不修改接入方的 SecurityFilterChain。[官方说明](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)
默认 HTTP 策略基于 JDK HttpClient，额外实现响应体大小与完整请求期限约束。[JDK 21 文档](https://docs.oracle.com/en/java/javase/21/docs/api/java.net.http/java/net/http/HttpClient.html)

## 独立业务示例

见 [example-service/README.md](example-service/README.md)。示例不实现登录页面、不改造 GoalBoard，也不提供凭 userId 造 Token 的后门。

## 可重复验证

独立模块测试在上述 install 中运行：16 项核心协议/真实 HTTP 传输测试、6 项 Starter 上下文测试、5 项业务示例测试，共 27 项。
核心协议大部分使用受控响应，5 项传输测试使用真实本机 HTTP 服务；这些不单独证明真实 Auth 集成。

真实 Auth 合同测试必须先执行 install，再从仓库根目录运行（仅隔离测试库）：

```bash
./mvnw -B -ntp clean -Pjava-sdk,mysql-it \
  '-Dauth.it.jdbc-url=jdbc:mysql://127.0.0.1:43316/auth_test_example?connectionTimeZone=UTC' \
  -Dit.test=JavaSdkHttpIT verify
```

6 项 JavaSdkHttpIT 实际调用当前 Auth HTTP/MySQL：Client Credentials、三种授权 API、201 个空间跨页、降权/撤销/应用隔离、
凭据轮换、审计故障，以及独立业务 HTTP 服务的真实 MySQL 分页/统计过滤和执行时复核。测试预置已验证用户会话，不代替用户登录 UI 验收。
示例测试创建独立 `demo_test_<随机值>` 库，不读写 GoalBoard；测试库保留供排查，不删除用户数据。

全量命令追加 `web,browser-sdk,java-sdk,full-it` 四个 profile，并提供隔离 Redis 端口；每次切换 profile 使用 clean，避免残留可选测试类。
Root 的 java-sdk profile 仅添加测试依赖，不把 SDK/示例打进 Auth Jar；独立 SDK 构建不依赖 Auth Jar。
集成测试限制最多缓存 8 个 Spring 上下文，及时关闭闲置连接池，不修改生产连接参数或削减并发测试。[Spring 测试缓存](https://docs.spring.io/spring-framework/reference/testing/testcontext-framework/ctx-management/caching.html)

仍待验收：真实生产 HTTPS/反向代理、mTLS、容量/故障演练、跨独立主域名浏览器接入，以及 Google/Apple/SMTP。当前没有对外发布依赖包。
