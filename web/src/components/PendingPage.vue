<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { AuthError, type AccountClient } from "../lib/account-client.ts";
import { cursorCollection } from "../lib/cursor-collection.ts";
import { accountErrorMessage } from "../lib/errors.ts";
import type { WriteOptions } from "../lib/idempotent-submit.ts";

interface Invitation {
  invitationId: string;
  tenantId?: string;
  targetSummary: string;
  status: string;
  expiresAt?: string;
  version: number;
}
interface Transfer {
  transferId: string;
  tenantId: string;
  fromMembershipId: string;
  toMembershipId: string;
  status: string;
  expiresAt?: string;
  version: number;
}
interface Team {
  name: string;
  membershipId: string;
}

const props = defineProps<{
  client: AccountClient;
  busy: boolean;
  mutate: <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;
}>();
const emit = defineEmits<{ expired: [error: unknown]; dispose: []; navigate: [page: string] }>();

type Category = "all" | "invitations" | "transfers";
type Section = "invitations" | "transfers";

const received = cursorCollection<Invitation>(props.client);
const ownership = cursorCollection<Transfer>(props.client);
const invitations = computed(() => received.items.value.filter(item => item.status === "PENDING"));
const transfers = computed(() => ownership.items.value.filter(item => item.status === "PENDING"));
const { loading: invitationsLoading, nextCursor: moreInvitations } = received;
const { nextCursor: moreTransfers } = ownership;
const transfersLoading = ref(false);
const refreshing = ref(false);
const category = ref<Category>("all");
const teams = ref<Record<string, Team | null>>({});
const lastHandled = ref<{ message: string; jumpToTeams: boolean } | null>(null);
const confirmingTransfer = ref<Transfer | null>(null);
const confirmDialog = ref<HTMLDialogElement>();
const lifetime = new AbortController();

const errors = reactive<Partial<Record<Section, { message: string; retry: () => Promise<void> }>>>({});
const hasInvitationsBlock = computed(() => Boolean(invitationsLoading.value || invitations.value.length > 0 || moreInvitations.value || errors.invitations));
const hasTransfersBlock = computed(() => Boolean(transfersLoading.value || transfers.value.length > 0 || moreTransfers.value || errors.transfers));
const showInvitations = computed(() => (category.value === "all" || category.value === "invitations") && hasInvitationsBlock.value);
const showTransfers = computed(() => (category.value === "all" || category.value === "transfers") && hasTransfersBlock.value);

const totalCount = computed(() => invitations.value.length + transfers.value.length);
const needMeCount = computed(() =>
  invitations.value.length + transfers.value.filter(item => transferOperation(item) === "accept").length,
);
const waitingOthersCount = computed(() =>
  transfers.value.filter(item => transferOperation(item) === "cancel").length,
);
const urgentCount = computed(() =>
  invitations.value.filter(item => isExpiringSoon(item.expiresAt)).length +
  transfers.value.filter(item => transferOperation(item) === "accept" && isExpiringSoon(item.expiresAt)).length,
);

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function isExpiringSoon(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt) - Date.now();
  return Number.isFinite(ms) && ms > 0 && ms <= 24 * 3_600_000;
}

function expiryMeta(expiresAt?: string): { remaining: string; formatted: string; urgent: boolean } | null {
  if (!expiresAt) return null;
  const target = Date.parse(expiresAt);
  if (!Number.isFinite(target)) return null;
  const ms = target - Date.now();
  const formatted = dateFormatter.format(new Date(target));
  if (ms <= 0) return { remaining: "即将失效", formatted, urgent: true };
  const hours = Math.ceil(ms / 3_600_000);
  if (hours <= 1) return { remaining: "不足 1 小时过期", formatted, urgent: true };
  if (hours < 24) return { remaining: `剩余 ${hours} 小时过期`, formatted, urgent: true };
  const days = Math.ceil(ms / 86_400_000);
  return { remaining: `剩余 ${days} 天过期`, formatted, urgent: false };
}

const headingCopy = computed(() => {
  if (category.value === "invitations") {
    return { title: "团队邀请", sub: "查看发给你的团队加入邀请，接受后将立即加入对应团队" };
  }
  if (category.value === "transfers") {
    return { title: "所有权交接", sub: "接收他人转交的团队所有权，或撤回你发起且尚未确认的交接" };
  }
  return { title: "全部待处理", sub: "集中处理团队加入邀请与所有权交接请求，及时响应避免过期失效" };
});

const emptyCopy = computed(() => {
  if (category.value === "invitations") {
    return {
      title: "暂无团队邀请",
      desc: "目前没有待确认的团队加入邀请，你也可以前往「团队」主动创建新的团队空间。",
    };
  }
  if (category.value === "transfers") {
    return {
      title: "暂无所有权交接",
      desc: "当前没有待你接收或等待对方确认的团队所有权交接记录。",
    };
  }
  return {
    title: "暂无待处理事项",
    desc: "当前没有待确认的团队邀请或所有权交接。收到新的协作邀请或交接请求时，会在这里集中展示。",
  };
});

async function read(section: Section, task: () => Promise<unknown>, restart = task) {
  if (lifetime.signal.aborted) return;
  delete errors[section];
  try {
    await task();
  } catch (error) {
    if (lifetime.signal.aborted || (error instanceof AuthError && error.code === "CANCELLED")) return;
    emit("expired", error);
    const retry = error instanceof AuthError && error.code === "INVALID_REQUEST" ? restart : task;
    errors[section] = { message: accountErrorMessage(error), retry: () => read(section, retry, restart) };
  }
}

const refreshInvitations = () => received.first("/invitations");
async function loadTeam(id: string) {
  try {
    return await props.client.request<Team>("/tenants/" + encodeURIComponent(id), undefined, "GET", undefined, lifetime.signal);
  } catch (error) {
    if (error instanceof AuthError && (error.status === 404 || error.code === "TENANT_DISABLED")) return null;
    throw error;
  }
}
async function loadTransfers(append = false) {
  if (transfersLoading.value || lifetime.signal.aborted) return;
  transfersLoading.value = true;
  try {
    const loaded = await (append ? ownership.more() : ownership.first("/ownership-transfers"));
    if (!loaded || lifetime.signal.aborted) return;
    const known = append ? teams.value : {};
    const ids = [...new Set(transfers.value.map(transfer => transfer.tenantId))]
      .filter(id => !Object.hasOwn(known, id));
    const details = await Promise.all(ids.map(async id => [id, await loadTeam(id)] as const));
    if (!lifetime.signal.aborted) teams.value = { ...known, ...Object.fromEntries(details) };
  } finally {
    transfersLoading.value = false;
  }
}

async function refreshAll() {
  if (refreshing.value || props.busy) return;
  refreshing.value = true;
  try {
    await Promise.all([
      read("invitations", refreshInvitations),
      read("transfers", () => loadTransfers(false)),
    ]);
  } finally {
    if (!lifetime.signal.aborted) refreshing.value = false;
  }
}

function transferOperation(transfer: Transfer): "accept" | "cancel" | undefined {
  const member = teams.value[transfer.tenantId]?.membershipId;
  if (member === transfer.toMembershipId) return "accept";
  if (member === transfer.fromMembershipId) return "cancel";
}

function transferTitle(transfer: Transfer): string {
  const name = teams.value[transfer.tenantId]?.name;
  return name ? `「${name}」的所有权交接` : "团队所有权交接";
}

function handleTransferClick(transfer: Transfer) {
  const operation = transferOperation(transfer);
  if (operation === "accept") {
    confirmingTransfer.value = transfer;
    confirmDialog.value?.showModal();
  } else if (operation === "cancel") {
    void updateTransfer(transfer);
  }
}

function closeConfirmDialog() {
  if (props.busy) return;
  confirmDialog.value?.close();
  confirmingTransfer.value = null;
}

async function confirmAcceptTransfer() {
  const transfer = confirmingTransfer.value;
  if (!transfer) return;
  confirmDialog.value?.close();
  confirmingTransfer.value = null;
  await updateTransfer(transfer);
}

function updateTransfer(transfer: Transfer) {
  const operation = transferOperation(transfer);
  if (!operation) return;
  const label = teams.value[transfer.tenantId]?.name;
  return props.mutate(
    "/ownership-transfers/" + encodeURIComponent(transfer.transferId) + "/" + operation,
    { expectedVersion: transfer.version },
    {
      committed: () => {
        ownership.remove(item => item.transferId === transfer.transferId);
        lastHandled.value = {
          message: operation === "accept"
            ? (label ? `已接受「${label}」的所有权交接，你现在是该团队所有者。` : "已接受团队所有权交接。")
            : (label ? `已取消「${label}」的所有权交接，团队所有权保持不变。` : "已取消所有权交接。"),
          jumpToTeams: operation === "accept",
        };
      },
      after: () => loadTransfers(),
      success: operation === "accept" ? "已接受所有权交接" : "已取消所有权交接",
      refreshMessage: "交接已更新，但待处理列表暂未刷新。",
    },
  );
}

function updateInvitation(invitation: Invitation, operation: "accept" | "decline") {
  return props.mutate(
    "/invitations/" + encodeURIComponent(invitation.invitationId) + "/" + operation,
    { expectedVersion: invitation.version },
    {
      committed: () => {
        received.remove(item => item.invitationId === invitation.invitationId);
        lastHandled.value = {
          message: operation === "accept" ? "已接受团队邀请，可在「团队」中查看该团队。" : "已拒绝该团队邀请。",
          jumpToTeams: operation === "accept",
        };
      },
      after: async () => { await refreshInvitations(); },
      success: operation === "accept" ? "已接受团队邀请" : "已拒绝团队邀请",
      refreshMessage: "邀请已处理，但待处理列表暂未刷新。",
    },
  );
}

onMounted(() => {
  void read("invitations", refreshInvitations);
  void read("transfers", loadTransfers);
});
onBeforeUnmount(() => {
  lifetime.abort();
  confirmDialog.value?.close();
  received.clear();
  ownership.clear();
  emit("dispose");
});
</script>

<template>
  <section class="console-card pending-page">
    <div class="pending-layout">
      <aside class="pending-rail" aria-label="待处理分类">
        <div class="pending-rail-head">
          <h1>待处理</h1>
          <span class="pending-rail-total">{{ totalCount }}</span>
        </div>

        <nav class="pending-rail-list" aria-label="按类型筛选待处理事项">
          <button
            type="button"
            class="pending-rail-item"
            :class="{ 'is-active': category === 'all' }"
            :aria-current="category === 'all' ? 'page' : undefined"
            @click="category = 'all'"
          >
            <svg class="pending-rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="m12 3 9 5-9 5-9-5 9-5Z" />
              <path d="m3 12 9 5 9-5" />
              <path d="m3 16 9 5 9-5" />
            </svg>
            <span class="pending-rail-body">
              <span class="pending-rail-top">
                <span class="pending-rail-name">全部待处理</span>
                <span class="pending-rail-count" :class="{ 'is-zero': totalCount === 0 }">{{ totalCount }}</span>
              </span>
              <span class="pending-rail-sub">{{ totalCount > 0 ? `${needMeCount} 项需你确认` : "当前已清空" }}</span>
            </span>
          </button>

          <button
            type="button"
            class="pending-rail-item"
            :class="{ 'is-active': category === 'invitations' }"
            :aria-current="category === 'invitations' ? 'page' : undefined"
            @click="category = 'invitations'"
          >
            <svg class="pending-rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="8.5" cy="7" r="3.5" />
              <path d="M19 8v6M16 11h6" />
            </svg>
            <span class="pending-rail-body">
              <span class="pending-rail-top">
                <span class="pending-rail-name">团队邀请</span>
                <span class="pending-rail-count" :class="{ 'is-zero': invitations.length === 0 }">{{ invitations.length }}</span>
              </span>
              <span class="pending-rail-sub">受邀加入团队</span>
            </span>
          </button>

          <button
            type="button"
            class="pending-rail-item"
            :class="{ 'is-active': category === 'transfers' }"
            :aria-current="category === 'transfers' ? 'page' : undefined"
            @click="category = 'transfers'"
          >
            <svg class="pending-rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M17 3l4 4-4 4" />
              <path d="M3 7h18" />
              <path d="M7 21l-4-4 4-4" />
              <path d="M21 17H3" />
            </svg>
            <span class="pending-rail-body">
              <span class="pending-rail-top">
                <span class="pending-rail-name">所有权交接</span>
                <span class="pending-rail-count" :class="{ 'is-zero': transfers.length === 0 }">{{ transfers.length }}</span>
              </span>
              <span class="pending-rail-sub">接收或取消交接</span>
            </span>
          </button>
        </nav>

        <div class="pending-rail-note">
          <strong>时效与权限说明</strong>
          团队邀请与所有权交接均设有过期时间，超时后将自动失效。接受所有权交接前会进行二次确认，确保团队归属变更安全。
        </div>
      </aside>

      <div class="pending-detail">
        <div class="pending-detail-inner">
          <header class="pending-page-head">
            <div>
              <h2>{{ headingCopy.title }}</h2>
              <p>{{ headingCopy.sub }}</p>
            </div>
            <button
              type="button"
              class="pending-btn"
              :disabled="busy || refreshing || invitationsLoading || transfersLoading"
              @click="refreshAll"
            >
              <svg :class="{ 'is-spinning': refreshing }" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              <span>{{ refreshing ? "正在刷新…" : "刷新" }}</span>
            </button>
          </header>

          <div v-if="lastHandled" class="pending-handled-bar" role="status">
            <div class="pending-handled-left">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
              <span>{{ lastHandled.message }}</span>
            </div>
            <div class="pending-handled-actions">
              <button v-if="lastHandled.jumpToTeams" type="button" class="pending-link-btn" @click="emit('navigate', 'tenants')">前往团队查看 →</button>
              <button type="button" class="pending-link-btn is-subtle" @click="lastHandled = null">关闭</button>
            </div>
          </div>

          <div v-if="category === 'all' && totalCount > 0" class="pending-summary-strip">
            <div class="pending-summary-chip">
              <div>
                <div class="pending-summary-label">待你确认</div>
                <div class="pending-summary-val">{{ needMeCount }}<span>项</span></div>
              </div>
              <span class="pending-summary-icon is-accent" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="3.5" /><path d="M19 8v6M16 11h6" /></svg>
              </span>
            </div>
            <div class="pending-summary-chip">
              <div>
                <div class="pending-summary-label">等待对方确认</div>
                <div class="pending-summary-val">{{ waitingOthersCount }}<span>项</span></div>
              </div>
              <span class="pending-summary-icon is-neutral" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              </span>
            </div>
            <div class="pending-summary-chip">
              <div>
                <div class="pending-summary-label">即将过期（24h 内）</div>
                <div class="pending-summary-val">{{ urgentCount }}<span>项</span></div>
              </div>
              <span class="pending-summary-icon is-warn" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
              </span>
            </div>
          </div>

          <section v-if="showInvitations" class="pending-group-card" aria-labelledby="pending-invitations-title" :aria-busy="invitationsLoading">
            <div class="pending-group-head">
              <div class="pending-group-head-left">
                <h3 id="pending-invitations-title">团队邀请</h3>
                <span class="pending-count-badge">{{ invitations.length }}</span>
              </div>
              <span class="pending-group-sub">接受后将自动出现在「团队」目录中</span>
            </div>

            <div v-if="errors.invitations" class="pending-section-error" role="alert">
              <div class="pending-section-error-left">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
                <span>{{ errors.invitations.message }}</span>
              </div>
              <button type="button" class="pending-btn" @click="errors.invitations.retry()">重试</button>
            </div>

            <p v-else-if="invitationsLoading && !invitations.length" class="pending-loading" role="status">正在加载邀请…</p>

            <div v-if="invitations.length" class="pending-list">
              <div
                v-for="invitation in invitations"
                :key="invitation.invitationId"
                class="v2-row pending-item is-info"
                :class="{ 'is-urgent': isExpiringSoon(invitation.expiresAt) }"
              >
                <div class="pending-row-icon is-invite" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="8.5" cy="7" r="3.5" />
                    <path d="M19 8v6M16 11h6" />
                  </svg>
                </div>
                <div class="pending-row-main">
                  <div class="pending-row-title-line">
                    <span class="pending-item-text">团队加入邀请</span>
                    <span class="pending-pill is-accent">团队邀请</span>
                    <span v-if="isExpiringSoon(invitation.expiresAt)" class="pending-pill is-warning"><i class="pending-pill-dot" aria-hidden="true"></i>即将过期</span>
                  </div>
                  <p class="pending-row-desc">收到指向你的团队邀请，接受后你将以成员身份加入该团队。</p>
                  <div class="pending-row-meta">
                    <span class="pending-meta-item">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m3 7 9 6 9-6" /></svg>
                      <span>匹配方式：<code class="pending-meta-code">{{ invitation.targetSummary }}</code></span>
                    </span>
                    <span v-if="expiryMeta(invitation.expiresAt)" class="pending-meta-item" :class="{ 'is-urgent': expiryMeta(invitation.expiresAt)?.urgent }">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                      <span>{{ expiryMeta(invitation.expiresAt)?.remaining }}（{{ expiryMeta(invitation.expiresAt)?.formatted }} 到期）</span>
                    </span>
                  </div>
                </div>
                <div class="pending-item-actions">
                  <button type="button" class="pending-btn" :disabled="busy" @click="updateInvitation(invitation, 'decline')">拒绝</button>
                  <button type="button" class="pending-btn pending-primary" :disabled="busy" @click="updateInvitation(invitation, 'accept')">接受</button>
                </div>
              </div>
            </div>

            <div v-if="moreInvitations && !errors.invitations" class="pending-group-footer">
              <span>还有更多待处理的团队邀请</span>
              <button type="button" class="pending-btn" :disabled="busy || invitationsLoading" @click="read('invitations', received.more, refreshInvitations)">
                {{ invitationsLoading ? "正在加载…" : "加载更多邀请" }}
              </button>
            </div>
          </section>

          <section v-if="showTransfers" class="pending-group-card" aria-labelledby="pending-transfers-title" :aria-busy="transfersLoading">
            <div class="pending-group-head">
              <div class="pending-group-head-left">
                <h3 id="pending-transfers-title">所有权交接</h3>
                <span class="pending-count-badge">{{ transfers.length }}</span>
              </div>
              <span class="pending-group-sub">交接生效前，团队原有所有者权限保持不变</span>
            </div>

            <div v-if="errors.transfers" class="pending-section-error" role="alert">
              <div class="pending-section-error-left">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
                <span>{{ errors.transfers.message }}</span>
              </div>
              <button type="button" class="pending-btn" @click="errors.transfers.retry()">重试</button>
            </div>

            <p v-else-if="transfersLoading && !transfers.length" class="pending-loading" role="status">正在加载所有权交接…</p>

            <div v-if="transfers.length" class="pending-list">
              <div
                v-for="transfer in transfers"
                :key="transfer.transferId"
                class="v2-row pending-item is-warn"
                :class="{ 'is-urgent': transferOperation(transfer) === 'accept' && isExpiringSoon(transfer.expiresAt) }"
              >
                <div class="pending-row-icon" :class="transferOperation(transfer) === 'accept' ? 'is-transfer-in' : 'is-transfer-out'" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path d="M17 3l4 4-4 4" />
                    <path d="M3 7h18" />
                    <path d="M7 21l-4-4 4-4" />
                    <path d="M21 17H3" />
                  </svg>
                </div>
                <div class="pending-row-main">
                  <div class="pending-row-title-line">
                    <span class="pending-item-text">{{ transferTitle(transfer) }}</span>
                    <span v-if="transferOperation(transfer) === 'accept'" class="pending-pill is-warning"><i class="pending-pill-dot" aria-hidden="true"></i>待你接收</span>
                    <span v-else class="pending-pill is-neutral">等待对方确认</span>
                  </div>
                  <p class="pending-row-desc">
                    {{ transferOperation(transfer) === "accept"
                      ? "确认接收后，你将成为该团队的所有者，拥有成员管理、角色调整及团队订阅结算权限。"
                      : "你已发起该团队的所有权交接，在对方确认接收前，你仍为当前所有者并可随时取消。" }}
                  </p>
                  <div v-if="expiryMeta(transfer.expiresAt)" class="pending-row-meta">
                    <span class="pending-meta-item" :class="{ 'is-urgent': transferOperation(transfer) === 'accept' && expiryMeta(transfer.expiresAt)?.urgent }">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                      <span>{{ expiryMeta(transfer.expiresAt)?.remaining }}（{{ expiryMeta(transfer.expiresAt)?.formatted }} 到期）</span>
                    </span>
                  </div>
                </div>
                <div class="pending-item-actions">
                  <button
                    v-if="transferOperation(transfer)"
                    type="button"
                    class="pending-btn"
                    :class="transferOperation(transfer) === 'accept' ? 'pending-primary' : 'pending-danger-soft'"
                    :disabled="busy || transfersLoading"
                    @click="handleTransferClick(transfer)"
                  >
                    {{ transferOperation(transfer) === "accept" ? "接受交接" : "取消交接" }}
                  </button>
                </div>
              </div>
            </div>

            <div v-if="moreTransfers && !errors.transfers" class="pending-group-footer">
              <span>还有更多待处理的所有权交接</span>
              <button type="button" class="pending-btn" :disabled="busy || transfersLoading" @click="read('transfers', () => loadTransfers(true), loadTransfers)">
                {{ transfersLoading ? "正在加载…" : "加载更多交接" }}
              </button>
            </div>
          </section>

          <section v-if="!showInvitations && !showTransfers" class="pending-empty-card">
            <div class="pending-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" /><path d="m9 12 2 2 4-4" /></svg>
            </div>
            <h3 class="pending-empty">{{ emptyCopy.title }}</h3>
            <p>{{ emptyCopy.desc }}</p>
            <div class="pending-empty-actions">
              <button type="button" class="pending-btn" :disabled="busy || refreshing" @click="refreshAll">刷新检查</button>
              <button type="button" class="pending-btn pending-primary" :disabled="busy" @click="emit('navigate', 'tenants')">查看我的团队 →</button>
            </div>
          </section>
        </div>
      </div>
    </div>

    <dialog
      ref="confirmDialog"
      class="pending-dialog"
      aria-labelledby="pending-transfer-dialog-title"
      @cancel.prevent="closeConfirmDialog"
    >
      <div class="pending-dialog-head">
        <h3 id="pending-transfer-dialog-title">确认接受团队所有权？</h3>
        <button type="button" class="pending-dialog-close" aria-label="关闭" :disabled="busy" @click="closeConfirmDialog">×</button>
      </div>
      <div class="pending-dialog-body">
        <p>
          确认接收 <strong>{{ confirmingTransfer ? transferTitle(confirmingTransfer) : "该团队所有权交接" }}</strong> 后，你的团队角色将立即升级为 <strong>所有者</strong>。
        </p>
        <div class="pending-dialog-callout">
          你将承接该团队的成员角色管理、所有权再次交接以及团队订阅与账单结算权限；原所有者将自动转为管理员。
        </div>
      </div>
      <footer class="pending-dialog-foot">
        <button type="button" class="pending-btn" :disabled="busy" @click="closeConfirmDialog">取消</button>
        <button type="button" class="pending-btn pending-primary" :disabled="busy" @click="confirmAcceptTransfer">确认接受交接</button>
      </footer>
    </dialog>
  </section>
</template>

<style scoped>
.pending-page { margin: 0; }
.pending-layout {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  min-height: 100svh;
}

.pending-rail {
  position: sticky; top: 0; height: 100svh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 16px;
  padding: 22px 12px 24px; background: #f9f9fb; border-right: 1px solid var(--line);
}
.pending-rail-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 10px;
}
.pending-rail-head h1 { margin: 0; font-size: 16px; font-weight: 650; color: var(--ink); line-height: 1.4; }
.pending-rail-total {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 24px; height: 22px; padding: 0 8px; border-radius: 999px;
  background: #efeff2; border: 1px solid #e2e2e7; color: var(--muted);
  font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums;
}
.pending-rail-list { display: grid; gap: 4px; }
.pending-page button.pending-rail-item {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 48px;
  padding: 8px 10px; border: 1px solid transparent; border-radius: 10px;
  background: transparent; box-shadow: none; color: var(--ink); text-align: left;
  transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
}
.pending-page button.pending-rail-item:enabled:hover { background: #efeff4; border-color: transparent; }
.pending-page button.pending-rail-item.is-active,
.pending-page button.pending-rail-item.is-active:enabled:hover {
  background: var(--surface); border-color: var(--line); box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.pending-rail-icon { width: 17px; height: 17px; flex-shrink: 0; stroke-width: 1.7; color: var(--muted); }
.pending-rail-item.is-active .pending-rail-icon { color: var(--ink); }
.pending-rail-body { min-width: 0; flex: 1; display: grid; gap: 2px; }
.pending-rail-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.pending-rail-name { font-size: 13px; font-weight: 600; color: var(--ink); }
.pending-rail-sub { font-size: 11.5px; color: var(--muted); }
.pending-rail-count {
  min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
  background: #ececf1; color: var(--muted); font-size: 11px; font-weight: 600;
  display: inline-grid; place-items: center; font-variant-numeric: tabular-nums;
}
.pending-rail-item.is-active .pending-rail-count { background: var(--primary); color: #fff; }
.pending-rail-count.is-zero { background: transparent; color: #8e8e98; font-weight: 500; }
.pending-rail-item.is-active .pending-rail-count.is-zero { background: transparent; color: var(--muted); }

.pending-rail-note {
  margin-top: auto; padding: 12px; border-radius: 10px; background: var(--surface);
  border: 1px solid var(--line); font-size: 12px; color: var(--muted); line-height: 1.55;
}
.pending-rail-note strong { display: block; color: var(--ink); margin-bottom: 4px; font-size: 12px; }

.pending-detail { min-width: 0; padding: 28px 36px 76px; }
.pending-detail-inner { max-width: 900px; margin: 0 auto; display: grid; gap: 18px; }

.pending-page-head {
  display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px 16px;
}
.pending-page-head h2 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.3; color: var(--ink); }
.pending-page-head p { margin: 4px 0 0; font-size: 12.5px; color: var(--muted); }

.pending-page button.pending-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; min-height: 32px; padding: 0 12px; border-radius: 7.5px;
  border: 1px solid #d5d5db; background: var(--surface); color: var(--ink);
  font-size: 12.5px; font-weight: 500; white-space: nowrap;
}
.pending-page button.pending-btn:enabled:hover { background: #fafafb; border-color: #c2c2cb; }
.pending-page button.pending-btn svg { width: 14px; height: 14px; stroke-width: 1.8; }
.pending-page button.pending-btn.pending-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.pending-page button.pending-btn.pending-primary:enabled:hover { background: #343439; border-color: #343439; }
.pending-page button.pending-btn.pending-danger-soft { background: var(--surface); border-color: #f4d3d6; color: #a62b33; }
.pending-page button.pending-btn.pending-danger-soft:enabled:hover { background: #fdf1f2; }
.is-spinning { animation: pending-spin 700ms linear infinite; }
@keyframes pending-spin { to { transform: rotate(360deg); } }

.pending-handled-bar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px;
  padding: 11px 16px; border-radius: 10px; background: #ecf7f0;
  border: 1px solid #cbe8d7; color: #216b46; font-size: 12.5px;
}
.pending-handled-left { display: flex; align-items: center; gap: 8px; }
.pending-handled-left svg { width: 15px; height: 15px; stroke-width: 2; flex-shrink: 0; }
.pending-handled-actions { display: flex; align-items: center; gap: 10px; }
.pending-page button.pending-link-btn {
  min-height: 0; height: auto; padding: 2px 4px; border: 0; background: transparent; box-shadow: none;
  color: #216b46; font-size: 12.5px; font-weight: 600;
  text-decoration: underline; text-underline-offset: 3px;
}
.pending-page button.pending-link-btn.is-subtle { text-decoration: none; opacity: 0.78; font-weight: 500; }

.pending-summary-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.pending-summary-chip {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 16px; border-radius: 12px; background: var(--surface);
  border: 1px solid var(--line); box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.pending-summary-label { font-size: 12px; color: var(--muted); }
.pending-summary-val {
  margin-top: 2px; font-size: 20px; font-weight: 700; letter-spacing: -0.02em;
  color: var(--ink); line-height: 1.2; font-variant-numeric: tabular-nums;
}
.pending-summary-val span { font-size: 12px; font-weight: 500; color: var(--muted); margin-left: 3px; }
.pending-summary-icon {
  width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; flex-shrink: 0;
}
.pending-summary-icon svg { width: 17px; height: 17px; stroke-width: 1.75; }
.pending-summary-icon.is-accent { background: #eef1fa; color: var(--accent); }
.pending-summary-icon.is-warn { background: #fff8e6; color: #8a5a10; }
.pending-summary-icon.is-neutral { background: #f2f2f6; color: #3f3f46; }

.pending-group-card {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 14px; box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04); overflow: hidden;
}
.pending-group-head {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px;
  padding: 15px 20px; border-bottom: 1px solid var(--line);
}
.pending-group-head-left { display: flex; align-items: center; gap: 9px; }
.pending-group-head h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); }
.pending-group-sub { font-size: 12px; color: var(--muted); }
.pending-count-badge {
  min-width: 21px; height: 21px; padding: 0 7px; border-radius: 999px;
  background: #efeff3; color: var(--muted); font-size: 11.5px; font-weight: 600;
  display: inline-grid; place-items: center; font-variant-numeric: tabular-nums;
}

.pending-loading { margin: 0; padding: 20px; font-size: 13px; color: var(--muted); }
.pending-section-error {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
  padding: 16px 20px; background: #fdf1f2; color: #a62b33; font-size: 13px;
}
.pending-section-error-left { display: flex; align-items: center; gap: 10px; }
.pending-section-error-left svg { width: 17px; height: 17px; stroke-width: 1.8; flex-shrink: 0; }

.pending-list { display: grid; }
.pending-item {
  display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center;
  gap: 14px 16px; padding: 18px 20px; border-bottom: 1px solid var(--line);
  background: var(--surface); transition: background-color 140ms ease;
}
.pending-item:last-child { border-bottom: 0; }
.pending-item:hover { background: #fafafc; }
.pending-item.is-urgent { box-shadow: inset 3px 0 0 #d9822b; }

.pending-row-icon {
  width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0;
  display: grid; place-items: center; border: 1px solid transparent;
}
.pending-row-icon svg { width: 18px; height: 18px; stroke-width: 1.75; }
.pending-row-icon.is-invite { background: #eef1fa; border-color: #d5def5; color: var(--accent); }
.pending-row-icon.is-transfer-in { background: #fff8e6; border-color: #f2dfb3; color: #8a5a10; }
.pending-row-icon.is-transfer-out { background: #f3f3f7; border-color: var(--line); color: var(--muted); }

.pending-row-main { min-width: 0; display: grid; gap: 5px; }
.pending-row-title-line { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.pending-item-text { font-size: 14.5px; font-weight: 600; color: var(--ink); line-height: 1.4; overflow-wrap: anywhere; }
.pending-row-desc { margin: 0; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
.pending-row-meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px;
  font-size: 12px; color: #8e8e98;
}
.pending-meta-item { display: inline-flex; align-items: center; gap: 5px; }
.pending-meta-item svg { width: 13px; height: 13px; stroke-width: 1.75; flex-shrink: 0; }
.pending-meta-item.is-urgent { color: #a65214; font-weight: 550; }
.pending-meta-code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11.5px; color: #3f3f46; }

.pending-pill {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px;
  border-radius: 999px; font-size: 11.5px; font-weight: 500; white-space: nowrap;
  border: 1px solid transparent;
}
.pending-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; font-style: normal; }
.pending-pill.is-accent { background: #eef1fa; color: var(--accent); border-color: #d5def5; }
.pending-pill.is-warning { background: #fff8e6; color: #8a5a10; border-color: #f2dfb3; }
.pending-pill.is-neutral { background: #efeff2; color: var(--muted); border-color: #e2e2e7; }

.pending-item-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.pending-group-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 11px 20px; border-top: 1px solid var(--line); background: #fafafb;
  font-size: 12px; color: var(--muted);
}

.pending-empty-card {
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04); padding: 52px 28px; text-align: center;
  display: grid; justify-items: center; gap: 10px;
}
.pending-empty-icon {
  width: 52px; height: 52px; border-radius: 14px;
  background: #ecf7f0; border: 1px solid #cbe8d7; color: #216b46;
  display: grid; place-items: center; margin-bottom: 4px;
}
.pending-empty-icon svg { width: 24px; height: 24px; stroke-width: 1.8; }
.pending-empty-card h3 { margin: 0; font-size: 16px; font-weight: 600; color: var(--ink); }
.pending-empty-card p { margin: 0; max-width: 380px; font-size: 13px; color: var(--muted); line-height: 1.65; }
.pending-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; }

.pending-dialog {
  width: min(460px, calc(100vw - 32px)); padding: 0; border: 1px solid var(--line);
  border-radius: 14px; background: var(--surface); color: var(--ink);
  box-shadow: 0 24px 60px rgba(25, 25, 27, 0.18); overflow: hidden;
}
.pending-dialog::backdrop { background: rgba(25, 25, 27, 0.42); backdrop-filter: blur(2px); }
.pending-dialog-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 22px 14px; border-bottom: 1px solid var(--line);
}
.pending-dialog-head h3 { margin: 0; font-size: 16px; font-weight: 650; }
.pending-page button.pending-dialog-close {
  border: 0; background: transparent; box-shadow: none; color: var(--muted); width: 28px; height: 28px; min-height: 28px;
  border-radius: 7px; font-size: 18px; display: grid; place-items: center; padding: 0;
}
.pending-page button.pending-dialog-close:enabled:hover { background: #f2f2f5; color: var(--ink); }
.pending-dialog-body { padding: 18px 22px; display: grid; gap: 12px; font-size: 13.5px; color: #3f3f46; }
.pending-dialog-body p { margin: 0; }
.pending-dialog-callout {
  padding: 12px 14px; border-radius: 10px; background: #fff8e6;
  border: 1px solid #f2dfb3; color: #8a5a10; font-size: 12.5px; line-height: 1.55;
}
.pending-dialog-foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 14px 22px 18px; border-top: 1px solid var(--line); background: #fafafb;
}

@media (max-width: 1040px) {
  .pending-layout { grid-template-columns: 1fr; min-height: 0; }
  .pending-rail { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 16px 20px; }
  .pending-rail-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .pending-rail-item { width: auto; min-width: 140px; min-height: 42px; }
  .pending-rail-note { display: none; }
  .pending-detail { padding: 20px 20px 64px; }
  .pending-summary-strip { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .pending-detail { padding: 20px 16px 56px; }
  .pending-item { grid-template-columns: 36px minmax(0, 1fr); align-items: start; padding: 16px; }
  .pending-row-icon { width: 36px; height: 36px; }
  .pending-item-actions { grid-column: 1 / -1; justify-content: flex-end; padding-top: 4px; }
  .pending-btn { min-height: 38px; height: 38px; }
}
</style>
