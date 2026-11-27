# Auth 仓库协作约定

- 修改前先读 [Auth 工程架构](docs/architecture.md)，按功能归属找对应领域。HTTP 公共合同和生成入口在 [contracts/unified-account](contracts/unified-account/README.md)。
- Rust 的 `worker/rust/src/` 根目录仅保留 `lib.rs` 和 `app.rs`。带子模块的领域和基础设施使用各自的 `mod.rs` 作为入口，WASM 的 `worker/rust/src/runtime/*.js` 路径保持固定。业务规则归领域，`core/` 不引用入口或业务模块。
- Vue 页面、类型和专属样式放在 `web/src/features/<领域>/`。真正跨领域且不携带业务规则的组件及工具放在 `web/src/shared/`。跨领域复用经该领域的 `index.ts`，并在 Web 架构测试中明确登记。
- 目录迁移与业务行为变动分开提交。目录和引用调整运行 `npm test` 与 `npm run build:web`，页面、会话或导航拆分时也运行相关浏览器回归。
