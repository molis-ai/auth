# V2 回归范围变更

未上线，不保留 V1 读取、协议、Team/VIEWER、权限矩阵、Apple 或双栈迁移。删除上述实现时，同步撤销只测试这些旧合同的用例。不得跳过现行 V2 的拒绝断言。

|撤销用例文件|原 test 数|现行覆盖|
|---|---:|---|
|web/tests/protocol.test.ts|8|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/login-transaction.test.ts|4|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/provider-mailbox.test.ts|7|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/provider.test.ts|7|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/security.test.ts|5|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/mail-policy.test.ts|2|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/team-create.test.ts|2|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/auth-feedback.test.ts|6|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/completion.test.ts|8|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/console-restore.test.ts|3|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/console.test.ts|7|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/member-table.test.ts|3|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/workspace.test.ts|9|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/team-query.test.ts|2|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/team-avatar.test.ts|3|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/login-presentation.test.ts|6|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/space.test.ts|3|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/pending.test.ts|3|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/space-groups.test.ts|2|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|web/tests/permission-edit.test.ts|1|web-session.test.ts、SDK v2-client.test.ts、V2 浏览器验收|
|worker/rust-tests/integration.test.ts|1|platform-management / tenant-creation / tenants / registration / account-management / login-sessions / external-login / routes.test.ts|
|worker/rust-tests/providers.test.ts|1|platform-management / tenant-creation / tenants / registration / account-management / login-sessions / external-login / routes.test.ts|
|worker/rust-tests/account-migration.test.ts|1|platform-management / tenant-creation / tenants / registration / account-management / login-sessions / external-login / routes.test.ts|
|worker/rust-tests/unified-policy.test.ts|9|platform-management / tenant-creation / tenants / registration / account-management / login-sessions / external-login / routes.test.ts|
|worker/tests/account-migration.test.ts|10|platform-management / tenant-creation / tenants / registration / account-management / login-sessions / external-login / routes.test.ts|
|worker/tests/subscription-migration.test.ts|1|platform-management / tenant-creation / tenants / registration / account-management / login-sessions / external-login / routes.test.ts|
|worker/tests/entitlement-migration.test.ts|1|platform-management / tenant-creation / tenants / registration / account-management / login-sessions / external-login / routes.test.ts|

密码 KDF、限流、身份绑定、刷新重放、退出、CSRF、回调状态、并发版本、原子拒绝、租户角色和权益的现行 V2 用例保留。routes.test.ts 新增所有 V1 入口拒绝与无写入。原 SDK 直接持有 Token 的用例随 AuthClient 删除，由同源 Cookie/CSRF、取消与禁止任意代理的用例替代。
