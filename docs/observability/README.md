# Molis Auth 监控看板

在 Grafana 13 的 **Dashboards → New → Import** 导入 `grafana-auth-dashboard.json`，选择接收 Cloudflare Workers 日志的 Loki 数据源。UID 为 `molis-auth-observability-v2`。确认日志存在 `cloudflare_script_name` 和 JSON 信封，再用 `env` 选生产 `prod` 或测试 `test`。测试部署的 `environmentId` 为 `unified-staging`，日志仍使用 `env=test`。本机 `dev` 不向 Grafana 导出。

顶部的 **Molis Billing 看板**链接保留环境和时间范围。将响应头中的完整 UUID 填入 `request_id` 后，后端页会显示同环境下两仓的串联日志。清空后该面板不执行查询。改生成器后运行 `node docs/observability/build-auth-dashboard.mjs`，再运行 `node --test scripts/observability-dashboard.test.mjs`。

| 位置 | 面板 | 事件和主要字段 |
| --- | --- | --- |
| 顶部 | kpi-availability、kpi-errors | `auth.http.request` 的 `status`、`route`。可用率分母为核心路由 2xx、3xx、5xx |
| 顶部 | kpi-login | `auth.login.result` 的 `outcome` |
| 顶部 | kpi-browser | `auth.web.session` 的 `outcome` |
| 顶部 | kpi-cleanup | `auth.cleanup` 的 `duration_ms`，取两小时最长 |
| 业务 | b1 | `auth.login.result` 的 `method`、`outcome` |
| 业务 | b2 | `auth.login.result` 的 `new_user`、`entry` |
| 业务 | b3 | `auth.verification.sent` 和 `auth.verification.verified` 的 `channel`、`provider`、`outcome` |
| 业务 | b4 | `auth.login.result` 的 `error_code` |
| 业务 | b5 | `auth.tenant.event` 的 `action`、`outcome` |
| 前端 | f1 | `auth.web.vital` 的 `page`、`metric`、`value` |
| 前端 | f2 | `auth.web.error` 的 `kind`、`view`、`name`、`release` |
| 前端 | f3 | `auth.web.oauth_popup` 的 `provider`、`outcome` |
| 前端 | f4 | `auth.web.api_issue` 的 `endpoint`、`status`、`error_code`、`degraded`、`duration_ms` |
| 前端 | f5 | `auth.web.cache` 的 `hits`、`misses` |
| 后端 | k1 | `auth.http.request` 的 `route`、`status` |
| 后端 | k2 | `auth.http.request` 的 `method`、`route`、`duration_ms` |
| 后端 | k3 | `auth.upstream.request`、`auth.external.request`、`auth.aliyun.request` 的依赖维度、`outcome`、`error_code`、`duration_ms` |
| 后端 | k4 | `auth.http.request` 的 `status`、`error_code`，含探针和遥测错误 |
| 后端 | k5 | `auth.cleanup` 的 `duration_ms`、`stop_reason`，以及 `auth.cleanup.failure` 次数 |
| 后端 | k6 | 两仓 schema 1 事件的 `request_id` 和 `env` |

生产性能数据按页面采样 10%，测试和本机采样 100%。异常、API 降级和 OAuth 弹窗独立于性能采样，每页共享最多 20 条，合并延迟最多 3 秒。Worker 只接受白名单字段，版本标识绑定不可用时记录 `release=unknown`。

## P0 告警

在 Grafana Alerting 为 `prod` 建规则，评估间隔 1 分钟。复制对应面板的 Loki 查询，将看板变量替换为固定值。低流量比例告警建议同时设置最小样本量。

| 告警 | 建议触发条件 |
| --- | --- |
| 核心 API 不可用 | 5 分钟窗口可用率低于 99%，窗口请求至少 20 次，持续 5 分钟 |
| 核心 API 5xx 激增 | 5 分钟窗口内超过 10 次，持续 5 分钟 |
| 登录失败 | 10 分钟窗口内登录成功率低于 90%，至少 20 次尝试，持续 5 分钟 |
| 清理超时 | 近两小时任一次清理达到 8,000 ms |
| Cron 心跳缺失 | 按小时调度，`absent_over_time(<auth.cleanup 的日志查询>[2h15m]) > 0` |

心跳查询从 k5 的 `auth.cleanup` 流中保留事件与环境过滤，去掉 `unwrap`。可用率与 5xx 告警之外，分别监控外部健康检查和 readiness。
