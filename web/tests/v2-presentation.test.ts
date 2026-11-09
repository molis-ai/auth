import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

test("V2U-03 browser presentation uses the shared BFF client and keeps secrets outside browser persistence", () => {
  const source = readdirSync(new URL("../src/", import.meta.url))
    .filter((n) => /\.(vue|ts)$/.test(n))
    .map((n) => readFileSync(new URL("../src/" + n, import.meta.url), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    source,
    /localStorage|sessionStorage|accessToken|refreshToken|\/api\/v1|\/oauth2|Bearer /,
  );
  for (const label of [
    "邮箱注册",
    "找回密码",
    "账号安全",
    "租户",
    "应用管理",
    "用户与权限",
    "退出所有产品和设备",
  ])
    assert.ok(source.includes(label), label);
  assert.match(source, /onBeforeUnmount/);
  assert.match(source, /role="alert"/);
  assert.doesNotMatch(
    source,
    /PlatformServices|SERVICE_READ|SERVICE_WRITE|创建服务凭据/,
  );
});
