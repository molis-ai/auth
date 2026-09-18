# 本机 Docker 浏览器验收

只需安装并启动 Docker Desktop（包含 Docker Compose v2）；Linux 可使用 Docker Engine + Compose v2。
不需要本机 Java、Node、Maven、MySQL 或 Redis。首次构建需要联网下载镜像和依赖。

在项目根目录执行：

```sh
sh docker-up.sh
```

- 控制台：http://localhost:8080/console （务必使用 localhost，不要改成 127.0.0.1）
- 开发收件箱：http://localhost:8025
- 状态：`docker compose ps`

启动脚本会在 macOS 上复用已经启用的系统 HTTPS 代理（仅当前进程，不改系统配置），
避免 BuildKit 获取 Docker Hub 令牌时绕过代理而超时。已有 HTTPS_PROXY 环境变量优先。
网络可直连时也可以直接执行 `docker compose up --build -d --wait`。

容器内端到端冒烟测试（无需本机 Node；每次创建一个 `docker-smoke-…@example.test` 测试账号）：

```sh
docker compose --profile test run --rm smoke
```

验证实际 SMTP 收件、邮箱确认、注册、账号确认、PKCE 兑换、本人信息及退出失效。
不修改已有账号，不输出密码或 Token，测试账号保留在开发数据库中。
- 启动排错：`docker compose logs --tail=100 auth mysql init mailpit`

从控制台进入注册，使用测试邮箱（例如 alice@example.test）。打开开发收件箱，
在新标签页打开验证链接并确认；保留原注册页，返回它完成注册和登录。
邮件仅送入本机 Mailpit，不会发送到真实邮箱；所有使用者都能查看这个本机收件箱，切勿用于真实账号。
无默认账号，不会将首个注册者自动提升为管理员。

验收平台管理：注册后复制控制台显示的本人 userId，在项目根目录创建 `.env`：

```dotenv
AUTH_PLATFORM_ADMIN_USER_IDS=替换为本人完整userId
```

然后执行 `docker compose up -d --wait`，让 Auth 重建并加载白名单。不要用 `restart` 代替配置更新。

`docker compose down` 停止并移除容器，但保留账号、邮件、Redis 数据及随机密钥卷。
再次运行启动命令可继续使用。**不要加 `-v`：它会删除本项目数据库和密钥等数据。**
不要单独删除密钥卷，否则数据库密码及待发送邮件无法恢复。开发端口 8080、8025 必须空闲。

本配置只用于开发验收：宿主机端口仅绑定 127.0.0.1；数据库和 Redis 不发布端口，
数据库和 Redis 仅加入隔离内部网络；Auth/Mailpit 另接端口发布网络。Java 使用容器内 loopback 代理，未放宽 HTTP/Origin 校验；
SMTP 使用独立生成证书的 STARTTLS 和服务端身份验证。随机凭据保存在 Docker 卷，不写入仓库。
代理下所有本机请求共享 IP 限流，遇到限流请等待窗口，不要反复发送邮件。
Google/Apple 默认关闭。本配置不是生产部署，也不支持局域网分享、真实第三方登录或真实邮件投递。

实现依据：[Compose 启动依赖](https://docs.docker.com/compose/how-tos/startup-order/)、
[Mailpit SMTP TLS 配置](https://mailpit.axllent.org/docs/configuration/runtime-options/)。
