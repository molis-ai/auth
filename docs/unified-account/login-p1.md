# 三端登录一致性

状态：P1 实施中。Auth 是账号、登录能力、身份绑定和撤销的唯一事实来源；各产品保持独立会话。

## 行为与验收清单

- [ ] LOGIN-P1-01：密码登录一步、验证码两步产品请求；验证码新身份自动创建账号，同身份重复登录保持 userId。密码、code、proof、Token 不出现在产品响应。
- [ ] LOGIN-P1-02：Google/GitHub 独立授权窗口；Work 桌面端使用系统浏览器。弹窗关闭或显式取消使本次尝试失效；迟到回调不能安装账号。账号切换须先退出，旧页面和迟到结果不得取得新账号权限。
- [ ] LOGIN-P1-03：经绑定校验的产品回调完成第三方登录；GET 事务查询不交换凭据、不建立会话。只有 CONSUMED 且产品会话 AUTHENTICATED 才成功。错误 state、重复回调、并发完成、到期和取消均不得重复签发或恢复会话。
- [ ] LOGIN-P1-04：Auth 按注册客户端/环境返回配置就绪的登录方式。能力清单不是授权或远端健康探测，实际认证继续校验。配置缺失的提供方不显示可用；能力查询失败明确反馈，不能默认为全部可用。
- [ ] LOGIN-P1-05：CURRENT_LOGIN 仅撤销该中央登录；ALL_MOLIS_PRODUCTS 撤销该账号所有中央登录。产品持久清理成功与远端撤销确认分开表达。Work 离线缓存仅展示，不授予中央操作权限。
- [ ] LOGIN-P1-06：六份合同、生成类型、版本和固定 Auth 源提交一致；篡改摘要也不能通过源头比较。消费者不追随 main，固定不可变提交。

## 合理的平台差异

Auth 的 Cookie/加密 BFF、Club 的 D1 跨请求事务及 Work 的进程内生命周期和 SecretStore 各自拥有会话。只统一协议语义，不共享 Cookie，不合并本地 Home，不按邮箱自动合并第三方身份。找回密码用 RESET_PROOF，敏感已登录操作用 REAUTH 绑定的证明。

## 发布顺序

先部署通过验收的 Auth 1.3.0（新增 GET /api/v2/auth/capabilities，产品映射 /api/account/auth/capabilities），确认注册客户端能力；再发布固定该提交的 Club 和 Work。旧消费者仍可使用现有登录接口；新消费者遇到旧 Auth 缺少能力接口时明确不可用，不猜测能力。回滚消费者不要求回滚 Auth。运行中的部署检查与本地/CI 的模拟提供方测试分别记录，不把模拟授权描述为真实 Google/GitHub 验收。

合同变更先提交 Auth，再运行 sync-products.mjs --write 写入精确来源；消费者 CI 检出该 SHA 并用 verify-product.mjs 对照原件。GitHub Actions 只验证，不部署、不开真实短信或邮件、不使用生产凭据。
