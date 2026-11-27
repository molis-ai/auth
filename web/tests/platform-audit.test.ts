import test from "node:test";
import assert from "node:assert/strict";
import {
  auditOperationMeta,
  formatAuditTimestamp,
  formatDiffValue,
  formatRelativeAuditTime,
  platformAuditPath,
  auditActorLabel,
  targetKindTone,
} from "../src/features/platform/platform-audit.ts";
import { tenantOwner } from "../src/features/platform/platform-tenants.ts";

test("auditOperationMeta maps known operations and classifies unknown operations by prefix", () => {
  assert.deepEqual(auditOperationMeta("tenant.create"), { label: "平台创建团队", category: "tenant" });
  assert.deepEqual(auditOperationMeta("tenant.disable"), { label: "停用团队", category: "tenant" });
  assert.deepEqual(auditOperationMeta("permission.set"), { label: "更新平台权限", category: "account" });
  assert.deepEqual(auditOperationMeta("client.secret-rotate"), { label: "轮换客户端密钥", category: "app" });
  assert.deepEqual(auditOperationMeta("member.custom"), { label: "member.custom", category: "tenant" });
  assert.deepEqual(auditOperationMeta("application.archive"), { label: "application.archive", category: "app" });
  assert.deepEqual(auditOperationMeta("other.event"), { label: "other.event", category: "account" });
});

test("audit labels use the projected actor name and support older responses", () => {
  assert.equal(auditActorLabel({ actorUserId: "usr_1", actorDisplayName: "李思远" }), "李思远");
  assert.equal(auditActorLabel({ actorUserId: "usr_1", actorDisplayName: null }), "usr_1");
  assert.equal(auditActorLabel({ actorUserId: "usr_1" }), "usr_1");
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

test("audit filters encode the team scope, category, result and keyword for server pagination", () => {
  assert.equal(platformAuditPath({ category: "all", result: "ALL", q: " " }), "/platform/audit-events");
  const scoped = new URL(platformAuditPath({
    tenantId: "team:1", category: "tenant", result: "SUCCEEDED", q: " 修复+权限 ", limit: 10,
  }), "https://auth.example.test");
  assert.equal(scoped.pathname, "/platform/audit-events");
  assert.deepEqual(Object.fromEntries(scoped.searchParams), {
    tenantId: "team:1", category: "tenant", result: "SUCCEEDED", q: "修复+权限", limit: "10",
  });
});

test("team owner details use the team projection without a platform user directory", () => {
  const team = { tenantId: "team", name: "测试团队", status: "ACTIVE", version: 0, ownerUserId: "owner" };
  assert.deepEqual(tenantOwner({
    ...team, ownerDisplayName: "成员甲", ownerEmail: "owner@example.test",
  }), { primary: "成员甲", secondary: "owner@example.test", resolved: true });
  assert.deepEqual(tenantOwner(team), { primary: "owner", secondary: "未绑定邮箱", resolved: false });
});
