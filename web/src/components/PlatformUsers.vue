<script setup lang="ts">
import { accountErrorMessage } from "../lib/errors.ts";
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { AccountClient } from "../lib/account-client.ts";
declare const __AUTH_PLATFORM_CAPABILITIES__: readonly string[];
const props = defineProps<{ client: AccountClient; capabilities: string[] }>();
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
const emailDraft = ref("");
const search = ref("");
const users = ref<User[]>([]),
  selected = ref<User>(),
  grants = ref<Grant[]>([]),
  reason = ref(""),
  busy = ref(false),
  message = ref("");
const capabilities = __AUTH_PLATFORM_CAPABILITIES__;
const filteredUsers = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return users.value;
  return users.value.filter(
    u => u.displayName.toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q) || u.userId.toLowerCase().includes(q),
  );
});
const grantedCount = computed(() => grants.value.filter(g => g.status === "ACTIVE").length);
let active = true;
onBeforeUnmount(() => {
  active = false;
});
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    await fn();
  } catch (e) {
    if (active) message.value = accountErrorMessage(e);
  } finally {
    if (active) busy.value = false;
  }
}
async function list<T>(path: string) {
  const values: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const p: { items: T[]; nextCursor: string | null } =
      await props.client.request(
        path +
          "?limit=100" +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
    values.push(...p.items);
    cursor = p.nextCursor;
    if (cursor && seen.has(cursor)) throw Error("分页状态已变化");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return values;
}
async function load(autoSelect = false) {
  const data = await list<User>("/platform/users");
  if (!active) return;
  users.value = data;
  if (autoSelect && !selected.value && data[0]) {
    await select(data[0]);
  }
}
async function select(u: User) {
  const data = props.capabilities.includes("PLATFORM_PERMISSION_WRITE")
    ? await list<Grant>("/platform/users/" + u.userId + "/permissions")
    : [];
  if (active) {
    selected.value = u;
    emailDraft.value = u.email ?? "";
    grants.value = data;
  }
}
async function changeEmail() {
  const u = selected.value!;
  await props.client.request(
    "/platform/users/" + u.userId + "/email",
    { email: emailDraft.value.trim(), expectedVersion: u.version, reason: reason.value },
    "PATCH",
    crypto.randomUUID(),
  );
  await load();
  selected.value = undefined;
  emailDraft.value = "";
  reason.value = "";
}
async function status(u: User) {
  if (!reason.value.trim()) throw Error("请填写操作原因");
  await props.client.request(
    "/platform/users/" + u.userId + "/status",
    {
      status: u.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
      expectedVersion: u.version,
      reason: reason.value,
    },
    "PATCH",
    crypto.randomUUID(),
  );
  await load();
  selected.value = undefined;
  reason.value = "";
}
async function permission(capability: string) {
  const u = selected.value!,
    g = grants.value.find(g => g.capability === capability);
  if (!reason.value.trim()) throw Error("请填写操作原因");
  await props.client.request(
    "/platform/users/" + u.userId + "/permissions/" + capability,
    {
      enabled: g?.status !== "ACTIVE",
      expectedVersion: g?.version ?? null,
      reason: reason.value,
    },
    "PATCH",
    crypto.randomUUID(),
  );
  await select(u);
  reason.value = "";
}
onMounted(() => void run(() => load(true)));
</script>
<template>
  <section class="console-card platform-users-page">
    <div class="pu-shell">
      <aside class="pu-rail" aria-label="平台用户目录">
        <div class="pu-rail-head">
          <div class="pu-rail-title">
            <h1>用户与权限</h1>
            <span class="pu-rail-count">{{ users.length }}</span>
          </div>
          <button type="button" class="pu-refresh" :disabled="busy" @click="run(() => load())">刷新</button>
        </div>

        <input v-model="search" type="search" class="pu-search" aria-label="搜索平台用户" placeholder="搜索昵称、邮箱或 ID…" />

        <div class="pu-list">
          <div
            v-for="u in filteredUsers"
            :key="u.userId"
            class="v2-row pu-user-item"
            :class="{ 'is-active': selected?.userId === u.userId }"
            @click="!busy && run(() => select(u))"
          >
            <div class="pu-user-head">
              <span class="pu-avatar" aria-hidden="true">{{ u.displayName.slice(0, 1) || "U" }}</span>
              <div class="pu-user-copy">
                <div class="pu-user-top">
                  <button type="button" class="pu-user-select" :disabled="busy" @click.stop="run(() => select(u))">{{ u.displayName }}</button>
                  <i class="pu-dot" :class="u.status === 'ACTIVE' ? 'is-on' : 'is-danger'" aria-hidden="true"></i>
                </div>
                <span class="pu-user-meta">{{ u.email ? `${u.email} · ` : "" }}{{ u.userId }} · {{ u.status }}</span>
              </div>
            </div>
            <div v-if="capabilities.includes('USER_STATUS') && props.capabilities.includes('USER_STATUS')" class="pu-user-foot">
              <button
                type="button"
                class="pu-status-btn"
                :class="u.status === 'ACTIVE' ? 'is-danger' : 'is-primary'"
                :disabled="busy || !reason.trim()"
                @click.stop="run(() => status(u))"
              >
                {{ u.status === "ACTIVE" ? "停用账号" : "恢复账号" }}
              </button>
            </div>
          </div>
        </div>

        <div class="pu-rail-note">
          <strong>审计要求</strong>
          停用账号、变更邮箱或调整平台权限前，请先在右侧填写审计操作原因，所有变更将写入平台审计日志。
        </div>
      </aside>

      <div class="pu-detail">
        <div class="pu-detail-inner">
          <p v-if="message" class="pu-alert" role="alert">{{ message }}</p>

          <section class="pu-card pu-audit-bar">
            <label class="pu-reason-label">
              <span>操作原因</span>
              <input v-model="reason" maxlength="500" placeholder="例如：工单 #4021 核验企业邮箱变更或权限审批" />
            </label>
            <p class="pu-reason-hint">停用/恢复账号、维护邮箱或调整权限前需填写审计原因。</p>
          </section>

          <template v-if="selected">
            <header class="pu-selected-head">
              <div class="pu-selected-left">
                <span class="pu-avatar is-lg" aria-hidden="true">{{ selected.displayName.slice(0, 1) || "U" }}</span>
                <div>
                  <div class="pu-selected-row">
                    <h2>{{ selected.displayName }}</h2>
                    <span class="pu-pill" :class="selected.status === 'ACTIVE' ? 'is-success' : 'is-danger'">
                      <i class="pu-pill-dot" aria-hidden="true"></i>
                      {{ selected.status === "ACTIVE" ? "正常启用" : "已停用" }}
                    </span>
                  </div>
                  <p class="pu-selected-meta">{{ selected.userId }}{{ selected.email ? ` · ${selected.email}` : "" }}</p>
                </div>
              </div>
              <button
                v-if="capabilities.includes('USER_STATUS') && props.capabilities.includes('USER_STATUS')"
                type="button"
                class="pu-head-action"
                :class="selected.status === 'ACTIVE' ? 'is-danger' : 'is-primary'"
                :disabled="busy || !reason.trim()"
                @click="run(() => status(selected!))"
              >
                {{ selected.status === "ACTIVE" ? "停用账号" : "恢复账号" }}
              </button>
            </header>

            <form v-if="props.capabilities.includes('USER_EMAIL_WRITE')" class="pu-card pu-email-form" @submit.prevent="run(changeEmail)">
              <div class="pu-card-head">
                <div>
                  <h3>维护登录邮箱</h3>
                  <p>修改后，该用户在所有产品与设备上的登录会话都会立即失效，请先核实邮箱归属。</p>
                </div>
              </div>
              <div class="pu-email-controls">
                <label class="pu-email-field">邮箱<input v-model="emailDraft" type="email" required maxlength="254" placeholder="name@company.com" /></label>
                <button class="pu-primary-btn" :disabled="busy || !reason.trim() || !emailDraft.trim()">保存邮箱并撤销登录</button>
              </div>
            </form>

            <section class="pu-card pu-cap-section">
              <h2 class="pu-cap-title">
                <span class="pu-cap-heading">
                  <span>{{ selected.displayName }} 的平台权限</span>
                  <small>已授予 {{ grantedCount }} / {{ capabilities.length }} 项平台能力（与团队内角色相互独立）</small>
                </span>
                <span class="pu-cap-badge">{{ grantedCount }} / {{ capabilities.length }}</span>
              </h2>
              <div
                v-for="capability in capabilities"
                :key="capability"
                class="v2-row pu-cap-card"
                :class="{ 'is-granted': grants.find(g => g.capability === capability)?.status === 'ACTIVE' }"
              >
                <span class="pu-cap-info">
                  <span class="pu-cap-top">
                    <strong>{{ capability }}</strong><i class="pu-cap-sep" aria-hidden="true"> · </i><small class="pu-cap-state" :class="{ 'is-active': grants.find(g => g.capability === capability)?.status === 'ACTIVE' }">{{ grants.find(g => g.capability === capability)?.status ?? "未授予" }}</small>
                  </span>
                  <span v-if="capabilityDescriptions[capability]" class="pu-cap-desc">{{ capabilityDescriptions[capability] }}</span>
                </span>
                <button
                  v-if="props.capabilities.includes('PLATFORM_PERMISSION_WRITE')"
                  type="button"
                  class="pu-cap-btn"
                  :class="grants.find(g => g.capability === capability)?.status === 'ACTIVE' ? 'is-danger' : 'is-primary'"
                  :disabled="busy || !reason.trim()"
                  @click="run(() => permission(capability))"
                >
                  {{ grants.find(g => g.capability === capability)?.status === "ACTIVE" ? "撤销" : "授予" }}
                </button>
              </div>
            </section>
          </template>

          <div v-else class="pu-card pu-empty">
            <p>从左侧选择一位用户，查看或维护其登录邮箱与平台权限矩阵。</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.platform-users-page { margin: 0; }
.pu-shell { display: grid; grid-template-columns: 264px minmax(0, 1fr); min-height: 100svh; }
.pu-rail {
  position: sticky; top: 0; height: 100svh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 12px;
  padding: 22px 12px 24px; background: #f9f9fb; border-right: 1px solid var(--line);
}
.pu-rail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 8px; }
.pu-rail-title { display: flex; align-items: center; gap: 8px; }
.pu-rail-head h1 { margin: 0; font-size: 16px; font-weight: 650; color: var(--ink); line-height: 1.4; }
.pu-rail-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 24px; height: 22px; padding: 0 7px; border-radius: 999px;
  background: #efeff2; border: 1px solid #e2e2e7; color: var(--muted);
  font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums;
}
.platform-users-page button.pu-refresh {
  min-height: 28px; height: 28px; padding: 0 10px; border-radius: 7px;
  border: 1px solid #d5d5db; background: var(--surface); color: var(--ink); font-size: 12px; font-weight: 500;
}
.platform-users-page button.pu-refresh:enabled:hover { background: #fafafb; border-color: #c2c2cb; }
.pu-search {
  width: 100%; min-height: 34px; height: 34px; padding: 0 10px; margin: 0;
  border-radius: 8px; font-size: 12.5px;
}
.pu-list { display: grid; gap: 4px; }
.pu-user-item {
  display: grid; gap: 8px; padding: 9px 10px; border: 1px solid transparent;
  border-radius: 10px; background: transparent; cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
}
.pu-user-item:hover { background: #efeff4; }
.pu-user-item.is-active {
  background: var(--surface); border-color: var(--line);
  box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.pu-user-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.pu-user-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.platform-users-page button.pu-user-select {
  display: block; flex: 1; min-width: 0; min-height: 0; height: auto; padding: 0; margin: 0;
  border: 0; background: transparent; box-shadow: none; text-align: left;
  font-size: 13px; font-weight: 600; color: var(--ink); line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pu-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; font-style: normal; }
.pu-dot.is-on { background: #26925c; }
.pu-dot.is-danger { background: #c93b44; }
.pu-avatar {
  width: 28px; height: 28px; flex-shrink: 0; border-radius: 50%; display: grid; place-items: center;
  background: #e3e8f8; color: #40558f; font-size: 12px; font-weight: 650;
}
.pu-avatar.is-lg { width: 42px; height: 42px; font-size: 17px; }
.pu-user-copy { min-width: 0; flex: 1; display: grid; gap: 2px; }
.pu-user-meta { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pu-user-foot { display: flex; justify-content: flex-end; }
.platform-users-page button.pu-status-btn {
  min-height: 26px; height: 26px; padding: 0 9px; border-radius: 6px; font-size: 11.5px; font-weight: 500;
}
.pu-rail-note {
  margin-top: auto; padding: 12px; border-radius: 10px; background: var(--surface);
  border: 1px solid var(--line); font-size: 12px; color: var(--muted); line-height: 1.55;
}
.pu-rail-note strong { display: block; color: var(--ink); margin-bottom: 3px; font-size: 12px; }

.pu-detail { min-width: 0; padding: 28px 36px 76px; }
.pu-detail-inner { max-width: 940px; margin: 0 auto; display: grid; gap: 16px; }
.pu-alert { margin: 0; padding: 11px 14px; border-radius: 10px; background: #fdf1f2; border: 1px solid #f4d3d6; color: #a32921; font-size: 13px; }
.pu-card {
  padding: 20px 22px; border: 1px solid var(--line); border-radius: 14px;
  background: var(--surface); box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.pu-audit-bar { padding: 14px 18px; display: grid; gap: 6px; }
.pu-reason-label { display: grid; gap: 6px; margin: 0; font-size: 12.5px; font-weight: 600; color: var(--ink); }
.pu-reason-hint { margin: 0; font-size: 12px; color: var(--muted); font-weight: 400; }
.pu-reason-label input { margin: 0; height: 38px; min-height: 38px; font-weight: 400; }

.pu-selected-head {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px;
}
.pu-selected-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.pu-selected-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pu-selected-head h2 { margin: 0; font-size: 22px; font-weight: 650; line-height: 1.3; letter-spacing: -0.02em; }
.pu-selected-meta { margin: 3px 0 0; font-size: 12.5px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; overflow-wrap: anywhere; }
.pu-pill {
  display: inline-flex; align-items: center; gap: 5px; height: 23px; padding: 0 9px;
  border-radius: 999px; font-size: 11.5px; font-weight: 500; border: 1px solid transparent;
}
.pu-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; font-style: normal; }
.pu-pill.is-success { background: #ecf7f0; color: #216b46; border-color: #cbe8d7; }
.pu-pill.is-danger { background: #fdf1f2; color: #a62b33; border-color: #f4d3d6; }
.platform-users-page button.pu-head-action {
  height: 36px; min-height: 36px; padding: 0 14px; border-radius: 8px; font-size: 13px; font-weight: 500;
}

.pu-card-head { margin-bottom: 14px; }
.pu-email-form { max-width: none; margin: 0; }
.pu-email-form h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); }
.pu-email-form p { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
.pu-email-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }
.pu-email-field { flex: 1; min-width: 240px; display: grid; gap: 5px; margin: 0; font-size: 12.5px; font-weight: 500; color: #3f3f46; }
.pu-email-field input { margin: 0; height: 38px; min-height: 38px; }
.platform-users-page button.pu-primary-btn {
  height: 38px; min-height: 38px; padding: 0 16px; border-radius: 8px;
  background: var(--primary); color: #fff; border-color: var(--primary); font-size: 13px; font-weight: 500;
}
.platform-users-page button.pu-primary-btn:enabled:hover { background: #343439; border-color: #343439; }

.pu-cap-section { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.pu-cap-title {
  grid-column: 1 / -1;
  display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 10px;
  margin: 0 0 6px; font-size: 15px; font-weight: 600; color: var(--ink);
}
.pu-cap-heading { display: grid; gap: 2px; }
.pu-cap-heading small { font-size: 12.5px; font-weight: 400; color: var(--muted); }
.pu-cap-badge {
  display: inline-flex; align-items: center; height: 23px; padding: 0 9px; border-radius: 999px;
  background: #efeff2; border: 1px solid #e2e2e7; color: var(--muted);
  font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.pu-cap-card {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 13px 14px; border: 1px solid var(--line); border-radius: 10px; background: #fafafb;
}
.pu-cap-card.is-granted { background: #f5f8ff; border-color: #d3ddf6; }
.pu-cap-info { display: grid; gap: 3px; min-width: 0; }
.pu-cap-top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pu-cap-info strong {
  font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-weight: 600; color: var(--ink); overflow-wrap: anywhere;
}
.pu-cap-sep { display: none; }
.pu-cap-state {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 999px;
  background: #efeff2; color: var(--muted); font-size: 10.5px; font-weight: 500;
}
.pu-cap-state.is-active { background: #ecf7f0; color: #216b46; }
.pu-cap-desc { font-size: 12px; color: var(--muted); line-height: 1.45; }
.platform-users-page button.pu-cap-btn {
  min-height: 30px; height: 30px; padding: 0 11px; border-radius: 7px; font-size: 12px; font-weight: 500; flex-shrink: 0;
}
.platform-users-page button.is-danger { color: #a62b33; border-color: #f4d3d6; background: var(--surface); }
.platform-users-page button.is-danger:enabled:hover { background: #fdf1f2; }
.platform-users-page button.is-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.platform-users-page button.is-primary:enabled:hover { background: #343439; border-color: #343439; }
.pu-empty { text-align: center; padding: 48px 20px; }
.pu-empty p { margin: 0; font-size: 13.5px; color: var(--muted); }

@media (max-width: 1040px) {
  .pu-shell { grid-template-columns: 1fr; min-height: 0; }
  .pu-rail { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .pu-rail-note { display: none; }
  .pu-detail { padding: 20px 16px 56px; }
  .pu-cap-section { grid-template-columns: 1fr; }
}
</style>
