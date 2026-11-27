<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, type Ref } from "vue";
import { AuthError, type AccountClient } from "../lib/account-client.ts";
import { accountErrorMessage } from "../lib/errors.ts";
import type { WriteOptions } from "../lib/idempotent-submit.ts";
import { platformTenantPath as teamPath, type PlatformTenant } from "../lib/platform-tenants.ts";
import PlatformOwnerPicker from "./PlatformOwnerPicker.vue";

const props = defineProps<{
  client: AccountClient;
  hasUserRead: boolean;
  submitWrite: <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;
  refresh: (team: PlatformTenant, created: boolean) => Promise<void>;
}>();
const emit = defineEmits<{ expired: [error: unknown]; committed: [team: PlatformTenant] }>();
const busy = defineModel<boolean>("busy", { required: true });

// Create Team modal state
const createDialog = ref<HTMLDialogElement>();
const createName = ref("");
const createOwner = ref("");
const createOpen = ref(false);
const createReason = ref("");
const createError = ref("");

// Disable / Enable Team modal state
const statusDialog = ref<HTMLDialogElement>();
const statusMode = ref<"disable" | "enable">("disable");
const statusTarget = ref<PlatformTenant>();
const statusReason = ref("");
const statusError = ref("");
const transferDialog = ref<HTMLDialogElement>();
const transferTarget = ref<PlatformTenant>();
const transferOwner = ref("");
const transferReason = ref("");
const transferError = ref("");

let active = true;

async function run(task: () => Promise<void>, errorTarget: Ref<string>) {
  if (busy.value) return;
  busy.value = true;
  errorTarget.value = "";
  try {
    await task();
  } catch (error) {
    if (!active || (error instanceof AuthError && error.code === "CANCELLED")) return;
    errorTarget.value = accountErrorMessage(error);
    emit("expired", error);
  } finally {
    if (active) busy.value = false;
  }
}

// Create Team modal handlers
async function openCreateModal() {
  if (busy.value) return;
  createName.value = "";
  createReason.value = "";
  createError.value = "";
  createOwner.value = "";
  createOpen.value = true;
  await nextTick();
  if (active) createDialog.value?.showModal();
}

function closeCreateModal() {
  createDialog.value?.close();
  createOpen.value = false;
  createError.value = "";
}

function cancelCreateModal() {
  if (!busy.value) closeCreateModal();
}

function submitCreateTeam() {
  const name = createName.value.trim();
  const ownerUserId = createOwner.value.trim();
  const reason = createReason.value.trim();

  if (!name) {
    createError.value = "请输入有效的团队名称";
    return;
  }
  if (!ownerUserId) {
    createError.value = "请选择或输入初始所有者 User ID";
    return;
  }
  if (!reason) {
    createError.value = "平台写操作必须填写非空操作原因";
    return;
  }

  return run(async () => {
    await props.submitWrite<PlatformTenant>(
      "/platform/tenants",
      { name, ownerUserId, reason },
      {
        action: "create-platform-tenant",
        success: `已创建团队「${name}」`,
        refreshMessage: "团队已创建，但团队列表暂未刷新。",
        committed: created => {
          if (!active) return;
          emit("committed", created);
          closeCreateModal();
        },
        after: async created => {
          if (!active) return;
          await props.refresh(created, true);
        },
      },
    );
  }, createError);
}

// Disable / Enable Team modal handlers
async function openStatusModal(mode: "disable" | "enable", team: PlatformTenant) {
  if (busy.value) return;
  statusMode.value = mode;
  statusTarget.value = team;
  statusReason.value = "";
  statusError.value = "";
  await nextTick();
  if (active) statusDialog.value?.showModal();
}

function closeStatusModal() {
  statusDialog.value?.close();
  statusTarget.value = undefined;
  statusError.value = "";
}

function cancelStatusModal() {
  if (!busy.value) closeStatusModal();
}

const statusQuickReasons = computed(() =>
  statusMode.value === "disable"
    ? ["安全风控临时冻结", "客户订阅到期暂停服务", "合规复核中暂挂空间"]
    : ["风控复核通过，恢复使用", "客户续约完成，重新启用"],
);

function submitStatusChange() {
  const target = statusTarget.value;
  const reason = statusReason.value.trim();
  if (!target) return;
  if (!reason) {
    statusError.value = "请填写非空操作原因";
    return;
  }

  const isDisable = statusMode.value === "disable";
  const endpoint = `/platform/tenants/${encodeURIComponent(target.tenantId)}/${isDisable ? "disable" : "enable"}`;

  return run(async () => {
    await props.submitWrite<PlatformTenant>(
      endpoint,
      { expectedVersion: target.version, reason },
      {
        action: `status-platform-tenant-${target.tenantId}`,
        success: isDisable ? `已停用「${target.name}」` : `已恢复启用「${target.name}」`,
        refreshMessage: "团队状态已变更，但列表暂未刷新。",
        committed: updated => {
          if (!active) return;
          emit("committed", updated);
          closeStatusModal();
        },
        after: async updated => {
          if (!active) return;
          await props.refresh(updated, false);
        },
      },
    );
  }, statusError);
}

async function openTransferModal(team: PlatformTenant) {
  if (busy.value) return;
  transferTarget.value = team;
  transferOwner.value = "";
  transferReason.value = "";
  transferError.value = "";
  await nextTick();
  if (active) transferDialog.value?.showModal();
}

function closeTransferModal() {
  transferDialog.value?.close();
  transferTarget.value = undefined;
}

function cancelTransferModal() {
  if (!busy.value) closeTransferModal();
}

function submitTransfer() {
  const target = transferTarget.value;
  const newOwnerUserId = transferOwner.value.trim();
  const reason = transferReason.value.trim();
  if (!target || !newOwnerUserId || !reason) return;
  if (newOwnerUserId === target.ownerUserId) {
    transferError.value = "请选择另一位活跃用户作为新所有者";
    return;
  }
  return run(() => props.submitWrite<PlatformTenant>(
    `${teamPath(target.tenantId)}/transfer-owner`,
    { newOwnerUserId, expectedVersion: target.version, reason },
    {
      action: `transfer-platform-tenant-${target.tenantId}`,
      success: `已移交「${target.name}」的所有权`,
      refreshMessage: "所有权已移交，团队信息暂未刷新。",
      committed: updated => {
        if (!active) return;
        emit("committed", updated);
        closeTransferModal();
      },
      after: async updated => {
        if (active) await props.refresh(updated, false);
      },
    },
  ), transferError);
}

defineExpose({ openCreateModal, openStatusModal, openTransferModal });
onBeforeUnmount(() => {
  active = false;
  createDialog.value?.close();
  statusDialog.value?.close();
  transferDialog.value?.close();
});
</script>

<template>
  <div class="pt-dialogs">
    <!-- Modal 1: Platform Create Team -->
    <dialog ref="createDialog" class="pt-dialog" aria-labelledby="pt-create-title" @cancel.prevent="cancelCreateModal">
      <form @submit.prevent="submitCreateTeam">
        <header class="pt-dialog-head">
          <h3 id="pt-create-title">平台创建团队</h3>
          <button type="button" class="pt-dialog-close" aria-label="关闭" :disabled="busy" @click="cancelCreateModal">
            ×
          </button>
        </header>
        <div class="pt-dialog-body">
          <div class="pt-field">
            <label class="pt-field-label" for="pt-create-name">
              <span>团队名称<span class="pt-req">*</span></span>
              <span class="pt-mono">name</span>
            </label>
            <input
              id="pt-create-name"
              v-model="createName"
              type="text"
              class="pt-input"
              maxlength="64"
              required
              autofocus
              :disabled="busy"
              placeholder="例如：华东企业研发部"
            />
          </div>

          <PlatformOwnerPicker v-if="createOpen" v-model="createOwner" :client="client" label="初始所有者"
            :can-search="hasUserRead" :disabled="busy" @expired="emit('expired', $event)" />

          <div class="pt-field">
            <label class="pt-field-label" for="pt-create-reason">
              <span>操作原因<span class="pt-req">*</span></span>
              <span class="pt-mono">reason</span>
            </label>
            <textarea
              id="pt-create-reason"
              v-model="createReason"
              class="pt-textarea"
              maxlength="500"
              required
              :disabled="busy"
              placeholder="填写审计原因，例如：企业客户签约后由平台代建初始工作空间"
            />
            <div class="pt-quick-chips">
              <button type="button" class="pt-quick-chip" @click="createReason = '企业客户签约，平台代建团队'">
                企业客户签约代建
              </button>
              <button type="button" class="pt-quick-chip" @click="createReason = '受控建团策略下，审批通过代建'">
                受控策略审批建团
              </button>
              <button type="button" class="pt-quick-chip" @click="createReason = '内部新业务线立项初始化'">
                内部业务线立项
              </button>
            </div>
          </div>

          <p v-if="createError" class="pt-dialog-error" role="alert">{{ createError }}</p>
        </div>
        <footer class="pt-dialog-foot">
          <button type="button" class="pt-btn pt-btn-secondary" :disabled="busy" @click="cancelCreateModal">取消</button>
          <button
            type="submit"
            class="pt-btn pt-btn-primary"
            :disabled="busy || !createName.trim() || !createOwner.trim() || !createReason.trim()"
          >
            {{ busy ? "正在提交…" : "确认创建团队" }}
          </button>
        </footer>
      </form>
    </dialog>

    <!-- Modal 2: Disable / Enable Team -->
    <dialog ref="statusDialog" class="pt-dialog" aria-labelledby="pt-status-title" @cancel.prevent="cancelStatusModal">
      <form v-if="statusTarget" @submit.prevent="submitStatusChange">
        <header class="pt-dialog-head">
          <h3 id="pt-status-title">{{ statusMode === "disable" ? "停用团队" : "恢复启用团队" }}</h3>
          <button type="button" class="pt-dialog-close" aria-label="关闭" :disabled="busy" @click="cancelStatusModal">
            ×
          </button>
        </header>
        <div class="pt-dialog-body">
          <div :class="statusMode === 'disable' ? 'pt-callout-warn' : 'pt-callout-info'">
            <template v-if="statusMode === 'disable'">
              <strong>高影响操作：</strong>停用后，该团队所有成员将立即失去团队上下文访问与席位管理权限。可随时通过「恢复启用」解除冻结。
            </template>
            <template v-else>
              <strong>恢复说明：</strong>恢复启用后，团队状态将变为 ACTIVE，原成员角色与历史配置将立即恢复生效。
            </template>
          </div>

          <div class="pt-meta-grid">
            <div class="pt-meta-box">
              <div class="pt-meta-label">目标团队</div>
              <div class="pt-meta-val pt-meta-strong">{{ statusTarget.name }}</div>
            </div>
            <div class="pt-meta-box">
              <div class="pt-meta-label">乐观锁版本 (expectedVersion)</div>
              <div class="pt-meta-val pt-mono pt-kv-ink">v{{ statusTarget.version }} → v{{ statusTarget.version + 1 }}</div>
            </div>
          </div>

          <div class="pt-field">
            <label class="pt-field-label" for="pt-status-reason">
              <span>操作原因<span class="pt-req">*</span></span>
              <span class="pt-mono">reason</span>
            </label>
            <textarea
              id="pt-status-reason"
              v-model="statusReason"
              class="pt-textarea"
              maxlength="500"
              required
              autofocus
              :disabled="busy"
              placeholder="请输入状态变更原因，该操作将写入不可篡改审计日志"
            />
            <div class="pt-quick-chips">
              <button
                v-for="chip in statusQuickReasons"
                :key="chip"
                type="button"
                class="pt-quick-chip"
                @click="statusReason = chip"
              >
                {{ chip }}
              </button>
            </div>
          </div>

          <p v-if="statusError" class="pt-dialog-error" role="alert">{{ statusError }}</p>
        </div>
        <footer class="pt-dialog-foot">
          <button type="button" class="pt-btn pt-btn-secondary" :disabled="busy" @click="cancelStatusModal">取消</button>
          <button
            type="submit"
            class="pt-btn"
            :class="statusMode === 'disable' ? 'pt-btn-danger' : 'pt-btn-primary'"
            :disabled="busy || !statusReason.trim()"
          >
            {{ busy ? "正在提交…" : statusMode === "disable" ? "确认停用团队" : "确认恢复启用" }}
          </button>
        </footer>
      </form>
    </dialog>

    <dialog ref="transferDialog" class="pt-dialog" aria-labelledby="pt-transfer-title" @cancel.prevent="cancelTransferModal">
      <form @submit.prevent="submitTransfer">
        <header class="pt-dialog-head">
          <h3 id="pt-transfer-title">强制移交所有权</h3>
          <button type="button" class="pt-dialog-close" aria-label="关闭" :disabled="busy" @click="cancelTransferModal">×</button>
        </header>
        <div v-if="transferTarget" class="pt-dialog-body">
          <p>「{{ transferTarget.name }}」的原所有者将变为管理员，未完成的所有权交接将取消。</p>
          <PlatformOwnerPicker v-model="transferOwner" :client="client" label="新所有者"
            :can-search="hasUserRead" :exclude="transferTarget.ownerUserId" :disabled="busy"
            @expired="emit('expired', $event)" />
          <div class="pt-field">
            <label class="pt-field-label" for="pt-transfer-reason">操作原因</label>
            <textarea id="pt-transfer-reason" v-model="transferReason" class="pt-textarea" maxlength="500"
              required :disabled="busy" />
          </div>
          <p v-if="transferError" class="pt-dialog-error" role="alert">{{ transferError }}</p>
        </div>
        <footer class="pt-dialog-foot">
          <button type="button" class="pt-btn pt-btn-secondary" :disabled="busy" @click="cancelTransferModal">取消</button>
          <button type="submit" class="pt-btn pt-btn-danger" :disabled="busy || !transferOwner.trim() || !transferReason.trim()">
            {{ busy ? "正在提交…" : "确认移交" }}
          </button>
        </footer>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.pt-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; color: var(--muted); }
.pt-kv-ink { color: var(--ink); }
.pt-dialogs button.pt-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 36px; min-height: 36px; padding: 0 14px; border-radius: 9px;
  font-size: 13px; font-weight: 600; border: 1px solid transparent; white-space: nowrap;
}
.pt-dialogs button.pt-btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
.pt-dialogs button.pt-btn-primary:enabled:hover { background: #343439; border-color: #343439; }
.pt-dialogs button.pt-btn-secondary {
  background: var(--surface); border-color: #d5d5db; color: var(--ink);
  box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.pt-dialogs button.pt-btn-secondary:enabled:hover { background: #fafafb; border-color: #c2c2cb; }
.pt-dialogs button.pt-btn-danger { background: #a62b33; border-color: #a62b33; color: #fff; }
.pt-dialogs button.pt-btn-danger:enabled:hover { background: #8f222a; border-color: #8f222a; }

/* Dialog Modals */
.pt-dialog {
  width: min(490px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0;
  border: 1px solid var(--line); border-radius: 16px; background: var(--surface); color: var(--ink);
  box-shadow: 0 24px 60px rgba(25, 25, 27, 0.18); overflow: auto;
}
.pt-dialog::backdrop { background: rgba(25, 25, 27, 0.38); backdrop-filter: blur(3px); }
.pt-dialog form { margin: 0; }
.pt-dialog-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 18px 22px 14px; border-bottom: 1px solid var(--line);
}
.pt-dialog-head h3 { margin: 0; font-size: 16px; font-weight: 650; color: var(--ink); }
.pt-dialogs button.pt-dialog-close {
  flex: none; width: 30px; height: 30px; min-height: 30px; padding: 0;
  border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-size: 18px;
}
.pt-dialogs button.pt-dialog-close:enabled:hover { background: #f2f2f5; color: var(--ink); }
.pt-dialog-body { padding: 18px 22px; display: flex; flex-direction: column; gap: 15px; }
.pt-dialog-foot {
  padding: 14px 22px; border-top: 1px solid var(--line); background: #fafafb;
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
}
.pt-field { display: flex; flex-direction: column; gap: 6px; }
.pt-field-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; font-weight: 600; color: var(--ink); }
.pt-req { color: #a62b33; margin-left: 2px; }
.pt-dialogs .pt-input,
.pt-dialogs .pt-textarea {
  width: 100%; margin: 0; border-radius: 9px; border: 1px solid #d5d5db;
  background: var(--surface); color: var(--ink); font-size: 13.5px;
}
.pt-dialogs .pt-input { height: 38px; padding: 0 12px; }
.pt-dialogs .pt-textarea { padding: 10px 12px; min-height: 78px; resize: vertical; }
.pt-dialogs .pt-input:focus,
.pt-dialogs .pt-textarea:focus {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(80, 104, 183, 0.14);
}
.pt-quick-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.pt-dialogs button.pt-quick-chip {
  min-height: 24px; padding: 3px 9px; border-radius: 999px;
  border: 1px solid var(--line); background: #fafafb; color: var(--muted); font-size: 11.5px; font-weight: 500;
}
.pt-dialogs button.pt-quick-chip:enabled:hover {
  border-color: var(--accent); color: var(--accent); background: var(--accent-soft);
}
.pt-callout-warn {
  padding: 12px 14px; border-radius: 10px;
  background: #fdf1f2; border: 1px solid #f4d3d6; color: #a62b33; font-size: 12.5px; line-height: 1.55;
}
.pt-callout-info {
  padding: 12px 14px; border-radius: 10px;
  background: #ecf7f0; border: 1px solid #cbe8d7; color: #216b46; font-size: 12.5px; line-height: 1.55;
}
.pt-meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.pt-meta-box { padding: 10px 12px; border-radius: 10px; background: #fafafb; border: 1px solid var(--line); min-width: 0; }
.pt-meta-label { font-size: 11px; color: #8e8e98; margin-bottom: 3px; }
.pt-meta-val { font-size: 12.5px; color: var(--ink); word-break: break-all; }
.pt-meta-strong { font-weight: 600; }
.pt-dialog-error { margin: 0; font-size: 12.5px; color: #a62b33; }

@media (max-width: 720px) {
  .pt-meta-grid { grid-template-columns: 1fr; }
}
</style>
