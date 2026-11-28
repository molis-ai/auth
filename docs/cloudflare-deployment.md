# Auth 启动与 Cloudflare 部署

配置使用 `config/<env>.properties` 和独立的 `secrets/<env>.properties`。密钥文件中的键统一使用大写字母和下划线，例如 `UNIFIED_GOOGLE_CLIENT_ID`。密钥模板在 `secrets.example/`。会话和 OAuth 状态密钥分别使用 32 字节随机值的无填充 base64url 编码。先完成本环境的供应商和客户端登记，再启动。

阿里云邮件地域、发信账号、短信签名、dev 短信收件白名单和 AccessKey，以及 Google、GitHub 的客户端 ID 和密钥，都在对应环境的 `secrets/<env>.properties` 中配置。升级时将旧普通配置里的这些字段移入本环境的密钥文件，并从旧文件删除。test 环境中，每个 OAuth 应用登记远端和本地两条回调后，Google 只需填写 `UNIFIED_GOOGLE_CLIENT_ID`、`UNIFIED_GOOGLE_CLIENT_SECRET`，GitHub 只需填写 `UNIFIED_GITHUB_CLIENT_ID`、`UNIFIED_GITHUB_CLIENT_SECRET`。使用独立的本地应用时，可为对应提供方成对指定 `LOCAL_GOOGLE_CLIENT_ID` 和 `LOCAL_GOOGLE_CLIENT_SECRET`，或 `LOCAL_GITHUB_CLIENT_ID` 和 `LOCAL_GITHUB_CLIENT_SECRET`。启动器和部署器使用原有 Worker 绑定名注入这些值。

`config/platform-targets.json` 记录已盘点的 Cloudflare 账户、Worker、Auth 来源及 D1 名称和 ID。环境 properties 必须与登记一致。更新目标时由平台操作员先核实资源归属，再更新两处声明。测试准入的 `TEST_ALLOWED_EMAILS` 和 `TEST_ALLOWED_PHONES` 放在私有 `secrets/test.properties`，两个值都使用 JSON 字符串数组，例如 `TEST_ALLOWED_EMAILS=["qa@example.test"]`、`TEST_ALLOWED_PHONES=["+8613800000000"]`。邮箱忽略大小写，重复项自动去重。以 `[]` 表示空集合。部署器据此生成投递和测试准入 secret 绑定；两个集合都为空时拒绝所有新登录。修改后需要重启本机 Auth 或更新测试部署。

## Web Assets 路由

内容哈希 JS、CSS 和图片直接由 Cloudflare Static Assets 提供。_headers 设置安全响应头及长期缓存，ETag 支持原生 304。入口页由 Auth Worker 注入环境信息并返回 no-store。构建将原始 HTML 放在 Worker 优先路由 /account/index.html 下，公开访问该路径返回 404。

Cloudflare Static Assets 对带 Range 的请求返回完整 200，本服务交由 Assets 直接提供内容哈希文件。 [Cloudflare 限制](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/#range-requests)

## D1 迁移基线

`worker/migrations/0001_auth_baseline.sql` 用于新建空库。使用目标环境的 Wrangler 配置运行 `d1 migrations apply`，再登记环境、应用和客户端。部署前核对配置指向已完成登记的新库。

旧版 Auth 库保留各自的迁移记录。切换环境时先核对新库的资源 ID 和登记，避免对旧库运行建库基线。

## 本地启动与发布

本地 dev 使用 `worker/.wrangler/state` 的 D1 数据。首次准备独立的 dev D1 时，明确执行现有迁移和两份无用户登记脚本。已有本地库先核对迁移及登记，保留原数据。如果 `unified-local` 是旧的模拟登记，使用本地管理操作将该行的 delivery 和 provider 改为 `LIVE` 并递增版本。

```sh
npm --prefix worker run db:migrate
npm --prefix worker run db:seed
(cd worker && npx wrangler d1 execute auth-local --local --config wrangler.fixture.jsonc --file unified-account-local-seed.sql)
npm start -- --env dev
```

本地 test 使用 `npm start -- --env test`，在 127.0.0.1:8787 访问，配置绑定已盘点的远程测试 D1。Auth 同时需要独立的 TEST 回环登记和对应的供应商回调。两类本地启动都会在只读结构与登记检查失败时退出。

部署前先执行 `npm test`，再运行 `npm run deploy -- --env test --dry-run` 或 `npm run deploy -- --env prod --dry-run`。实际部署使用同一命令并去掉 `--dry-run`。平台配置临时生成，Secret 由 Wrangler 部署参数注入。部署器先验证目标归属，再只读检查 D1 和活动应用、客户端、允许来源及回调。迁移和客户端管理由平台操作员显式执行。

要将 Auth 日志导出到 Grafana Cloud，在 Cloudflare Observability 的 Destinations 中创建 Logs 目标，使用 Grafana 的 OTLP `/v1/logs` 地址和 `Authorization` 请求头。把目标名称写入对应环境的 `config/test.properties` 或 `config/prod.properties`，例如 `grafanaLogsDestination=molis-grafana-logs`，然后重新部署。认证头保存在 Cloudflare。导出启用后，Worker 应用日志全量导出，关闭自动请求日志和 Cloudflare 日志留存，并隐藏请求 URL 的查询参数。[Cloudflare 配置说明](https://developers.cloudflare.com/observability/export/opentelemetry/grafana-cloud/)

### Grafana Loki 查询

Auth 的应用日志使用单行 JSON。公共字段为 `schema=1`、`service=molis-auth`、`env`、`event` 和 `request_id`。环境为 `prod`、`test`、`dev` 或 `unknown`。每个外部响应记录一条 `auth.http.request`，含 `method`、归一化的 `route`、`status`、`error_code` 和 `duration_ms`。成功响应的错误码为 `none`，没有业务错误码的失败响应使用 `http_error`。探活和静态资源的 2xx、3xx 响应跳过这条日志。BFF 的内部调用与外部响应共用请求 ID，内部调用的 5xx 仍可在 `auth.request.failure` 中按 `phase` 检索。失败诊断的错误字段为 `code`，耗时统一为 `duration_ms`。

`auth.aliyun.request` 使用同一个请求 ID。按 `action` 统计总调用数及 `outcome=success` 的比例，用 `duration_ms` 计算耗时。发送成功表示供应商接受了请求。短信校验成功表示供应商返回了校验结果，`verification_result` 标记验证码是否匹配。`auth.cleanup` 为每次定时运行生成独立的请求 ID，只记录清理轮数、按表汇总的删除数、耗时和停止原因。

在 Grafana Explore 选择 Loki 数据源。先按 Cloudflare 提供的 `cloudflare_script_name` 筛 Worker，再解析 Auth 记录中的服务和环境。下面的写法兼容应用 JSON 作为日志行和 Cloudflare 在 `message` 中包装应用 JSON 两种情况。现有阿里云查询可沿用相同的解析步骤，再按 `action` 和 `outcome` 过滤。正式与测试环境均已登记导出目的地。查询测试环境时，将 Worker 改为 `molis-auth-test`，环境改为 `test`。[Cloudflare Workers 日志格式](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) · [Grafana OTLP 日志格式](https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/)

核心 API 服务端可用率按 2xx、3xx 与 5xx 计算，排除 4xx（包括 429）。窗口内无符合条件的请求时显示无数据，有请求且无 5xx 时为 100%。

```logql
1 - (
  (sum(count_over_time(
    {service_name=~".+"} |= "auth.http.request"
    | cloudflare_script_name="molis-auth-production"
    | json cf_message="message"
    | line_format `{{ .cf_message | default (__line__) }}`
    | drop cf_message
    | json auth_service="service", auth_env="env", auth_event="event", route="route", status="status"
    | __error__="" | auth_service="molis-auth" | auth_env="prod" | auth_event="auth.http.request"
    | route=~"/api/(v1|account)/.+" | route!~"/api/v1/(health|readiness)"
    | status >= 500 | __error__=""
    [5m]
  )) or vector(0))
  /
  sum(count_over_time(
    {service_name=~".+"} |= "auth.http.request"
    | cloudflare_script_name="molis-auth-production"
    | json cf_message="message"
    | line_format `{{ .cf_message | default (__line__) }}`
    | drop cf_message
    | json auth_service="service", auth_env="env", auth_event="event", route="route", status="status"
    | __error__="" | auth_service="molis-auth" | auth_env="prod" | auth_event="auth.http.request"
    | route=~"/api/(v1|account)/.+" | route!~"/api/v1/(health|readiness)"
    | status=~"[235][0-9]{2}"
    [5m]
  ))
)
```

按路由查看核心 API 的 P95 响应耗时（毫秒），包含失败响应。

```logql
quantile_over_time(0.95,
  {service_name=~".+"} |= "auth.http.request"
  | cloudflare_script_name="molis-auth-production"
  | json cf_message="message"
  | line_format `{{ .cf_message | default (__line__) }}`
  | drop cf_message
  | json auth_service="service", auth_env="env", auth_event="event", route="route", duration_ms="duration_ms"
  | __error__="" | auth_service="molis-auth" | auth_env="prod" | auth_event="auth.http.request"
  | route=~"/api/(v1|account)/.+" | route!~"/api/v1/(health|readiness)"
  | unwrap duration_ms | __error__=""
  [5m]
) by (route)
```

部署前记录当前 Worker 版本、路由和客户端登记。回滚时使用 Cloudflare 已部署版本恢复能力，并核对当时的域名、客户端登记、D1 绑定和供应商回调。恢复 Worker 版本不回滚数据库。

## Auth 与 Club 正式切换

- Auth 正式入口为 `https://auth.molis.ai`，继续使用 `molis-auth-production` Worker。Club 正式来源为 `https://molis.ai`，使用同一正式 Auth。两个正式 Worker 使用自定义域名并关闭 `workers.dev` 与版本预览地址。
- 2026-11-19 已创建并迁移新库 `molis-auth-prod` 和 `molis-club-prod`，确认 Auth 17 项迁移、Club 7 项迁移及空用户数据。已删除两套原正式 D1。两个正式 Worker 在部署时切换新库绑定，发布前旧版本依赖 D1 的功能暂不可用。
- 新 Auth 库已登记 Auth 与 Club 的 Web 客户端、同源回调及 Club 产品归属。发布使用本仓库的 `npm run deploy -- --env prod`。
- 正式 Google 与 GitHub OAuth 应用分别登记 `https://auth.molis.ai/api/v1/auth/external/google/callback` 和 `https://auth.molis.ai/api/v1/auth/external/github/callback`。阿里云、OAuth、会话和状态密钥按 [正式模板](../secrets.example/prod.properties) 配置。先发布并验收 Auth，再发布 Club。

[三环境执行方案](environment-unification.md) · [Cloudflare 平台目标登记](../config/platform-targets.json)
