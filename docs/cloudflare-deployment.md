# Auth 启动与 Cloudflare 部署

配置使用 `config/<env>.properties` 和独立的 `secrets/<env>.properties`。密钥模板在 `secrets.example/`。会话和 OAuth 状态密钥分别使用 32 字节随机值的无填充 base64url 编码。先完成本环境的供应商和客户端登记，再启动。

阿里云邮件地域、发信账号、短信签名、dev 短信收件白名单和 AccessKey，以及 Google、GitHub 的客户端 ID 和密钥，都在对应环境的 `secrets/<env>.properties` 中配置。升级时将旧普通配置里的这些字段移入本环境的密钥文件，并从旧文件删除。test 的本地回调和远端回调各自使用配套的 OAuth 客户端 ID 和密钥。启动器和部署器使用原有 Worker 绑定名注入这些值。

`config/platform-targets.json` 记录已盘点的 Cloudflare 账户、Worker、Auth 来源及 D1 名称和 ID。环境 properties 必须与登记一致。更新目标时由平台操作员先核实资源归属，再更新两处声明。测试准入的 `allowedEmails` 和 `allowedPhones` 放在私有 `secrets/test.properties`，由部署器生成 secret 绑定。空名单拒绝对应方式的新登录。修改后需要重启本机 Auth 或更新测试部署。

本地 dev 使用 `worker/.wrangler/state` 的 D1 数据。首次准备独立的 dev D1 时，明确执行现有迁移和两份无用户登记脚本。已有本地库先核对迁移及登记，保留原数据。如果 `unified-local` 是旧的模拟登记，使用本地管理操作将该行的 delivery 和 provider 改为 `LIVE` 并递增版本。

```sh
npm --prefix worker run db:migrate
npm --prefix worker run db:seed
(cd worker && npx wrangler d1 execute auth-local --local --config wrangler.fixture.jsonc --file unified-account-local-seed.sql)
npm start -- --env dev
```

本地 test 使用 `npm start -- --env test`，在 127.0.0.1:8787 访问，配置绑定已盘点的远程测试 D1。Auth 同时需要独立的 TEST 回环登记和对应的供应商回调。两类本地启动都会在只读结构与登记检查失败时退出。

部署前先执行 `npm test`，再运行 `npm run deploy -- --env test --dry-run` 或 `npm run deploy -- --env prod --dry-run`。实际部署使用同一命令并去掉 `--dry-run`。平台配置临时生成，Secret 由 Wrangler 部署参数注入。部署器先验证目标归属，再只读检查 D1 和活动应用、客户端、允许来源及回调。迁移和客户端管理由平台操作员显式执行。

部署前记录当前 Worker 版本、路由和客户端登记。回滚时使用 Cloudflare 已部署版本恢复能力，并核对当时的域名、客户端登记、D1 绑定和供应商回调。恢复 Worker 版本不回滚数据库。

[三环境实施记录与平台登记清单](environment-unification-plan.md)
