<script setup lang="ts">
import { readPages } from "../../shared/api/read-pages.ts";
import { useAccountContext } from "../../shared/api/account-context.ts";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AuthError } from "../../shared/api/account-client.ts";
import { cursorCollection } from "../../shared/api/cursor-collection.ts";
import { accountErrorMessage } from "../../shared/api/errors.ts";

declare const __AUTH_PLATFORM_CAPABILITIES__: readonly string[];
const { client, submitWrite } = useAccountContext();
const props = defineProps<{
  capabilities: string[];
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
  AUDIT_READ: "查看平台审计日志与安全变更记录",
};
const capabilities = __AUTH_PLATFORM_CAPABILITIES__;
const canSetStatus = computed(() => props.capabilities.includes("USER_STATUS"));
const canEditEmail = computed(() => props.capabilities.includes("USER_EMAIL_WRITE"));
const canManagePermissions = computed(() => props.capabilities.includes("PLATFORM_PERMISSION_WRITE"));
const directory = cursorCollection<User>(client);
const { items: users, loading: usersLoading, nextCursor } = directory;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let selectionVersion = 0;
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


function userPath(user: User) {
  return "/platform/users/" + encodeURIComponent(user.userId);
}

async function select(user: User) {
  const version = ++selectionVersion;
  const data = canManagePermissions.value ? await readPages<Grant>(client, userPath(user) + "/permissions", () => active) : [];
  if (!active || version !== selectionVersion) return;
  selected.value = user;
  emailDraft.value = user.email ?? "";
  grants.value = data;
}

async function load(append = false) {
  message.value = "";
  try {
    if (append) {
      await directory.more();
      return;
    }
    const q = search.value.trim();
    const query = q ? "?" + new URLSearchParams({q}) : "";
    if (!(await directory.first("/platform/users" + query, 30)) || !active) return;
    const current = users.value.find(user => user.userId === selected.value?.userId) ?? users.value[0];
    if (current) {
      await select(current);
    } else {
      selectionVersion++;
      selected.value = undefined;
      grants.value = [];
    }
  } catch (error) {
    if (!active || (error instanceof AuthError && error.code === "CANCELLED")) return;
    message.value = accountErrorMessage(error);
    emit("expired", error);
  }
}
watch(search, () => {
  clearTimeout(searchTimer);
  directory.clear();
  selectionVersion++;
  searchTimer = setTimeout(() => void load(), 200);
});

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
    await submitWrite<Grant>(path + "/permissions/" + encodeURIComponent(action.capability), {
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
  await submitWrite<User>(path + "/" + action.kind, {
    ...change,
    expectedVersion: action.user.version,
    reason: auditReason,
  }, {
    method: "PATCH",
    success: action.kind === "email" ? "邮箱已更新，登录会话已撤销" : action.disabling ? "账号已停用" : "账号已恢复",
    after: async updated => {
      if (!active) return;
      directory.replace(user => user.userId === updated.userId, updated);
      selected.value = updated;
      if (action.kind === "email") emailDraft.value = updated.email ?? "";
      closeAudit();
    },
  });
}

onMounted(() => void load());
onBeforeUnmount(() => {
  active = false;
  clearTimeout(searchTimer);
  directory.clear();
  auditDialog.value?.close();
});
</script>

<template>
  <section class="platform-users-page" data-console-layout="rail">
    <div class="pu-shell">
      <aside class="pu-rail" aria-label="平台用户目录">
        <div class="pu-rail-head">
          <h1>用户与权限</h1>
          <span class="pu-pill pu-rail-count">{{ users.length }}</span>
        </div>

        <input v-model="search" type="search" class="pu-search" aria-label="搜索平台用户" placeholder="搜索昵称或邮箱…" />

        <div class="pu-list">
          <button
            v-for="user in users"
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
          <p v-if="usersLoading && !users.length" class="pu-list-hint" role="status">正在读取用户…</p>
          <p v-else-if="search.trim() && !users.length" class="pu-list-hint">没有匹配的用户</p>
          <button v-if="nextCursor" type="button" :disabled="usersLoading" @click="load(true)">加载更多用户</button>
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

<style scoped src="./platform-users.css"></style>
