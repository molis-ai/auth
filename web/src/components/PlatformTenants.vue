<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AuthError, type AccountClient } from "../lib/account-client.ts";
import { cursorCollection } from "../lib/cursor-collection.ts";
import { accountErrorMessage } from "../lib/errors.ts";
import type { WriteOptions } from "../lib/idempotent-submit.ts";
import {
  auditOperationMeta,
  copyToClipboard,
  formatAuditTimestamp,
  formatRelativeAuditTime,
  platformAuditPath,
  tenantOwner,
  resolveDirectoryUser,
  type AuditEvent,
  type PlatformTenant,
  type PlatformTenantMember,
} from "../lib/platform-audit.ts";
import AuditEventDrawer from "./AuditEventDrawer.vue";
import PlatformOwnerPicker from "./PlatformOwnerPicker.vue";

const props = defineProps<{
  client: AccountClient;
  capabilities: readonly string[];
  submitWrite: <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;
  initialTenantId?: string;
}>();

const emit = defineEmits<{
  expired: [error: unknown];
  notify: [message: string];
  openAudit: [tenantId: string];
}>();

const canCreate = computed(() => props.capabilities.includes("TENANT_CREATE"));
const canSetStatus = computed(() => props.capabilities.includes("TENANT_STATUS"));
const hasUserRead = computed(() => props.capabilities.includes("USER_READ"));
const hasAuditRead = computed(() => props.capabilities.includes("AUDIT_READ"));

const tenantCollection = cursorCollection<PlatformTenant>(props.client);
const tenants = tenantCollection.items;
const nextCursor = tenantCollection.nextCursor;
const loadingMore = computed(() => tenantCollection.loading.value && tenants.value.length > 0);

const memberCollection = cursorCollection<PlatformTenantMember>(props.client);
const members = memberCollection.items;
const membersLoading = memberCollection.loading;
const memberCursor = memberCollection.nextCursor;
const detail = ref<PlatformTenant>();
const detailRequested = ref(Boolean(props.initialTenantId));
const directoryLoading = tenantCollection.loading;
const appliedSearch = ref("");
let searchTimer: ReturnType<typeof setTimeout>;
let detailGeneration = 0;
let scopedGeneration = 0;
let scopeRequest = Promise.resolve();
const auditEvents = ref<AuditEvent[]>([]);
const selectedTenantId = ref(props.initialTenantId ?? "");
const search = ref("");
const statusFilter = ref<"ALL" | "ACTIVE" | "DISABLED">("ALL");
const busy = ref(false);
const message = ref("");
const activeAuditEvent = ref<AuditEvent | null>(null);

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

const usersById = computed(() => new Map(members.value.map(member => [member.userId, member])));
const tenantNamesById = computed(() => {
  const names = new Map(tenants.value.map(team => [team.tenantId, team.name]));
  if (detail.value) names.set(detail.value.tenantId, detail.value.name);
  return names;
});
const hasFilters = computed(() => statusFilter.value !== "ALL" || Boolean(appliedSearch.value));
const selectedTenant = computed(() =>
  tenants.value.find(team => team.tenantId === selectedTenantId.value)
    ?? (detail.value?.tenantId === selectedTenantId.value ? detail.value : undefined)
    ?? (detailRequested.value ? null : tenants.value[0] ?? null),
);
const selectedOwner = computed(() => selectedTenant.value ? tenantOwner(selectedTenant.value) : null);
const relatedAudits = auditEvents;
const latestRelatedAudit = computed(() => relatedAudits.value[0] ?? null);
const roleLabel: Record<PlatformTenantMember["role"], string> = {
  OWNER: "所有者", ADMIN: "管理员", MEMBER: "成员",
};

function teamPath(tenantId: string): string {
  return `/platform/tenants/${encodeURIComponent(tenantId)}`;
}

async function loadDetail(tenantId: string) {
  const generation = ++detailGeneration;
  const team = await props.client.request<PlatformTenant>(teamPath(tenantId));
  if (active && generation === detailGeneration && selectedTenantId.value === tenantId) detail.value = team;
}

watch(() => props.initialTenantId, tenantId => {
  if (!tenantId) return;
  detailRequested.value = true;
  selectedTenantId.value = tenantId;
  detail.value = undefined;
  void loadDetail(tenantId).catch(reportError);
});

async function run(task: () => Promise<void>, errorTarget = message) {
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

function reportError(error: unknown) {
  if (!active || (error instanceof AuthError && error.code === "CANCELLED")) return;
  message.value = accountErrorMessage(error);
  emit("expired", error);
}

async function loadScope(tenantId: string | undefined, keepMembers = false) {
  const generation = ++scopedGeneration;
  if (!keepMembers) {
    auditEvents.value = [];
    memberCollection.clear();
  }
  if (!tenantId) return;
  const requests: Promise<unknown>[] = [memberCollection.first(`${teamPath(tenantId)}/members`)];
  if (hasAuditRead.value) {
    requests.push(props.client.request<{ items: AuditEvent[] }>(platformAuditPath({ tenantId, limit: 10 })).then(page => {
      if (active && generation === scopedGeneration) auditEvents.value = page.items;
    }));
  }
  const outcomes = await Promise.allSettled(requests);
  if (generation === scopedGeneration) {
    for (const outcome of outcomes) if (outcome.status === "rejected") reportError(outcome.reason);
  }
}

async function load(showFeedback = false) {
  const params = new URLSearchParams();
  if (statusFilter.value !== "ALL") params.set("status", statusFilter.value);
  if (appliedSearch.value) params.set("q", appliedSearch.value);
  const path = params.size ? `/platform/tenants?${params}` : "/platform/tenants";
  const loaded = await tenantCollection.first(path, 100);
  if (loaded && showFeedback && active) {
    if (detailRequested.value && selectedTenantId.value && !tenants.value.some(team => team.tenantId === selectedTenantId.value)) {
      await loadDetail(selectedTenantId.value);
    }
    const tenantId = selectedTenant.value?.tenantId;
    await loadScope(tenantId, true);
    emit("notify", "已同步最新平台团队列表");
  }
}

async function refreshTeam(tenantId: string) {
  const previous = selectedTenant.value?.tenantId;
  selectedTenantId.value = tenantId;
  detailRequested.value = true;
  await Promise.all([load(), loadDetail(tenantId)]);
  if (previous === tenantId) await loadScope(tenantId, true);
  else await scopeRequest;
}

function selectTenant(tenantId: string) {
  detailGeneration++;
  detail.value = undefined;
  detailRequested.value = false;
  selectedTenantId.value = tenantId;
}

function resetFilters() {
  search.value = "";
  appliedSearch.value = "";
  statusFilter.value = "ALL";
}

async function copyField(value: string, label: string) {
  const ok = await copyToClipboard(value);
  emit("notify", ok ? `已复制${label}` : `${label}：${value}`);
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
          selectedTenantId.value = created.tenantId;
          closeCreateModal();
        },
        after: async created => {
          if (!active) return;
          await refreshTeam(created.tenantId);
        },
      },
    );
  }, createError);
}

// Disable / Enable Team modal handlers
async function openStatusModal(mode: "disable" | "enable") {
  if (busy.value || !selectedTenant.value) return;
  statusMode.value = mode;
  statusTarget.value = selectedTenant.value;
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
          selectedTenantId.value = updated.tenantId;
          closeStatusModal();
        },
        after: async updated => {
          if (!active) return;
          await refreshTeam(updated.tenantId);
        },
      },
    );
  }, statusError);
}

async function openTransferModal() {
  if (busy.value || !selectedTenant.value) return;
  transferTarget.value = selectedTenant.value;
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
      committed: closeTransferModal,
      after: async updated => {
        if (active) await refreshTeam(updated.tenantId);
      },
    },
  ), transferError);
}

watch(search, value => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { appliedSearch.value = value.trim(); }, 250);
});
watch([appliedSearch, statusFilter], () => {
  message.value = "";
  selectTenant("");
  tenantCollection.clear();
  void load().catch(reportError);
});
watch(() => selectedTenant.value?.tenantId, tenantId => {
  activeAuditEvent.value = null;
  scopeRequest = loadScope(tenantId);
});
onMounted(() => {
  void run(async () => {
    try {
      await Promise.all([load(), selectedTenantId.value ? loadDetail(selectedTenantId.value) : undefined]);
    } catch (error) {
      if (!selectedTenant.value) detailRequested.value = false;
      throw error;
    }
  });
});
onBeforeUnmount(() => {
  active = false;
  scopedGeneration++;
  clearTimeout(searchTimer);
  tenantCollection.clear();
  memberCollection.clear();
  createDialog.value?.close();
  statusDialog.value?.close();
  transferDialog.value?.close();
});
</script>

<template>
  <section class="platform-tenants-page">
    <div class="pt-shell">
      <!-- Left Secondary Rail (268px) -->
      <aside class="pt-rail" aria-label="平台团队目录">
        <div class="pt-rail-head">
          <div class="pt-rail-title-wrap">
            <h1>团队管理</h1>
            <span class="pt-pill-count pt-num">{{ tenants.length }}</span>
          </div>
          <button
            type="button"
            class="pt-icon-ghost"
            :disabled="busy"
            title="刷新列表"
            @click="run(() => load(true))"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            刷新
          </button>
        </div>

        <div class="pt-search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            v-model="search"
            maxlength="128"
            type="search"
            class="pt-search-input"
            aria-label="搜索平台团队"
            placeholder="搜索团队名、ID 或所有者…"
          />
        </div>

        <div class="pt-filter-pills" role="group" aria-label="按团队状态筛选">
          <button
            type="button"
            class="pt-filter-pill"
            :class="{ 'is-active': statusFilter === 'ALL' }"
            @click="statusFilter = 'ALL'"
          >
            全部
          </button>
          <button
            type="button"
            class="pt-filter-pill"
            :class="{ 'is-active': statusFilter === 'ACTIVE' }"
            @click="statusFilter = 'ACTIVE'"
          >
            正常
          </button>
          <button
            type="button"
            class="pt-filter-pill"
            :class="{ 'is-active': statusFilter === 'DISABLED' }"
            @click="statusFilter = 'DISABLED'"
          >
            已停用
          </button>
        </div>

        <button
          v-if="canCreate"
          type="button"
          class="pt-dashed-btn"
          :disabled="busy"
          @click="openCreateModal"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          平台创建团队
        </button>

        <div class="pt-rail-section-label">全平台团队目录</div>

        <div class="pt-rail-list">
          <button
            v-for="tenant in tenants"
            :key="tenant.tenantId"
            type="button"
            class="pt-tenant-item"
            :class="{ 'is-active': selectedTenant?.tenantId === tenant.tenantId }"
            :aria-current="selectedTenant?.tenantId === tenant.tenantId ? 'true' : undefined"
            @click="selectTenant(tenant.tenantId)"
          >
            <span class="pt-team-avatar" :class="{ 'is-disabled': tenant.status !== 'ACTIVE' }" aria-hidden="true">
              {{ tenant.name.slice(0, 1) || "T" }}
            </span>
            <span class="pt-item-body">
              <span class="pt-item-top">
                <span class="pt-item-name pt-truncate">{{ tenant.name }}</span>
                <span
                  class="pt-status-dot"
                  :class="{ 'is-disabled': tenant.status !== 'ACTIVE' }"
                  :title="tenant.status === 'ACTIVE' ? '正常' : '已停用'"
                />
              </span>
              <span class="pt-item-sub">
                <span class="pt-truncate">{{ tenantOwner(tenant).primary }}</span>
                <span>·</span>
                <span class="pt-num">v{{ tenant.version }}</span>
              </span>
            </span>
          </button>

          <p v-if="(busy || directoryLoading) && !tenants.length" class="pt-list-hint" role="status">正在读取团队目录…</p>
          <p v-else-if="!tenants.length" class="pt-list-hint">
            {{ hasFilters ? "未找到匹配的团队" : "当前平台尚未创建任何团队" }}
          </p>

          <button
            v-if="nextCursor"
            type="button"
            class="pt-btn pt-btn-secondary pt-btn-sm pt-load-more"
            :disabled="loadingMore || busy"
            @click="tenantCollection.more().catch(reportError)"
          >
            {{ loadingMore ? "正在加载…" : "加载更多团队" }}
          </button>
        </div>

        <div class="pt-rail-note">
          <strong>审计合规要求</strong>
          平台创建、停用或恢复团队均需填写操作原因（<span class="pt-mono">reason</span>），提交后自动生成审计日志并递增版本号。
        </div>
      </aside>

      <!-- Right Detail Workbench -->
      <div class="pt-workbench">
        <div class="pt-workbench-inner">
          <div v-if="message" class="pt-alert" role="alert">
            <span>{{ message }}</span>
            <button type="button" class="pt-btn pt-btn-secondary pt-btn-sm" :disabled="busy" @click="run(() => load(false))">
              重试
            </button>
          </div>

          <template v-if="selectedTenant && selectedOwner">
            <header class="pt-hero-head">
              <div class="pt-hero-left">
                <span
                  class="pt-team-avatar pt-team-avatar-lg"
                  :class="{ 'is-disabled': selectedTenant.status !== 'ACTIVE' }"
                  aria-hidden="true"
                >
                  {{ selectedTenant.name.slice(0, 1) || "T" }}
                </span>
                <div class="pt-hero-copy">
                  <div class="pt-hero-title-row">
                    <h2>{{ selectedTenant.name }}</h2>
                    <span class="pt-pill" :class="selectedTenant.status === 'ACTIVE' ? 'is-success' : 'is-danger'">
                      <span class="pt-status-dot" :class="{ 'is-disabled': selectedTenant.status !== 'ACTIVE' }" />
                      {{ selectedTenant.status === "ACTIVE" ? "正常启用" : "已停用" }}
                    </span>
                    <span class="pt-pill is-neutral pt-num">v{{ selectedTenant.version }}</span>
                  </div>
                  <div class="pt-hero-sub">
                    <span class="pt-mono">{{ selectedTenant.tenantId }}</span>
                    <span>·</span>
                    <span>所有者：{{ selectedOwner.primary }}</span>
                  </div>
                </div>
              </div>

              <div class="pt-hero-actions">
                <template v-if="canSetStatus">
                  <button
                    v-if="selectedTenant.status === 'ACTIVE'"
                    type="button"
                    class="pt-btn pt-btn-danger-soft"
                    :disabled="busy"
                    @click="openStatusModal('disable')"
                  >
                    停用团队
                  </button>
                  <button
                    v-else
                    type="button"
                    class="pt-btn pt-btn-primary"
                    :disabled="busy"
                    @click="openStatusModal('enable')"
                  >
                    恢复启用团队
                  </button>
                </template>
                <span v-else class="pt-pill is-neutral" title="需要 TENANT_STATUS 权限才能停用或恢复团队">
                  只读模式（无 TENANT_STATUS）
                </span>
              </div>
            </header>

            <div v-if="selectedTenant.status !== 'ACTIVE'" class="pt-disabled-banner">
              <div>
                <strong>该团队当前处于停用状态：</strong>所有成员已无法访问该团队工作空间与席位资源，恢复启用后立即生效。
              </div>
              <button
                v-if="canSetStatus"
                type="button"
                class="pt-btn pt-btn-primary pt-btn-sm"
                :disabled="busy"
                @click="openStatusModal('enable')"
              >
                立即恢复
              </button>
            </div>

            <!-- 3-Column Overview KPI Strip -->
            <div class="pt-kpi-grid">
              <div class="pt-kpi-card">
                <span class="pt-kpi-label">运行状态</span>
                <div class="pt-kpi-value" :class="selectedTenant.status === 'ACTIVE' ? 'is-success' : 'is-danger'">
                  {{ selectedTenant.status === "ACTIVE" ? "正常启用" : "已停用" }}
                </div>
                <span class="pt-kpi-sub">
                  {{ selectedTenant.status === "ACTIVE" ? "成员可正常协作与管理席位" : "团队访问与写操作已冻结" }}
                </span>
              </div>
              <div class="pt-kpi-card">
                <span class="pt-kpi-label">当前所有者</span>
                <div class="pt-kpi-value pt-kpi-value-owner">
                  <span class="pt-truncate">{{ selectedOwner.primary }}</span>
                </div>
                <span class="pt-kpi-sub pt-truncate">{{ selectedOwner.secondary }}</span>
              </div>
              <div class="pt-kpi-card">
                <span class="pt-kpi-label">数据版本与最近审计</span>
                <div class="pt-kpi-value pt-num">Version {{ selectedTenant.version }}</div>
                <span class="pt-kpi-sub">
                  <template v-if="!hasAuditRead">需 AUDIT_READ 权限查看审计动态</template>
                  <template v-else-if="latestRelatedAudit">
                    最近：{{ auditOperationMeta(latestRelatedAudit.operation).label }}（{{ formatRelativeAuditTime(latestRelatedAudit.occurredAt) }}）
                  </template>
                  <template v-else>暂无相关审计记录</template>
                </span>
              </div>
            </div>

            <!-- Card 1: Core Info -->
            <section class="pt-card">
              <header class="pt-card-head">
                <div>
                  <h3>团队基础信息</h3>
                  <p>来自平台只读视图 <span class="pt-mono">GET /api/account/platform/tenants/{{ selectedTenant.tenantId }}</span></p>
                </div>
                <span class="pt-pill is-neutral">受管团队</span>
              </header>
              <div class="pt-kv-list">
                <div class="pt-kv-row">
                  <div class="pt-kv-key">团队 ID (tenantId)</div>
                  <div class="pt-kv-val">
                    <button type="button" class="pt-copy-chip" @click="copyField(selectedTenant.tenantId, '团队 ID')">
                      <span>{{ selectedTenant.tenantId }}</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div class="pt-kv-row">
                  <div class="pt-kv-key">团队名称 (name)</div>
                  <div class="pt-kv-val">
                    <strong class="pt-kv-strong">{{ selectedTenant.name }}</strong>
                    <span class="pt-kv-hint">团队名称由团队所有者在工作台内维护</span>
                  </div>
                </div>
                <div class="pt-kv-row">
                  <div class="pt-kv-key">团队状态 (status)</div>
                  <div class="pt-kv-val">
                    <span class="pt-pill" :class="selectedTenant.status === 'ACTIVE' ? 'is-success' : 'is-danger'">
                      {{ selectedTenant.status }} · {{ selectedTenant.status === "ACTIVE" ? "正常" : "已停用" }}
                    </span>
                  </div>
                </div>
                <div class="pt-kv-row">
                  <div class="pt-kv-key">所有者 (ownerUserId)</div>
                  <div class="pt-kv-val">
                    <div class="pt-kv-val-main">
                      <template v-if="selectedOwner.resolved">
                        <strong class="pt-kv-strong">{{ selectedOwner.primary }}</strong>
                        <span class="pt-kv-sub">{{ selectedOwner.secondary }}</span>
                      </template>
                      <button type="button" class="pt-copy-chip" @click="copyField(selectedTenant.ownerUserId, '所有者 User ID')">
                        <span>{{ selectedTenant.ownerUserId }}</span>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      </button>
                      <button v-if="canSetStatus" type="button" class="pt-btn pt-btn-danger-soft pt-btn-sm"
                        :disabled="busy" @click="openTransferModal">
                        强制移交所有权
                      </button>
                    </div>
                  </div>
                </div>
                <div v-if="selectedTenant.createdAt" class="pt-kv-row">
                  <div class="pt-kv-key">创建时间</div>
                  <div class="pt-kv-val">{{ formatAuditTimestamp(selectedTenant.createdAt) }}</div>
                </div>
                <div v-if="selectedTenant.updatedAt" class="pt-kv-row">
                  <div class="pt-kv-key">更新时间</div>
                  <div class="pt-kv-val">{{ formatAuditTimestamp(selectedTenant.updatedAt) }}</div>
                </div>
                <div class="pt-kv-row">
                  <div class="pt-kv-key">乐观锁版本 (version)</div>
                  <div class="pt-kv-val">
                    <span class="pt-mono pt-kv-ink">v{{ selectedTenant.version }}</span>
                    <span class="pt-kv-hint">状态变更提交 <span class="pt-mono">expectedVersion: {{ selectedTenant.version }}</span> 防并发覆盖</span>
                  </div>
                </div>
              </div>
            </section>

            <section class="pt-card" aria-labelledby="pt-member-heading">
              <header class="pt-card-head">
                <div>
                  <h3 id="pt-member-heading">团队成员<span v-if="selectedTenant.memberCount !== undefined"> · {{ selectedTenant.memberCount }} 人</span></h3>
                  <p>查看当前成员与角色</p>
                </div>
                <span class="pt-pill is-neutral">只读</span>
              </header>
              <div v-if="members.length" class="pt-kv-list">
                <div v-for="member in members" :key="member.membershipId" class="pt-kv-row pt-member-row">
                  <div class="pt-member-identity">
                    <strong class="pt-kv-strong">{{ member.displayName || member.userId }}</strong>
                    <span v-if="member.email" class="pt-kv-sub">{{ member.email }}</span>
                  </div>
                  <div class="pt-kv-val"><span class="pt-pill is-neutral">{{ roleLabel[member.role] }}</span></div>
                </div>
              </div>
              <div v-else class="pt-empty-state is-compact" role="status">
                {{ membersLoading ? "正在加载成员…" : "暂无可显示的成员" }}
              </div>
              <div v-if="memberCursor" class="pt-card-head">
                <button type="button" class="pt-btn pt-btn-secondary pt-btn-sm" :disabled="membersLoading"
                  @click="memberCollection.more().catch(reportError)">加载更多成员</button>
              </div>
            </section>

            <!-- Card 2: Related Audit Events Preview -->
            <section v-if="hasAuditRead" class="pt-card">
              <header class="pt-card-head">
                <div>
                  <div class="pt-card-title-row">
                    <h3>相关审计动态</h3>
                    <span class="pt-pill-count pt-num">{{ relatedAudits.length }}</span>
                  </div>
                  <p>展示关联到该团队的最新管理操作，点击任意条目查看完整变更 Diff</p>
                </div>
                <button
                  type="button"
                  class="pt-btn pt-btn-secondary pt-btn-sm"
                  @click="emit('openAudit', selectedTenant.tenantId)"
                >
                  在审计日志中查看全部 →
                </button>
              </header>

              <div v-if="relatedAudits.length">
                <button
                  v-for="ev in relatedAudits"
                  :key="ev.auditEventId"
                  type="button"
                  class="pt-mini-audit-row"
                  @click="activeAuditEvent = ev"
                >
                  <span class="pt-mini-col">
                    <span class="pt-op-title pt-truncate">{{ auditOperationMeta(ev.operation).label }}</span>
                    <span class="pt-op-code pt-truncate">
                      {{ ev.operation }} · {{ ev.changes?.length ? `${ev.changes.length} 项字段变更` : "无字段变更" }}
                    </span>
                  </span>
                  <span class="pt-mini-col">
                    <span class="pt-actor-name pt-truncate">
                      {{ resolveDirectoryUser(ev.actorUserId, usersById, hasUserRead).primary }}
                    </span>
                    <span class="pt-time-rel pt-num">{{ formatAuditTimestamp(ev.occurredAt) }}</span>
                  </span>
                  <span class="pt-pill" :class="ev.result === 'SUCCEEDED' ? 'is-success' : 'is-danger'">
                    {{ ev.result === "SUCCEEDED" ? "成功" : "已拒绝" }}
                  </span>
                  <span class="pt-mini-link">详情 →</span>
                </button>
              </div>
              <div v-else class="pt-empty-state is-compact">
                <div class="pt-empty-title">暂无该团队的近期审计事件</div>
                <div class="pt-empty-desc">对该团队执行停用或恢复操作后，审计记录会实时出现在这里。</div>
              </div>
            </section>
          </template>

          <section v-else-if="!busy && !directoryLoading && !detailRequested" class="pt-card">
            <div class="pt-empty-state">
              <div class="pt-empty-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <rect x="3" y="4" width="7" height="16" rx="1.5" />
                  <rect x="14" y="8" width="7" height="12" rx="1.5" />
                </svg>
              </div>
              <div class="pt-empty-title">{{ hasFilters ? "没有符合筛选条件的团队" : "平台尚未创建任何团队" }}</div>
              <div class="pt-empty-desc">
                {{ hasFilters
                  ? "请尝试清空搜索关键词或切换状态筛选条件。"
                  : "可在此创建团队并指定初始所有者。" }}
              </div>
              <button
                v-if="!hasFilters && canCreate"
                type="button"
                class="pt-btn pt-btn-primary"
                @click="openCreateModal"
              >
                ＋ 平台创建团队
              </button>
              <button
                v-else-if="hasFilters"
                type="button"
                class="pt-btn pt-btn-secondary"
                @click="resetFilters"
              >
                重置筛选
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>

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

    <!-- Shared Audit Event Detail Drawer -->
    <AuditEventDrawer
      :event="activeAuditEvent"
      :users-by-id="usersById"
      :tenant-names-by-id="tenantNamesById"
      :has-user-read="hasUserRead"
      :can-open-tenant="false"
      @close="activeAuditEvent = null"
      @notify="emit('notify', $event)"
    />
  </section>
</template>

<style scoped>
.pt-shell { display: grid; grid-template-columns: 268px minmax(0, 1fr); min-height: 100svh; }
.pt-num { font-variant-numeric: tabular-nums; }
.pt-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; color: var(--muted); }
.pt-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Left Rail */
.pt-rail {
  position: sticky; top: 0; height: 100svh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 12px;
  padding: 18px 14px 20px; background: #f9f9fb; border-right: 1px solid var(--line);
}
.pt-rail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px; }
.pt-rail-title-wrap { display: flex; align-items: center; gap: 7px; }
.pt-rail-head h1 { margin: 0; font-size: 15px; font-weight: 650; color: var(--ink); letter-spacing: -0.01em; }
.pt-pill-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px; height: 20px; padding: 0 7px; border-radius: 999px;
  background: #ececf0; color: var(--muted); font-size: 11.5px; font-weight: 600;
}
.platform-tenants-page button.pt-icon-ghost {
  display: inline-flex; align-items: center; gap: 4px; min-height: 28px;
  padding: 4px 8px; border-radius: 7px; border: 1px solid transparent;
  background: transparent; color: var(--muted); font-size: 12px; font-weight: 500;
}
.platform-tenants-page button.pt-icon-ghost:enabled:hover { background: #ececf0; color: var(--ink); }

.pt-search-box { position: relative; }
.pt-search-box svg {
  position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
  width: 14px; height: 14px; color: #8e8e98; pointer-events: none;
}
.platform-tenants-page .pt-search-input {
  width: 100%; height: 34px; margin: 0; padding: 0 10px 0 32px;
  border-radius: 9px; border: 1px solid var(--line); background: var(--surface);
  color: var(--ink); font-size: 13px;
}
.platform-tenants-page .pt-search-input:focus {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(80, 104, 183, 0.14);
}

.pt-filter-pills { display: flex; gap: 5px; flex-wrap: wrap; }
.platform-tenants-page button.pt-filter-pill {
  min-height: 26px; padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface);
  color: var(--muted); font-size: 12px; font-weight: 500;
}
.platform-tenants-page button.pt-filter-pill:enabled:hover { border-color: #d5d5db; color: var(--ink); }
.platform-tenants-page button.pt-filter-pill.is-active {
  background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600;
}

.platform-tenants-page button.pt-dashed-btn {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; height: 36px; min-height: 36px; padding: 0 12px; border-radius: 9px;
  border: 1px dashed #d5d5db; background: var(--surface);
  color: var(--ink); font-size: 13px; font-weight: 600;
}
.platform-tenants-page button.pt-dashed-btn:enabled:hover {
  border-color: var(--accent); background: var(--accent-soft); color: #3f55a0;
}

.pt-rail-section-label { font-size: 11px; font-weight: 600; color: #8e8e98; padding: 2px 4px 0; letter-spacing: 0.03em; }
.pt-rail-list { display: flex; flex-direction: column; gap: 5px; }
.platform-tenants-page button.pt-tenant-item {
  display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; min-height: 54px;
  padding: 9px 10px; border-radius: 10px; border: 1px solid transparent; background: transparent; text-align: left;
}
.platform-tenants-page button.pt-tenant-item:enabled:hover { background: rgba(255, 255, 255, 0.72); border-color: var(--line); }
.platform-tenants-page button.pt-tenant-item.is-active {
  background: var(--surface); border-color: #d5d5db; box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.pt-team-avatar {
  width: 34px; height: 34px; border-radius: 9px; flex: none;
  display: grid; place-items: center; font-size: 13.5px; font-weight: 700;
  background: #eae9f9; color: #4b4899;
}
.pt-team-avatar.is-disabled { background: #ececf0; color: var(--muted); }
.pt-team-avatar-lg { width: 44px; height: 44px; border-radius: 12px; font-size: 17px; }
.pt-item-body { min-width: 0; flex: 1; display: grid; gap: 2px; }
.pt-item-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.pt-item-name { font-size: 13.5px; font-weight: 600; color: var(--ink); }
.pt-item-sub { font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 5px; min-width: 0; }
.pt-status-dot { width: 7px; height: 7px; border-radius: 999px; flex: none; background: #1f8a52; }
.pt-status-dot.is-disabled { background: #c93b44; }
.pt-list-hint { margin: 0; padding: 18px 10px; text-align: center; color: #8e8e98; font-size: 12.5px; }
.pt-load-more { width: 100%; margin-top: 4px; }
.pt-rail-note {
  margin-top: auto; padding: 11px 12px; border-radius: 10px;
  background: var(--surface); border: 1px solid var(--line);
  font-size: 12px; color: var(--muted); line-height: 1.5;
}
.pt-rail-note strong { display: block; color: #3f3f46; font-size: 12px; margin-bottom: 3px; }

/* Right Workbench */
.pt-workbench { padding: 28px 34px 56px; min-width: 0; }
.pt-workbench-inner { max-width: 1040px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
.pt-alert {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 14px; border: 1px solid #f4d3d6; border-radius: 10px; background: #fdf1f2; color: #a62b33; font-size: 13px;
}

.pt-hero-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.pt-hero-left { display: flex; align-items: center; gap: 14px; min-width: 0; }
.pt-hero-copy { min-width: 0; }
.pt-hero-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pt-hero-head h2 { margin: 0; font-size: 21px; font-weight: 650; letter-spacing: -0.015em; color: var(--ink); line-height: 1.3; }
.pt-hero-sub { margin-top: 3px; font-size: 13px; color: var(--muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pt-hero-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.pt-disabled-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 12px 16px; border-radius: 12px;
  background: #fdf1f2; border: 1px solid #f4d3d6; color: #a62b33; font-size: 13px;
}

/* Pills */
.pt-pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
  border: 1px solid transparent; white-space: nowrap;
}
.pt-pill.is-success { background: #ecf7f0; color: #216b46; border-color: #cbe8d7; }
.pt-pill.is-danger { background: #fdf1f2; color: #a62b33; border-color: #f4d3d6; }
.pt-pill.is-neutral { background: #efeff2; color: var(--muted); border-color: var(--line); }

/* Buttons */
.platform-tenants-page button.pt-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 36px; min-height: 36px; padding: 0 14px; border-radius: 9px;
  font-size: 13px; font-weight: 600; border: 1px solid transparent; white-space: nowrap;
}
.platform-tenants-page button.pt-btn-sm { height: 30px; min-height: 30px; padding: 0 10px; font-size: 12px; border-radius: 7px; }
.platform-tenants-page button.pt-btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
.platform-tenants-page button.pt-btn-primary:enabled:hover { background: #343439; border-color: #343439; }
.platform-tenants-page button.pt-btn-secondary {
  background: var(--surface); border-color: #d5d5db; color: var(--ink);
  box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.platform-tenants-page button.pt-btn-secondary:enabled:hover { background: #fafafb; border-color: #c2c2cb; }
.platform-tenants-page button.pt-btn-danger-soft { background: #fdf1f2; border-color: #f4d3d6; color: #a62b33; }
.platform-tenants-page button.pt-btn-danger-soft:enabled:hover { background: #fbe3e5; border-color: #ebb7bc; }
.platform-tenants-page button.pt-btn-danger { background: #a62b33; border-color: #a62b33; color: #fff; }
.platform-tenants-page button.pt-btn-danger:enabled:hover { background: #8f222a; border-color: #8f222a; }
.platform-tenants-page button.pt-link-btn {
  border: 0; background: transparent; padding: 0; min-height: 0; color: var(--accent);
  font-size: 12.5px; font-weight: 600;
}
.platform-tenants-page button.pt-link-btn:enabled:hover { color: #3f55a0; text-decoration: underline; }

/* KPI Strip */
.pt-kpi-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.pt-kpi-card {
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  padding: 15px 17px; box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
  display: flex; flex-direction: column; gap: 4px; min-width: 0;
}
.pt-kpi-label { font-size: 12px; color: var(--muted); font-weight: 500; }
.pt-kpi-value { font-size: 19px; font-weight: 650; color: var(--ink); letter-spacing: -0.015em; display: flex; align-items: center; gap: 8px; min-width: 0; }
.pt-kpi-value.is-success { color: #216b46; }
.pt-kpi-value.is-danger { color: #a62b33; }
.pt-kpi-value-owner { font-size: 16px; }
.pt-kpi-sub { font-size: 12px; color: #8e8e98; }

/* Cards & KV Rows */
.pt-card {
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04); overflow: hidden;
}
.pt-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 15px 20px; border-bottom: 1px solid var(--line); flex-wrap: wrap;
}
.pt-card-title-row { display: flex; align-items: center; gap: 8px; }
.pt-card-head h3 { margin: 0; font-size: 14.5px; font-weight: 650; color: var(--ink); }
.pt-card-head p { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }

.pt-kv-list { display: flex; flex-direction: column; }
.pt-kv-row {
  display: grid; grid-template-columns: 185px minmax(0, 1fr); gap: 16px;
  align-items: center; padding: 13px 20px; border-bottom: 1px solid var(--line);
}
.pt-kv-row:last-child { border-bottom: 0; }
.pt-kv-key { font-size: 13px; color: var(--muted); font-weight: 500; }
.pt-kv-val {
  font-size: 13.5px; color: var(--ink); display: flex; align-items: center;
  justify-content: space-between; gap: 10px; flex-wrap: wrap; min-width: 0;
}
.pt-kv-val-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.pt-kv-strong { font-weight: 600; color: var(--ink); }
.pt-kv-sub { font-size: 12.5px; color: var(--muted); }
.pt-kv-row.pt-member-row { grid-template-columns: minmax(0, 1fr) auto; }
.pt-member-identity { display: grid; gap: 2px; overflow-wrap: anywhere; }
.pt-kv-hint { font-size: 12px; color: #8e8e98; }
.pt-kv-ink { color: var(--ink); }

.platform-tenants-page button.pt-copy-chip {
  display: inline-flex; align-items: center; gap: 6px; min-height: 28px;
  padding: 3px 8px; border-radius: 6px; border: 1px solid var(--line); background: #fafafb;
  color: #3f3f46; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px;
}
.platform-tenants-page button.pt-copy-chip:enabled:hover { border-color: #d5d5db; background: #f0f0f4; }
.pt-copy-chip svg { width: 12px; height: 12px; color: #8e8e98; flex: none; }

/* Mini Audit Preview Rows */
.platform-tenants-page button.pt-mini-audit-row {
  display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) auto auto;
  gap: 12px; align-items: center; width: 100%; min-height: 54px;
  padding: 12px 20px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0;
  background: transparent; text-align: left;
}
.platform-tenants-page button.pt-mini-audit-row:enabled:hover { background: #fafafd; }
.platform-tenants-page button.pt-mini-audit-row:last-child { border-bottom: 0; }
.pt-mini-col { display: grid; gap: 2px; min-width: 0; }
.pt-op-title { font-size: 13px; font-weight: 600; color: var(--ink); line-height: 1.3; }
.pt-op-code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11.5px; color: #8e8e98; }
.pt-actor-name { font-size: 13px; font-weight: 500; color: var(--ink); }
.pt-time-rel { font-size: 11.5px; color: #8e8e98; }
.pt-mini-link { color: #8e8e98; font-size: 12px; white-space: nowrap; }

/* Empty States */
.pt-empty-state { padding: 46px 24px; text-align: center; color: var(--muted); }
.pt-empty-state.is-compact { padding: 30px 20px; }
.pt-empty-icon {
  width: 44px; height: 44px; border-radius: 12px; margin: 0 auto 12px;
  display: grid; place-items: center; background: #efeff3; color: var(--muted);
}
.pt-empty-title { font-size: 14.5px; font-weight: 650; color: var(--ink); margin-bottom: 4px; }
.pt-empty-desc { font-size: 13px; color: var(--muted); max-width: 380px; margin: 0 auto 14px; }
.pt-empty-state.is-compact .pt-empty-desc { margin-bottom: 0; }

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
.platform-tenants-page button.pt-dialog-close {
  flex: none; width: 30px; height: 30px; min-height: 30px; padding: 0;
  border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-size: 18px;
}
.platform-tenants-page button.pt-dialog-close:enabled:hover { background: #f2f2f5; color: var(--ink); }
.pt-dialog-body { padding: 18px 22px; display: flex; flex-direction: column; gap: 15px; }
.pt-dialog-foot {
  padding: 14px 22px; border-top: 1px solid var(--line); background: #fafafb;
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
}
.pt-field { display: flex; flex-direction: column; gap: 6px; }
.pt-field-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; font-weight: 600; color: var(--ink); }
.pt-req { color: #a62b33; margin-left: 2px; }
.pt-field-hint { font-size: 12px; color: var(--muted); }
.platform-tenants-page .pt-input,
.platform-tenants-page .pt-select,
.platform-tenants-page .pt-textarea {
  width: 100%; margin: 0; border-radius: 9px; border: 1px solid #d5d5db;
  background: var(--surface); color: var(--ink); font-size: 13.5px;
}
.platform-tenants-page .pt-input,
.platform-tenants-page .pt-select { height: 38px; padding: 0 12px; }
.platform-tenants-page .pt-mono-input { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12.5px; }
.platform-tenants-page .pt-textarea { padding: 10px 12px; min-height: 78px; resize: vertical; }
.platform-tenants-page .pt-input:focus,
.platform-tenants-page .pt-select:focus,
.platform-tenants-page .pt-textarea:focus {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(80, 104, 183, 0.14);
}
.pt-quick-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.platform-tenants-page button.pt-quick-chip {
  min-height: 24px; padding: 3px 9px; border-radius: 999px;
  border: 1px solid var(--line); background: #fafafb; color: var(--muted); font-size: 11.5px; font-weight: 500;
}
.platform-tenants-page button.pt-quick-chip:enabled:hover {
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

@media (max-width: 1080px) {
  .pt-shell { grid-template-columns: 1fr; min-height: 0; }
  .pt-rail { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .pt-rail-note { display: none; }
  .pt-workbench { padding: 20px 20px 56px; }
}
@media (max-width: 720px) {
  .pt-kpi-grid { grid-template-columns: 1fr; }
  .pt-kv-row { grid-template-columns: 1fr; gap: 4px; }
  .platform-tenants-page button.pt-mini-audit-row { grid-template-columns: minmax(0, 1fr) auto; }
  .pt-meta-grid { grid-template-columns: 1fr; }
}
</style>
