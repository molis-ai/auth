# 本机 Homebrew Redis

2026-09-15 已通过 Homebrew 安装 Redis 8.10.1。

- 程序：`/opt/homebrew/bin/redis-server`、`/opt/homebrew/bin/redis-cli`。
- 配置：`/opt/homebrew/etc/redis.conf`；默认仅绑定 loopback，端口 6379，protected-mode 开启。
- 用户批准后，本次安装命令临时使用中科大镜像的 HOMEBREW_ARTIFACT_DOMAIN 和 HOMEBREW_API_DOMAIN；未修改 shell 启动文件或 Homebrew 仓库远程，未关闭完整性校验。
- Homebrew 同时更新所需的 portable Ruby、ca-certificates 和 openssl@3。未启用 Redis 登录自启动。

按需前台启动：

```sh
/opt/homebrew/bin/redis-server /opt/homebrew/etc/redis.conf
```

另一个终端执行 `redis-cli ping`，应返回 PONG。需要登录自启动时，由用户执行 `brew services start redis`。

Auth 开发配置启用 `AUTH_EPHEMERAL_ENABLED=true`，连接 `AUTH_REDIS_HOST=127.0.0.1`、`AUTH_REDIS_PORT=6379`。安装 Redis 不等于自动开启 Auth 登录或邮件功能，其余开关按现有说明设置。

自动测试应另外启动全新隔离端口，例如：

```sh
/opt/homebrew/bin/redis-server --bind 127.0.0.1 --port 46384 --save '' --appendonly no
```

向测试命令传入 `-Dauth.it.redis-port=46384`。不用日常 6379，也不对日常 Redis 执行 FLUSH。多轮共享测试实例会累计邮件小时限流，因此每轮完整测试使用全新隔离实例。生产环境另需访问控制、凭据、TLS、备份及可用性配置，不能直接照搬本机无密码配置。
