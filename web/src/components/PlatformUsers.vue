<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { AuthError, type AccountClient } from "../lib/account-client.ts";
import { accountErrorMessage } from "../lib/errors.ts";
import type { WriteOptions } from "../lib/idempotent-submit.ts";

declare const __AUTH_PLATFORM_CAPABILITIES__: readonly string[];
const props = defineProps<{
  client: AccountClient;
  capabilities: string[];
  submitWrite: <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;
}>();
const emit = defineEmits<{ expired: [error: unknown] }>();

interface User {
  userId: string;
  displayName: string;
  email: string | null;
  status: string;
  version: number;
}
interface Grant {
  capability: string;
  status: string;
  version: number;
}
type AuditAction = { user: User } & (
  | { kind: "email"; email: string }
  | { kind: "status"; disabling: boolean }
  | { kind: "permission"; capability: string; grant?: Grant }
);

const capabilityDescriptions: Record<string, string> = {
  USER_READ: "查看平台用户列表与基础资料",
  USER_STATUS: "停用或恢复平台用户账号状态",
  USER_EMAIL_WRITE: "维护用户邮箱并强制撤销全端会话",
  PLATFORM_PERMISSION_WRITE: "授予或撤销平台级管理权限",
  APPLICATION_READ: "查看已登记的业务应用",
  APPLICATION_WRITE: "创建或修改业务应用状态",
  CLIENT_READ: "查看应用下的登录客户端配置",
  CLIENT_WRITE: "登记或修改客户端回调与来源白名单",
  TENANT_CREATE: "代表平台创建并分配新的团队空间",
  TENANT_READ: "查看平台内所有团队空间与成员概览",
  TENANT_STATUS: "停用或恢复团队空间的启用状态",
  CATALOG_WRITE: "维护订阅产品目录与套餐价格配置",
  SUBSCRIPTION_WRITE: "调整平台侧订阅状态与配额变更",
  SUBSCRIPTION_READ: "查看平台侧订阅与账务审计状态",
  AUDIT_READ: "查看平台审计日志与安全变更记录",
};
const capabilities = __AUTH_PLATFORM_CAPABILITIES__;
const canSetStatus = computed(() => props.capabilities.includes("USER_STATUS"));
const canEditEmail = computed(() => props.capabilities.includes("USER_EMAIL_WRITE"));
const canManagePermissions = computed(() => props.capabilities.includes("PLATFORM_PERMISSION_WRITE"));
const users = ref<User[]>([]);
const selected = ref<User>();
const grants = ref<Grant[]>([]);
const search = ref("");
const emailDraft = ref("");
const busy = ref(false);
const message = ref("");
const auditDialog = ref<HTMLDialogElement>();
const audit = ref<AuditAction>();
const reason = ref("");
const auditError = ref("");
let active = true;

const filteredUsers = computed(() => {
  const q = search.value.trim().toLowerCase();
  return users.value.filter(user => [user.displayName, user.email ?? "", user.userId]
    .some(text => text.toLowerCase().includes(q)));
});
const grantsByCapability = computed(() => new Map(grants.value.map(grant => [grant.capability, grant])));
const grantedCount = computed(() => grants.value.filter(grant => grant.status === "ACTIVE").length);
const auditTitle = computed(() => {
  const action = audit.value;
  if (!action) return "";
  if (action.kind === "email") return "填写操作原因并变更邮箱";
  if (action.kind === "status") return (action.disabling ? "停用 " : "恢复 ") + action.user.displayName + "？";
  return action.grant?.status === "ACTIVE" ? "撤销平台权限？" : "授予平台权限？";
});
const auditDanger = computed(() => {
  const action = audit.value;
  return (action?.kind === "status" && action.disabling) ||
    (action?.kind === "permission" && action.grant?.status === "ACTIVE");
});

async function run(task: () => Promise<void>, errorMessage = message) {
  if (busy.value) return;
  busy.value = true;
  errorMessage.value = "";
  try {
    await task();
  } catch (error) {
    if (!active || (error instanceof AuthError && error.code === "CANCELLED")) return;
    errorMessage.value = accountErrorMessage(error);
    emit("expired", error);
  } finally {
    if (active) busy.value = false;
  }
}

async function list<T>(path: string) {
  const values: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const result: { items: T[]; nextCursor: string | null } = await props.client.request(
      path + "?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
    );
    values.push(...result.items);
    cursor = result.nextCursor;
    if (cursor && seen.has(cursor)) throw Error("分页状态已变化");
    if (cursor) seen.add(cursor);
  } while (cursor && active);
  return values;
}

function userPath(user: User) {
  return "/platform/users/" + encodeURIComponent(user.userId);
}

async function select(user: User) {
  const data = canManagePermissions.value ? await list<Grant>(userPath(user) + "/permissions") : [];
  if (!active) return;
  selected.value = user;
  emailDraft.value = user.email ?? "";
  grants.value = data;
}

async function load() {
  const data = await list<User>("/platform/users");
  if (!active) return;
  users.value = data;
  const current = data.find(user => user.userId === selected.value?.userId) ?? data[0];
  if (current) {
    await select(current);
  } else {
    selected.value = undefined;
  }
}

async function openAudit(action: AuditAction) {
  if (busy.value || audit.value) return;
  audit.value = action;
  auditError.value = "";
  reason.value = "";
  await nextTick();
  if (active) auditDialog.value?.showModal();
}

function closeAudit() {
  auditDialog.value?.close();
  audit.value = undefined;
  auditError.value = "";
  reason.value = "";
}

function cancelAudit() {
  if (!busy.value) closeAudit();
}

function confirmAudit() {
  return run(submitAudit, auditError);
}

async function submitAudit() {
  const action = audit.value;
  const auditReason = reason.value.trim();
  if (!action || !auditReason) return;
  const path = userPath(action.user);

  if (action.kind === "permission") {
    const enabled = action.grant?.status !== "ACTIVE";
    await props.submitWrite<Grant>(path + "/permissions/" + encodeURIComponent(action.capability), {
      enabled,
      expectedVersion: action.grant?.version ?? null,
      reason: auditReason,
    }, {
      method: "PATCH",
      success: enabled ? "已授予平台权限" : "已撤销平台权限",
      after: async updated => {
        if (!active) return;
        grants.value = [...grants.value.filter(grant => grant.capability !== updated.capability), updated];
        closeAudit();
      },
    });
    return;
  }

  const change = action.kind === "email"
    ? { email: action.email }
    : { status: action.disabling ? "DISABLED" : "ACTIVE" };
  await props.submitWrite<User>(path + "/" + action.kind, {
    ...change,
    expectedVersion: action.user.version,
    reason: auditReason,
  }, {
    method: "PATCH",
    success: action.kind === "email" ? "邮箱已更新，登录会话已撤销" : action.disabling ? "账号已停用" : "账号已恢复",
    after: async updated => {
      if (!active) return;
      users.value = users.value.map(user => user.userId === updated.userId ? updated : user);
      selected.value = updated;
      if (action.kind === "email") emailDraft.value = updated.email ?? "";
      closeAudit();
    },
  });
}

onMounted(() => void run(load));
onBeforeUnmount(() => {
  active = false;
  auditDialog.value?.close();
});
</script>

<template>
  <section class="platform-users-page">
    <div class="pu-shell">
      <aside class="pu-rail" aria-label="平台用户目录">
        <div class="pu-rail-head">
          <h1>用户与权限</h1>
          <span class="pu-pill pu-rail-count">{{ users.length }}</span>
        </div>

        <input v-model="search" type="search" class="pu-search" aria-label="搜索平台用户" placeholder="搜索昵称或邮箱…" />

        <div class="pu-list">
          <button
            v-for="user in filteredUsers"
            :key="user.userId"
            type="button"
            class="pu-user-item"
            :aria-current="selected?.userId === user.userId ? 'true' : undefined"
            :disabled="busy"
            @click="run(() => select(user))"
          >
            <span class="pu-avatar" aria-hidden="true">{{ user.displayName.slice(0, 1) || "U" }}</span>
            <span class="pu-user-copy">
              <span class="pu-user-top">
                <span class="pu-user-name">{{ user.displayName }}</span>
                <span class="pu-dot" :class="{ 'is-danger': user.status !== 'ACTIVE' }" :title="user.status === 'ACTIVE' ? '正常启用' : '已停用'" />
              </span>
              <span class="pu-user-meta">{{ user.email ?? "未绑定邮箱" }}</span>
            </span>
          </button>
          <p v-if="busy && !users.length" class="pu-list-hint" role="status">正在读取用户…</p>
          <p v-else-if="search.trim() && !filteredUsers.length" class="pu-list-hint">没有匹配的用户</p>
        </div>

        <div v-if="canSetStatus || canEditEmail || canManagePermissions" class="pu-rail-note">
          <strong>审计要求</strong>
          停用或恢复账号、变更邮箱或调整平台权限时，弹窗将要求填写审计原因并写入平台审计日志。
        </div>
      </aside>

      <div class="pu-detail">
        <div class="pu-detail-inner">
          <div v-if="message" class="pu-alert" role="alert">
            <span>{{ message }}</span>
            <button type="button" class="pu-button is-small" :disabled="busy" @click="run(load)">刷新</button>
          </div>

          <template v-if="selected">
            <header class="pu-selected-head">
              <div class="pu-selected-left">
                <span class="pu-avatar is-lg" aria-hidden="true">{{ selected.displayName.slice(0, 1) || "U" }}</span>
                <div class="pu-selected-copy">
                  <div class="pu-selected-row">
                    <h2>{{ selected.displayName }}</h2>
                    <span class="pu-pill" :class="selected.status === 'ACTIVE' ? 'is-success' : 'is-danger'">
                      <i class="pu-pill-dot" aria-hidden="true"></i>
                      {{ selected.status === "ACTIVE" ? "正常启用" : "已停用" }}
                    </span>
                  </div>
                  <p class="pu-selected-meta">{{ selected.userId }}{{ selected.email ? " · " + selected.email : "" }}</p>
                </div>
              </div>
              <button
                v-if="canSetStatus"
                type="button"
                class="pu-button pu-head-action"
                :class="selected.status === 'ACTIVE' ? 'is-danger-soft' : 'is-primary'"
                :disabled="busy"
                @click="openAudit({ kind: 'status', user: selected!, disabling: selected!.status === 'ACTIVE' })"
              >
                {{ selected.status === "ACTIVE" ? "停用账号" : "恢复账号" }}
              </button>
            </header>

            <section v-if="canEditEmail" class="pu-card">
              <header class="pu-card-head">
                <h3>维护登录邮箱</h3>
                <p>修改后该用户在所有产品与设备上的登录会话都会立即失效，请先核实归属</p>
              </header>
              <form class="pu-email-form" @submit.prevent="openAudit({ kind: 'email', user: selected!, email: emailDraft.trim() })">
                <label class="pu-field pu-email-field">
                  邮箱地址
                  <input v-model="emailDraft" type="email" required maxlength="254" :disabled="busy" />
                </label>
                <button type="submit" class="pu-button is-primary" :disabled="busy">保存邮箱并撤销登录</button>
              </form>
            </section>

            <section v-if="canManagePermissions" class="pu-card pu-cap-section">
              <header class="pu-card-head">
                <h3>平台级权限矩阵</h3>
                <p>已授予 {{ grantedCount }} / {{ capabilities.length }} 项平台能力（与团队内角色相互独立）</p>
              </header>
              <div class="pu-cap-grid">
                <div
                  v-for="capability in capabilities"
                  :key="capability"
                  class="pu-cap-card"
                  :class="{ 'is-granted': grantsByCapability.get(capability)?.status === 'ACTIVE' }"
                >
                  <span class="pu-cap-info">
                    <strong>{{ capability }}</strong>
                    <span class="pu-cap-desc">{{ capabilityDescriptions[capability] }}</span>
                  </span>
                  <button
                    type="button"
                    class="pu-button is-small"
                    :class="grantsByCapability.get(capability)?.status === 'ACTIVE' ? 'is-danger-soft' : 'is-primary'"
                    :disabled="busy"
                    @click="openAudit({ kind: 'permission', user: selected!, capability, grant: grantsByCapability.get(capability) })"
                  >
                    {{ grantsByCapability.get(capability)?.status === "ACTIVE" ? "撤销" : "授予" }}
                  </button>
                </div>
              </div>
            </section>
          </template>

          <p v-else-if="!busy && !message" class="pu-card pu-empty">暂无平台用户</p>
        </div>
      </div>
    </div>

    <dialog ref="auditDialog" class="pu-dialog" aria-labelledby="pu-audit-title" @cancel.prevent="cancelAudit">
      <form v-if="audit" @submit.prevent="confirmAudit">
        <header class="pu-dialog-head">
          <h3 id="pu-audit-title">{{ auditTitle }}</h3>
          <button type="button" class="pu-dialog-close" aria-label="关闭" :disabled="busy" @click="cancelAudit">×</button>
        </header>
        <div class="pu-dialog-body">
          <p v-if="audit.kind === 'email'" class="pu-email-warning">
            将把 <strong>{{ audit.user.displayName }}</strong> 的邮箱改为 <strong>{{ audit.email }}</strong>，并撤销其所有在线会话。
          </p>
          <p v-else-if="audit.kind === 'permission'" class="pu-permission-target">
            {{ audit.user.displayName }} · <strong>{{ audit.capability }}</strong>
          </p>
          <label class="pu-field">
            审计原因（必填）
            <input
              v-model="reason"
              required
              autofocus
              maxlength="500"
              :disabled="busy"
              :placeholder="audit.kind === 'email' ? '例如：工单 #4021 核验企业邮箱变更' : '请说明本次操作原因'"
            />
          </label>
          <p v-if="auditError" class="pu-dialog-error" role="alert">{{ auditError }}</p>
        </div>
        <footer class="pu-dialog-foot">
          <button type="button" class="pu-button" :disabled="busy" @click="cancelAudit">取消</button>
          <button type="submit" class="pu-button" :class="auditDanger ? 'is-danger' : 'is-primary'" :disabled="busy || !reason.trim()">
            {{ busy ? "正在提交…" : audit.kind === "email" ? "确认保存" : "确认" }}
          </button>
        </footer>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.pu-shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100svh; }
.pu-rail {
  position: sticky; top: 0; height: 100svh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 16px;
  padding: 22px 12px 24px; background: #f9f9fb; border-right: 1px solid var(--line);
}
.pu-rail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 10px; }
.pu-rail-head h1 { margin: 0; font-size: 16px; font-weight: 650; color: var(--ink); }
.pu-pill {
  display: inline-flex; align-items: center; gap: 5px; height: 23px; padding: 0 9px;
  border-radius: 999px; font-size: 11.5px; font-weight: 500; white-space: nowrap; border: 1px solid transparent;
}
.pu-rail-count { background: #efeff2; border-color: #e2e2e7; color: var(--muted); font-variant-numeric: tabular-nums; }
.pu-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pu-pill.is-success { background: #ecf7f0; color: #216b46; border-color: #cbe8d7; }
.pu-pill.is-danger { background: #fdf1f2; color: #a62b33; border-color: #f4d3d6; }
.pu-search, .pu-field input {
  width: 100%; min-width: 0; margin: 0; height: 38px; padding: 0 11px;
  border: 1px solid #d5d5db; border-radius: 8px; background: var(--surface); color: var(--ink); font-size: 13.5px;
}
.pu-search { height: 34px; padding: 0 10px; font-size: 12.5px; }
.pu-search:focus, .pu-field input:focus { outline: 2px solid rgba(80, 104, 183, 0.25); outline-offset: 0; border-color: var(--accent); }

.pu-list { display: grid; gap: 4px; }
.platform-users-page button.pu-user-item {
  display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; min-height: 44px;
  padding: 8px 10px; border: 1px solid transparent; border-radius: 10px; background: transparent; text-align: left;
}
.platform-users-page button.pu-user-item:enabled:hover { background: #efeff4; }
.platform-users-page button.pu-user-item[aria-current] {
  background: var(--surface); border-color: var(--line); box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.pu-user-copy { min-width: 0; flex: 1; display: grid; gap: 2px; }
.pu-user-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.pu-user-name, .pu-user-meta { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pu-user-name { font-size: 13px; font-weight: 600; color: var(--ink); }
.pu-user-meta { font-size: 11.5px; color: var(--muted); }
.pu-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: #26925c; }
.pu-dot.is-danger { background: #c93b44; }
.pu-avatar {
  width: 28px; height: 28px; flex-shrink: 0; border-radius: 50%; display: grid; place-items: center;
  background: #e3e8f8; color: #40558f; font-size: 12px; font-weight: 650;
}
.pu-avatar.is-lg { width: 42px; height: 42px; font-size: 17px; }
.pu-list-hint { margin: 0; padding: 8px 10px; font-size: 12px; color: var(--muted); }
.pu-rail-note {
  margin-top: auto; padding: 12px; border-radius: 10px; background: var(--surface);
  border: 1px solid var(--line); font-size: 12px; color: var(--muted); line-height: 1.5;
}
.pu-rail-note strong { display: block; color: var(--ink); margin-bottom: 3px; }

.pu-detail { min-width: 0; padding: 28px 36px 76px; }
.pu-detail-inner { max-width: 940px; margin: 0 auto; display: grid; gap: 16px; }
.pu-selected-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; }
.pu-selected-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.pu-selected-copy { min-width: 0; overflow-wrap: anywhere; }
.pu-selected-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pu-selected-head h2 { margin: 0; font-size: 22px; font-weight: 650; line-height: 1.3; letter-spacing: -0.02em; }
.pu-selected-meta { margin: 3px 0 0; font-size: 12.5px; color: var(--muted); }

.pu-card {
  min-width: 0; padding: 20px 22px; border: 1px solid var(--line); border-radius: 14px;
  background: var(--surface); box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.pu-card-head { margin-bottom: 14px; }
.pu-card-head h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); }
.pu-card-head p { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
.pu-email-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; margin: 0; }
.pu-field { display: grid; gap: 5px; min-width: 0; font-size: 12.5px; font-weight: 500; color: #3f3f46; }
.pu-email-field { flex: 1 1 240px; }
.pu-cap-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.pu-cap-card {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: #fafafb;
}
.pu-cap-card.is-granted { background: #f5f8ff; border-color: #d3ddf6; }
.pu-cap-info { display: grid; gap: 2px; min-width: 0; }
.pu-cap-info strong { font-size: 13px; font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
.pu-selected-meta, .pu-cap-info strong, .pu-permission-target strong { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.pu-cap-desc { font-size: 12px; color: var(--muted); }
.pu-empty { margin: 0; text-align: center; color: var(--muted); }

.platform-users-page button.pu-button {
  flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  height: 36px; min-height: 36px; padding: 0 14px; border: 1px solid #d5d5db; border-radius: 8px;
  background: var(--surface); color: var(--ink); font-size: 13px; font-weight: 500; white-space: nowrap;
}
.platform-users-page button.pu-button:enabled:hover { background: #fafafb; border-color: #c2c2cb; }
.platform-users-page button.pu-button.is-small { min-height: 30px; height: 30px; padding: 0 11px; border-radius: 7px; font-size: 12px; }
.platform-users-page button.pu-button.is-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.platform-users-page button.pu-button.is-primary:enabled:hover { background: #343439; border-color: #343439; }
.platform-users-page button.pu-button.is-danger-soft { color: #a62b33; border-color: #f4d3d6; }
.platform-users-page button.pu-button.is-danger-soft:enabled:hover { background: #fdf1f2; border-color: #f4d3d6; }
.platform-users-page button.pu-button.is-danger { background: #a62b33; border-color: #a62b33; color: #fff; }
.platform-users-page button.pu-button.is-danger:enabled:hover { background: #8d242b; border-color: #8d242b; }
.pu-alert {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 14px; border: 1px solid #f4d3d6; border-radius: 10px; background: #fdf1f2; color: #a62b33; font-size: 13px;
}

.pu-dialog {
  width: min(465px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0;
  border: 1px solid var(--line); border-radius: 14px; background: var(--surface); color: var(--ink);
  box-shadow: 0 24px 60px rgba(25, 25, 27, 0.18);
}
.pu-dialog::backdrop { background: rgba(25, 25, 27, 0.42); backdrop-filter: blur(2px); }
.pu-dialog form { margin: 0; }
.pu-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 18px 22px 14px; border-bottom: 1px solid var(--line); }
.pu-dialog-head h3 { margin: 0; font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
.platform-users-page .pu-dialog-close { flex: none; width: 30px; min-height: 30px; padding: 0; border: 0; background: transparent; color: var(--muted); font-size: 18px; }
.platform-users-page .pu-dialog-close:enabled:hover { background: #f2f2f5; color: var(--ink); }
.pu-dialog-body { display: grid; gap: 14px; padding: 18px 22px; }
.pu-dialog-body p { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.pu-email-warning { padding: 10px 13px; border: 1px solid #f2dfb3; border-radius: 10px; background: #fff8e6; color: #8a5a10; }
.pu-dialog-error { color: #a62b33; }
.platform-users-page .pu-dialog-foot {
  display: flex; justify-content: flex-end; gap: 10px; margin: 0; padding: 14px 22px 18px;
  border-top: 1px solid var(--line); background: #fafafb;
}

@media (max-width: 1080px) {
  .pu-shell { grid-template-columns: 1fr; min-height: 0; }
  .pu-rail { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 16px 20px; }
  .pu-list { grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 6px; max-height: 260px; overflow-y: auto; }
  .pu-rail-note { display: none; }
  .pu-detail { padding: 20px 20px 68px; }
  .pu-cap-grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .pu-card { padding: 16px; }
  .pu-search, .pu-field input { min-height: 44px; font-size: 16px; }
  .platform-users-page button.pu-button, .platform-users-page button.pu-button.is-small,
  .platform-users-page .pu-dialog-close { min-height: 44px; }
  .platform-users-page .pu-dialog-close { width: 44px; }
}
</style>
