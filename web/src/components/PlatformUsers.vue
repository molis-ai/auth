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
async function load() {
  const data = await list<User>("/platform/users");
  if (active) users.value = data;
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
onMounted(() => void run(load));
</script>
<template>
  <section class="console-card platform-users-page">
    <div class="pu-shell">
      <aside class="pu-rail" aria-label="平台用户目录">
        <div class="pu-rail-head">
          <h1>用户与平台权限</h1>
          <button type="button" class="pu-refresh" :disabled="busy" @click="run(load)">刷新用户</button>
        </div>
        <input v-model="search" type="search" class="pu-search" aria-label="搜索平台用户" placeholder="搜索昵称、邮箱或 ID" />
        <div class="pu-list">
          <div
            v-for="u in filteredUsers"
            :key="u.userId"
            class="v2-row pu-user-item"
            :class="{ 'is-active': selected?.userId === u.userId }"
          >
            <div class="pu-user-head">
              <span class="pu-avatar" aria-hidden="true">{{ u.displayName.slice(0, 1) || "U" }}</span>
              <div class="pu-user-copy">
                <button type="button" class="pu-user-select" :disabled="busy" @click="run(() => select(u))">{{ u.displayName }}</button>
                <span class="pu-user-meta">{{ u.userId }} · {{ u.status }}</span>
              </div>
            </div>
            <button
              v-if="capabilities.includes('USER_STATUS') && props.capabilities.includes('USER_STATUS')"
              type="button"
              class="pu-status-btn"
              :class="u.status === 'ACTIVE' ? 'is-danger' : 'is-primary'"
              :disabled="busy || !reason.trim()"
              @click="run(() => status(u))"
            >
              {{ u.status === "ACTIVE" ? "停用账号" : "恢复账号" }}
            </button>
          </div>
        </div>
      </aside>

      <div class="pu-detail">
        <div class="pu-detail-inner">
          <p v-if="message" class="pu-alert" role="alert">{{ message }}</p>

          <section class="pu-card pu-audit-bar">
            <label class="pu-reason-label">
              <span>操作原因</span>
              <input v-model="reason" maxlength="500" placeholder="停用/恢复账号、维护邮箱或调整权限前请先填写审计原因" />
            </label>
          </section>

          <template v-if="selected">
            <header class="pu-selected-head">
              <span class="pu-avatar is-lg" aria-hidden="true">{{ selected.displayName.slice(0, 1) || "U" }}</span>
              <div>
                <div class="pu-selected-row">
                  <h2>{{ selected.displayName }}</h2>
                  <span class="pu-pill" :class="selected.status === 'ACTIVE' ? 'is-success' : 'is-danger'">{{ selected.status }}</span>
                </div>
                <p class="pu-selected-meta">{{ selected.userId }}{{ selected.email ? ` · ${selected.email}` : "" }}</p>
              </div>
            </header>

            <form v-if="props.capabilities.includes('USER_EMAIL_WRITE')" class="pu-card pu-email-form" @submit.prevent="run(changeEmail)">
              <h2>维护邮箱</h2>
              <p>修改后，该用户在所有产品和设备上的登录都会失效。请先核实邮箱归属。</p>
              <div class="pu-email-controls">
                <label class="pu-email-field">邮箱<input v-model="emailDraft" type="email" required maxlength="254" /></label>
                <button class="pu-primary-btn" :disabled="busy || !reason.trim() || !emailDraft.trim()">保存邮箱并撤销登录</button>
              </div>
            </form>

            <section class="pu-card pu-cap-section">
              <h2 class="pu-cap-title">
                <span>{{ selected.displayName }} 的平台权限</span>
                <span class="pu-cap-count">{{ grants.filter(g => g.status === "ACTIVE").length }} / {{ capabilities.length }} 已授予</span>
              </h2>
              <div
                v-for="capability in capabilities"
                :key="capability"
                class="v2-row pu-cap-card"
                :class="{ 'is-granted': grants.find(g => g.capability === capability)?.status === 'ACTIVE' }"
              >
                <span class="pu-cap-info">
                  <strong>{{ capability }}</strong><i class="pu-cap-sep" aria-hidden="true"> · </i><small>{{ grants.find(g => g.capability === capability)?.status ?? "未授予" }}</small>
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
            <p>从左侧选择一位用户，查看或维护其邮箱与平台权限。</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.platform-users-page { margin: 0; }
.pu-shell { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100svh; }
.pu-rail {
  position: sticky; top: 0; height: 100svh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 12px;
  padding: 22px 12px 24px; background: #f9f9fb; border-right: 1px solid var(--line);
}
.pu-rail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 6px; }
.pu-rail-head h1 { margin: 0; font-size: 16px; font-weight: 650; color: var(--ink); }
.pu-rail .pu-refresh { min-height: 30px; height: 30px; padding: 0 10px; border-radius: 7px; font-size: 12px; }
.pu-search { width: 100%; min-height: 34px; height: 34px; padding: 0 10px; margin: 0; font-size: 12.5px; }
.pu-list { display: grid; gap: 6px; }
.pu-user-item {
  display: grid; gap: 8px; padding: 9px 10px; border: 1px solid transparent;
  border-radius: 10px; background: transparent;
}
.pu-user-item:hover { background: #efeff4; }
.pu-user-item.is-active { background: var(--surface); border-color: var(--line); box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04); }
.pu-user-head { display: flex; align-items: center; gap: 9px; min-width: 0; }
.pu-rail .pu-user-select {
  display: block; width: 100%; min-height: 0; padding: 0; border: 0; background: transparent;
  text-align: left; font-size: 13px; font-weight: 600; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pu-avatar {
  width: 28px; height: 28px; flex-shrink: 0; border-radius: 50%; display: grid; place-items: center;
  background: #e3e8f8; color: #40558f; font-size: 12px; font-weight: 600;
}
.pu-avatar.is-lg { width: 42px; height: 42px; font-size: 16px; }
.pu-user-copy { min-width: 0; flex: 1; display: grid; gap: 1px; }
.pu-user-name { font-size: 13px; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pu-user-meta { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pu-rail .pu-status-btn { min-height: 28px; height: 28px; padding: 0 10px; border-radius: 7px; font-size: 12px; justify-self: start; }

.pu-detail { min-width: 0; padding: 28px 36px 72px; }
.pu-detail-inner { max-width: 900px; margin: 0 auto; display: grid; gap: 16px; }
.pu-alert { margin: 0; padding: 11px 14px; border-radius: 10px; background: #fdf1f2; border: 1px solid #f4d3d6; color: #a32921; font-size: 13px; }
.pu-card { padding: 20px 22px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); box-shadow: 0 1px 2px rgba(25, 25, 27, 0.03); }
.pu-audit-bar { padding: 14px 18px; }
.pu-reason-label { display: grid; gap: 6px; margin: 0; font-size: 12.5px; font-weight: 500; color: var(--ink); }
.pu-reason-label input { margin: 0; height: 38px; min-height: 38px; }

.pu-selected-head { display: flex; align-items: center; gap: 12px; }
.pu-selected-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pu-selected-head h2 { margin: 0; font-size: 22px; font-weight: 650; line-height: 1.3; letter-spacing: -0.02em; }
.pu-selected-meta { margin: 3px 0 0; font-size: 12.5px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.pu-pill { padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 550; }
.pu-pill.is-success { background: #ecf7f0; color: #216b46; }
.pu-pill.is-danger { background: #fdf1f2; color: #a62b33; }

.pu-email-form { max-width: none; margin: 0; }
.pu-email-form h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.pu-email-form p { margin: 0 0 14px; font-size: 12.5px; color: var(--muted); }
.pu-email-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }
.pu-email-field { flex: 1; min-width: 220px; display: grid; gap: 5px; margin: 0; font-size: 12.5px; }
.pu-email-field input { margin: 0; height: 38px; min-height: 38px; }
.pu-primary-btn { height: 38px; min-height: 38px; padding: 0 16px; border-radius: 8px; background: var(--primary); color: #fff; border-color: var(--primary); font-size: 13px; font-weight: 500; }

.pu-cap-section { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.pu-cap-title {
  grid-column: 1 / -1;
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin: 0 0 4px; font-size: 15px; font-weight: 600;
}
.pu-cap-count { font-size: 12px; font-weight: 400; color: var(--muted); }
.pu-cap-card {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: #fafafb;
}
.pu-cap-card.is-granted { background: #f5f8ff; border-color: #d3ddf6; }
.pu-cap-info { display: grid; gap: 2px; min-width: 0; }
.pu-cap-info strong { font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: var(--ink); overflow-wrap: anywhere; }
.pu-cap-sep { display: none; }
.pu-cap-info small { font-size: 11.5px; color: var(--muted); }
.pu-cap-btn { min-height: 30px; height: 30px; padding: 0 11px; border-radius: 7px; font-size: 12px; flex-shrink: 0; }
.is-danger { color: #a62b33; border-color: #f4d3d6; background: var(--surface); }
.is-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.pu-empty { text-align: center; padding: 48px 20px; }
.pu-empty p { margin: 0; font-size: 13.5px; color: var(--muted); }

@media (max-width: 1020px) {
  .pu-shell { grid-template-columns: 1fr; min-height: 0; }
  .pu-rail { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .pu-detail { padding: 20px 16px 56px; }
  .pu-cap-section { grid-template-columns: 1fr; }
}
</style>
