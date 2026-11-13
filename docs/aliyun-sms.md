# 阿里云短信认证

Auth 网页与 Molis Work 使用同一套 V2 challenge / verify / phone / complete 接口。唯一短信认证适配位于 `worker/rust/src/sms_auth.rs`；Workers HTTP 与 RPC 签名位于 `runtime/aliyun.js`。不调用 Dysmsapi，不使用普通短信套餐。

## 部署配置

先在隔离环境应用 `0014_sms_verifier.sql`；按现有部署流程应用全部连续迁移，不手工改真实库。Auth 环境登记及 `UNIFIED_ACCOUNT_CONFIG` 的 `deliveryMode` 均设为 `LIVE`，保留原客户端、回调和来源约束。MOCK 仍只供 LOCAL/TEST。

通过目标 Worker 的 Secrets 配置 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`，RAM 身份只授予 `dypns:SendSmsVerifyCode` 和 `dypns:CheckSmsVerifyCode`。配置变量 `ALIYUN_SMS_SIGN_NAME` 为控制台实际可用的赠送签名，不使用文档示例冒充已开通配置。

非 PRODUCTION 环境还必须配置 `ALIYUN_SMS_TEST_ALLOWLIST`，值为逗号分隔的完整 `+86` 号码；真实测试号码仅写本机未跟踪配置或云端变量，不入库。绑定测试手机号不代表免计费，真实测试按账户计费规则执行。

登录/注册使用模板 `100001`；绑定、换绑、重新确认手机号分别使用 `100004`、`100002`、`100005`。使用阿里云生成的六位数字，不返回或落库存储明文验证码。每个挑战派生独立的 20 字符 SchemeName，发送与核验一致，隔离并发客户端和不同用途；真实联调需要确认账户支持该方案名称规则。请求不自动重试，超时按失败处理，用户通过限流后的重新发送恢复。

发送前预留挑战，发送成功后才接受核验。核验前预留尝试次数，上游失败也消耗次数。Auth 对上游成功后的事务、挑战有效期和一次性消费重新做原子检查，不把 API 请求成功当成核验成功。只有 `Model.VerifyResult=PASS` 产生原有验证证明。重发使旧挑战失效。

注册邮件 LIVE 投递已接入杭州 Direct Mail，设置 `ALIYUN_MAIL_ACCOUNT_NAME` 与 `ALIYUN_MAIL_REGION=cn-hangzhou`，复用服务端 AK 并授予 `dm:SingleSendMail`。仅 EMAIL_SIGNUP 使用真实邮件；找回密码、邮箱绑定和邀请通知尚未接入，不能把注册邮件接入当作全部投递已完成。正式放量前验证 Auth 网页和 Work 均得到同一手机号账号，并确认账户的实际签名、计费和 SchemeName 行为。

## 验证

`node worker/scripts/rust-check.mjs check`

`node worker/scripts/rust-build.mjs`

`node --test --test-concurrency=1 worker/rust-tests/sms-live.test.ts worker/rust-tests/registration.test.ts worker/rust-tests/web-session.test.ts`

短信测试使用真实 WASM 和隔离 D1，外部 API 由测试拦截，不发送真实短信。

参考：[短信认证](https://help.aliyun.com/zh/pnvs/user-guide/sms-authentication-service)、[发送](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)、[核验](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-checksmsverifycode)。

## 验证码邮件文案

`worker/rust/src/mail_templates.rs` 是五种用途文案的唯一维护位置：`EMAIL_SIGNUP`（注册）、`PASSWORD_RESET`（重置密码）、`BIND`（绑定邮箱）、`REPLACE`（更换邮箱）、`REAUTH`（确认身份）。标题、正文、品牌和公共安全提示集中维护；验证码及事务到期时间由认证流程传入，模板按发送前剩余时长显示，不固定写五分钟。投递模块只负责调用模板和云服务，Work 不复制文案。

模板存在不表示对应认证能力已启用：当前真实邮件仅开放注册；其余四种用途须先接通对应权限与验证流程，再调用模板。确认身份必须验证已绑定邮箱并约束到敏感操作，不能仅靠选择模板获得授权。
