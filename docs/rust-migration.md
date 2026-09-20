# Rust 迁移验收记录

## 交付内容

- Rust 实现登录注册、PKCE/授权码、根会话、访问令牌、刷新轮换与退出。
- Rust 实现个人资料和头像、团队与成员、邀请、审计、平台管理和应用鉴权。
- Google/Apple OIDC 保留浏览器绑定、一次性 state、签名、nonce、issuer/audience 和时效校验。
- 本地、preview、production 的 Wrangler 入口改为 Rust 构建产物；Vue/SDK/API/D1 表结构保留。
- 旧 `worker/src/` TS 后端及专属测试已删除，开发脚本和测试已解除对旧实现的依赖。

## 本地已验证

在仓库根目录：

```sh
npm test
npm run build
npm run format:check
npm run cloudflare -- production dry-run
```

Rust 单元测试、真实 WASM + 隔离 D1 的平台/鉴权/原子写入测试、Google 与 Apple 模拟回调测试，以及前端、SDK 回归全部通过。删除旧实现后，密码兼容性和路由保护测试也直接使用 Rust WASM。正式配置 dry-run 压缩后约 771 KiB（具体以本次构建输出为准）。没有执行 deploy。

额外使用隔离数据库 `auth-rust-local`、端口 8788 执行真实 HTTP 验收：

```sh
# 首次准备隔离测试环境；以下命令在 worker/ 目录执行
npx wrangler d1 migrations apply auth-rust-local --local --config rust/wrangler.jsonc
npx wrangler d1 execute auth-rust-local --local --config rust/wrangler.jsonc --file rust/seed.sql
npx wrangler dev --local --config rust/wrangler.jsonc --port 8788

# 另开终端，同样在 worker/ 下
AUTH_TEST_ORIGIN=http://127.0.0.1:8788 node scripts/smoke.ts
AUTH_TEST_ORIGIN=http://127.0.0.1:8788 node scripts/e2e.ts
```

通过项目：页面别名与 JS/CSS 资源、未登录 API 拒绝访问、注册和密码登录、PKCE 与授权码重放拒绝、头像保存与非法图片不覆盖旧图、团队创建、成员分页、邀请归属与重放保护、角色保护、审计、会话恢复、刷新轮换/重放撤销、退出后令牌失效。

E2E 创建的 synthetic 账号与团队仅保留在隔离本地 D1（`worker/rust/.wrangler/`），不接触默认开发数据库或远程数据库。

## 尚未做的外部操作

- 没有提交、推送或部署本次改动。
- 没有修改线上 D1、用户、Secret 或管理员配置。
- 没有用真实 Google/Apple 账号联调。
- 未测量真实 Cloudflare 免费套餐的 CPU 消耗；本地耗时、包大小不构成线上额度保证。上线前应在隔离预览环境完成验证。

## 发布与回滚

1. 保存当前线上 Worker 版本和仓库提交信息；备份正式 D1。
2. 先在独立预览数据库发布 Rust，检查现有 TS 密码与会话兼容、下游应用鉴权及真实 CPU 指标。
3. 验收后将改动合并到部署分支，使用既有 CI/CD；构建仍执行 `npm run setup`，部署脚本会自动编译 WASM。
4. 如出现回归，回滚 Worker 到上一 TS 版本；这次没有 schema 变更，不需要执行反向数据库迁移。
