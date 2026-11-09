# Cloudflare 部署

当前代码只提供 V2 账号协议。此文是部署操作说明，不代表本次已经部署或完成真实投递、Google/GitHub LIVE 联调。

`worker/deploy/preview` 与 `production` 分别拥有 Worker、D1、环境及 Auth Web 客户端；不能共用数据库。配置必须声明 `UNIFIED_ACCOUNT_CONFIG`、`AUTH_WEB_CLIENT_ID` 与 `TENANT_CREATION_POLICY`。浏览器回调精确为对应 Auth origin 的 `/account/callback`；产品回调由各客户端自己的 V2 policy 决定。

部署前通过 Wrangler secret 配置随机 32 字节 base64url 的 `AUTH_WEB_SESSION_KEY`。它是 Auth BFF 加密持久会话的稳定密钥，不能放入 vars、种子、日志或浏览器。轮换它会使原 BFF Cookie 无法解密，需要用户重新登录。提供方另需现行服务所要求的密钥与 LIVE 适配，生产环境不接受 MOCK。

本仓库尚未上线，不做 V1 客户端、Cookie、Token、Team、VIEWER 或超管白名单的自动迁移。旧实验环境的数据库如何保留/重建应另行确认；本次开发、构建和测试均不得自动操作真实云端或开发机的既有库。

先在本地运行完整验证，再离线检查配置与打包：

```sh
npm test
npm run build
npm run cloudflare -- preview dry-run
npm run cloudflare -- production dry-run
```

远端 `migrate`、`seed`、`deploy` 命令会改变云端状态，需单独授权后执行。种子不创建用户、密码、平台权限或订阅。平台权限只从 `auth_platform_permission` 判定；不接受 `PLATFORM_ADMIN_IDS`。
