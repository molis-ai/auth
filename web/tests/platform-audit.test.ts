import test from "node:test";
import assert from "node:assert/strict";
import {
  auditOperationMeta,
  formatAuditTimestamp,
  formatDiffValue,
  formatRelativeAuditTime,
  resolveDirectoryUser,
  targetKindTone,
  type PlatformDirectoryUser,
} from "../src/lib/platform-audit.ts";

test("auditOperationMeta maps known operations and classifies unknown operations by prefix", () => {
  assert.deepEqual(auditOperationMeta("tenant.create"), { label: "平台创建团队", category: "tenant" });
  assert.deepEqual(auditOperationMeta("tenant.disable"), { label: "停用团队", category: "tenant" });
  assert.deepEqual(auditOperationMeta("permission.set"), { label: "更新平台权限", category: "account" });
  assert.deepEqual(auditOperationMeta("client.secret-rotate"), { label: "轮换客户端密钥", category: "app" });
  assert.deepEqual(auditOperationMeta("subscription.update"), { label: "调整订阅与席位", category: "billing" });
  assert.deepEqual(auditOperationMeta("member.custom"), { label: "member.custom", category: "tenant" });
  assert.deepEqual(auditOperationMeta("application.archive"), { label: "application.archive", category: "app" });
  assert.deepEqual(auditOperationMeta("seat.audit"), { label: "seat.audit", category: "billing" });
  assert.deepEqual(auditOperationMeta("other.event"), { label: "other.event", category: "account" });
});

test("resolveDirectoryUser resolves displayName when present and falls back cleanly without USER_READ", () => {
  const users = new Map<string, PlatformDirectoryUser>([
    ["usr_1", { userId: "usr_1", displayName: "李思远", email: "li@example.test", status: "ACTIVE", version: 1 }],
  ]);
  assert.deepEqual(resolveDirectoryUser("usr_1", users, true), {
    primary: "李思远",
    secondary: "li@example.test",
    resolved: true,
  });
  assert.deepEqual(resolveDirectoryUser("usr_missing", users, true), {
    primary: "usr_missing",
    secondary: "未在当前目录找到该账号",
    resolved: false,
  });
  assert.deepEqual(resolveDirectoryUser("usr_missing", new Map(), false), {
    primary: "usr_missing",
    secondary: "需 USER_READ 权限展开姓名",
    resolved: false,
  });
});

test("formatDiffValue and targetKindTone normalize display payloads", () => {
  assert.equal(formatDiffValue(null), null);
  assert.equal(formatDiffValue(undefined), null);
  assert.equal(formatDiffValue("ACTIVE"), "ACTIVE");
  assert.equal(formatDiffValue(3), "3");
  assert.equal(formatDiffValue(true), "true");
  assert.equal(formatDiffValue({ member: 10 }), '{"member":10}');

  assert.equal(targetKindTone("TENANT"), "tenant");
  assert.equal(targetKindTone("MEMBERSHIP"), "tenant");
  assert.equal(targetKindTone("CLIENT"), "app");
  assert.equal(targetKindTone("USER"), "user");
  assert.equal(targetKindTone("SUBSCRIPTION"), "billing");
  assert.equal(targetKindTone("UNKNOWN"), "neutral");
});

test("timestamp formatting produces stable output for valid and invalid inputs", () => {
  assert.match(formatAuditTimestamp("2026-11-26T14:22:18Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatAuditTimestamp("not-a-date"), "not-a-date");
  const base = Date.parse("2026-11-26T15:00:00Z");
  assert.equal(formatRelativeAuditTime("2026-11-26T14:59:30Z", base), "刚刚");
  assert.equal(formatRelativeAuditTime("2026-11-26T14:40:00Z", base), "20 分钟前");
  assert.equal(formatRelativeAuditTime("2026-11-26T12:00:00Z", base), "3 小时前");
  assert.equal(formatRelativeAuditTime("2026-11-24T15:00:00Z", base), "2 天前");
});
