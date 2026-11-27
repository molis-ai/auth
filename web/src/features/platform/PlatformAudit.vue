<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AuthError, type AccountClient } from "../../shared/api/account-client.ts";
import { cursorCollection } from "../../shared/api/cursor-collection.ts";
import { accountErrorMessage } from "../../shared/api/errors.ts";
import {
  auditActorLabel,
  auditOperationMeta,
  formatAuditTimestamp,
  formatRelativeAuditTime,
  platformAuditPath,
  targetKindTone,
  type AuditCategory,
  type AuditEvent,
} from "./platform-audit.ts";
import { platformTenantPath, type PlatformTenant } from "./platform-tenants.ts";
import { useDebouncedSearch } from "../../shared/composables/use-debounced-search.ts";
import AuditEventDrawer from "./AuditEventDrawer.vue";

const props = defineProps<{
  client: AccountClient;
  capabilities: readonly string[];
  initialTenantScope?: string | null;
}>();

const emit = defineEmits<{
  expired: [error: unknown];
  notify: [message: string];
  openTenant: [tenantId: string];
}>();

const hasTenantRead = computed(() => props.capabilities.includes("TENANT_READ"));

const auditCollection = cursorCollection<AuditEvent>(props.client);
const allEvents = auditCollection.items;
const nextCursor = auditCollection.nextCursor;
const loadingMore = computed(() => auditCollection.loading.value && allEvents.value.length > 0);

const category = ref<AuditCategory>("all");
const resultFilter = ref<"ALL" | "SUCCEEDED" | "DENIED">("ALL");
const query = ref("");
const tenantScope = ref<string | null>(props.initialTenantScope ?? null);
const selectedEvent = ref<AuditEvent | null>(null);
const busy = auditCollection.loading;
const { applied: appliedQuery, reset: resetSearch } = useDebouncedSearch(query);
const message = ref("");

let active = true;

const scopedNames = ref(new Map<string, string>());
const requestedNames = new Set<string>();
let nameRequest: AbortController | undefined;
const scopedName = computed(() => {
  const id = tenantScope.value;
  return id ? allEvents.value.find(event => event.tenantId === id)?.tenantName ?? scopedNames.value.get(id) ?? id : "";
});

const isFiltered = computed(() => Boolean(
  tenantScope.value || category.value !== "all" || resultFilter.value !== "ALL" || appliedQuery.value,
));
const succeededCount = computed(() => allEvents.value.filter(e => e.result === "SUCCEEDED").length);
const deniedCount = computed(() => allEvents.value.filter(e => e.result === "DENIED").length);

const categories: ReadonlyArray<{ id: AuditCategory; label: string }> = [
  { id: "all", label: "全部事件" },
  { id: "account", label: "账号与权限" },
  { id: "tenant", label: "团队与成员" },
  { id: "app", label: "应用与客户端" },
];

watch(
  () => props.initialTenantScope,
  scope => {
    tenantScope.value = scope ?? null;
    if (scope) {
      category.value = "all";
      resultFilter.value = "ALL";
      resetSearch();
    }
  },
);

async function loadScopedName(id: string) {
  if (!hasTenantRead.value || scopedNames.value.has(id) || requestedNames.has(id)) return;
  requestedNames.add(id);
  const request = new AbortController();
  nameRequest = request;
  try {
    const team = await props.client.request<PlatformTenant>(
      platformTenantPath(id), undefined, "GET", undefined, request.signal,
    );
    if (!request.signal.aborted) scopedNames.value.set(id, team.name);
  } catch (error) {
    if (request.signal.aborted) requestedNames.delete(id);
    else if (active) emit("expired", error);
  } finally {
    if (nameRequest === request) nameRequest = undefined;
  }
}

async function load(showFeedback = false) {
  message.value = "";
  try {
    const scope = tenantScope.value;
    const loaded = await auditCollection.first(platformAuditPath({
      category: category.value,
      result: resultFilter.value,
      tenantId: scope,
      q: appliedQuery.value,
    }), 50);
    if (!loaded || !active) return;
    if (scope && scope === tenantScope.value) {
      const name = allEvents.value.find(event => event.tenantId === scope)?.tenantName;
      if (name) scopedNames.value.set(scope, name);
      else if (!allEvents.value.length) void loadScopedName(scope);
    }
    if (showFeedback) emit("notify", "已刷新平台审计日志");
  } catch (error) {
    if (!active || (error instanceof AuthError && error.code === "CANCELLED")) return;
    message.value = accountErrorMessage(error);
    emit("expired", error);
  }
}

async function loadMore() {
  if (!nextCursor.value) return;
  try {
    const before = allEvents.value.length;
    const loaded = await auditCollection.more();
    if (loaded && active) {
      const added = allEvents.value.length - before;
      emit("notify", `已通过 cursor 游标追加加载 ${added} 条更早日志`);
    }
  } catch (error) {
    if (!active || (error instanceof AuthError && error.code === "CANCELLED")) return;
    message.value = accountErrorMessage(error);
    emit("expired", error);
  }
}

function resetFilters() {
  category.value = "all";
  resultFilter.value = "ALL";
  tenantScope.value = null;
  resetSearch();
}

watch(tenantScope, () => nameRequest?.abort());
watch([category, resultFilter, tenantScope, appliedQuery], () => {
  auditCollection.clear();
  selectedEvent.value = null;
  void load();
});
onMounted(() => void load());
onBeforeUnmount(() => {
  active = false;
  nameRequest?.abort();
  auditCollection.clear();
});
</script>

<template>
  <section class="platform-audit-page">
    <div class="pa-shell">
      <!-- Left Category Rail (244px) -->
      <aside class="pa-rail" aria-label="审计日志分类筛选">
        <div class="pa-rail-head">
          <div class="pa-rail-title-wrap">
            <h1>审计日志</h1>
            <span class="pa-pill-count pa-num">{{ allEvents.length }}</span>
          </div>
        </div>

        <div class="pa-rail-section-label">事件分类</div>
        <div class="pa-rail-list">
          <button
            v-for="cat in categories"
            :key="cat.id"
            type="button"
            class="pa-cat-btn"
            :class="{ 'is-active': category === cat.id }"
            :aria-current="category === cat.id ? 'true' : undefined"
            @click="category = cat.id"
          >
            <span class="pa-cat-left">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true">
                <path v-if="cat.id === 'all'" d="M4 6h16M4 12h16M4 18h10" />
                <path v-else-if="cat.id === 'account'" d="M12 2 4 5v6c0 5.2 3.4 9.7 8 11 4.6-1.3 8-5.8 8-11V5l-8-3Z" />
                <template v-else-if="cat.id === 'tenant'">
                  <rect x="3" y="4" width="7" height="16" rx="1.5" />
                  <rect x="14" y="8" width="7" height="12" rx="1.5" />
                </template>
                <template v-else-if="cat.id === 'app'">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <rect x="3" y="14" width="7" height="7" rx="1.5" />
                  <rect x="14" y="14" width="7" height="7" rx="1.5" />
                </template>
                <template v-else>
                  <rect x="2" y="5" width="20" height="14" rx="2.5" />
                  <path d="M2 10h20" />
                </template>
              </svg>
              <span class="pa-truncate">{{ cat.label }}</span>
            </span>
          </button>
        </div>

        <div class="pa-rail-section-label pa-section-spaced">执行结果</div>
        <div class="pa-filter-pills" role="group" aria-label="按执行结果筛选">
          <button
            type="button"
            class="pa-filter-pill"
            :class="{ 'is-active': resultFilter === 'ALL' }"
            @click="resultFilter = 'ALL'"
          >
            全部
          </button>
          <button
            type="button"
            class="pa-filter-pill"
            :class="{ 'is-active': resultFilter === 'SUCCEEDED' }"
            @click="resultFilter = 'SUCCEEDED'"
          >
            成功
          </button>
          <button
            type="button"
            class="pa-filter-pill"
            :class="{ 'is-active': resultFilter === 'DENIED' }"
            @click="resultFilter = 'DENIED'"
          >
            已拒绝
          </button>
        </div>

        <div class="pa-rail-note">
          <strong>只读合规追踪</strong>
          数据来源于 <span class="pa-mono">GET /api/account/platform/audit-events</span>（需 <span class="pa-mono">AUDIT_READ</span>），记录不可删除或篡改。
        </div>
      </aside>

      <!-- Right Workbench -->
      <div class="pa-workbench">
        <div class="pa-workbench-inner">
          <header class="pa-hero-head">
            <div>
              <h2>平台审计日志</h2>
              <p class="pa-hero-sub">全局管理操作追踪，支持按操作域、结果与关键 ID 检索，点击任意行查看字段级前后对比。</p>
            </div>
            <div class="pa-hero-actions">
              <button type="button" class="pa-btn pa-btn-secondary" :disabled="busy" @click="load(true)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
                刷新日志
              </button>
            </div>
          </header>

          <div v-if="message" class="pa-alert" role="alert">
            <span>{{ message }}</span>
            <button type="button" class="pa-btn pa-btn-secondary pa-btn-sm" :disabled="busy" @click="load(false)">
              重试
            </button>
          </div>

          <div v-if="tenantScope" class="pa-context-banner">
            <div class="pa-context-left">
              <span class="pa-pill is-team">团队上下文筛选</span>
              <span>
                当前仅显示团队 <strong>{{ scopedName }}</strong>（<span class="pa-mono">{{ tenantScope }}</span>）相关事件
              </span>
            </div>
            <div class="pa-context-actions">
              <button
                v-if="hasTenantRead"
                type="button"
                class="pa-btn pa-btn-secondary pa-btn-sm"
                @click="emit('openTenant', tenantScope)"
              >
                返回该团队
              </button>
              <button type="button" class="pa-btn pa-btn-ghost pa-btn-sm" @click="tenantScope = null">
                清除筛选
              </button>
            </div>
          </div>

          <!-- 3 Compact KPI Cards -->
          <div class="pa-kpi-grid">
            <div class="pa-kpi-card">
              <span class="pa-kpi-label">当前匹配事件</span>
              <div class="pa-kpi-value pa-num">
                {{ allEvents.length }}
              </div>
              <span class="pa-kpi-sub">支持游标分页继续加载更早记录</span>
            </div>
            <div class="pa-kpi-card">
              <span class="pa-kpi-label">执行成功（SUCCEEDED）</span>
              <div class="pa-kpi-value is-success pa-num">{{ succeededCount }}</div>
              <span class="pa-kpi-sub">已写入状态变更与前后快照</span>
            </div>
            <div class="pa-kpi-card">
              <span class="pa-kpi-label">被拒绝（DENIED）</span>
              <div class="pa-kpi-value pa-num" :class="{ 'is-danger': deniedCount > 0 }">{{ deniedCount }}</div>
              <span class="pa-kpi-sub">权限不足或风控/前置校验拦截</span>
            </div>
          </div>

          <!-- Audit Table Card -->
          <section class="pa-card">
            <div class="pa-table-toolbar">
              <div class="pa-search-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                  v-model="query"
                  maxlength="128"
                  type="search"
                  class="pa-search-input"
                  aria-label="搜索审计日志"
                  placeholder="搜索操作类型、操作原因或相关 ID…"
                />
              </div>
              <div class="pa-filter-pills">
                <button
                  type="button"
                  class="pa-filter-pill"
                  :class="{ 'is-active': resultFilter === 'ALL' }"
                  @click="resultFilter = 'ALL'"
                >
                  全部结果
                </button>
                <button
                  type="button"
                  class="pa-filter-pill"
                  :class="{ 'is-active': resultFilter === 'SUCCEEDED' }"
                  @click="resultFilter = 'SUCCEEDED'"
                >
                  仅成功
                </button>
                <button
                  type="button"
                  class="pa-filter-pill"
                  :class="{ 'is-active': resultFilter === 'DENIED' }"
                  @click="resultFilter = 'DENIED'"
                >
                  仅拒绝
                </button>
              </div>
            </div>

            <div v-if="busy && !allEvents.length" class="pa-empty-state" role="status">
              <div class="pa-empty-title">正在读取平台审计日志…</div>
            </div>

            <template v-else-if="allEvents.length">
              <div class="pa-table-wrap">
                <table class="pa-table">
                  <thead>
                    <tr>
                      <th>发生时间</th>
                      <th>操作类型</th>
                      <th>操作人</th>
                      <th>目标对象</th>
                      <th>结果</th>
                      <th class="pa-align-right">字段变更</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="ev in allEvents"
                      :key="ev.auditEventId"
                      :class="{ 'is-selected': selectedEvent?.auditEventId === ev.auditEventId }"
                      tabindex="0"
                      @click="selectedEvent = ev"
                      @keydown.enter.prevent="selectedEvent = ev"
                    >
                      <td>
                        <div class="pa-time-main pa-num">{{ formatAuditTimestamp(ev.occurredAt) }}</div>
                        <div class="pa-time-rel">{{ formatRelativeAuditTime(ev.occurredAt) }}</div>
                      </td>
                      <td>
                        <div class="pa-op-title">{{ auditOperationMeta(ev.operation).label }}</div>
                        <div class="pa-op-code">{{ ev.operation }}</div>
                      </td>
                      <td>
                        <div class="pa-actor-name">{{ auditActorLabel(ev) }}</div>
                        <div v-if="ev.actorDisplayName" class="pa-op-code">{{ ev.actorUserId }}</div>
                      </td>
                      <td>
                        <div class="pa-target-cell">
                          <span class="pa-kind-tag" :class="'is-' + targetKindTone(ev.target.kind)">
                            {{ ev.target.kind }}
                          </span>
                          <span class="pa-mono">{{ ev.target.id }}</span>
                        </div>
                        <div v-if="ev.tenantName || (ev.tenantId && ev.tenantId !== ev.target.id)" class="pa-time-rel pa-tenant-hint">
                          所属团队：{{ ev.tenantName ?? ev.tenantId }}
                        </div>
                      </td>
                      <td>
                        <span class="pa-pill" :class="ev.result === 'SUCCEEDED' ? 'is-success' : 'is-danger'">
                          {{ ev.result === "SUCCEEDED" ? "成功" : "已拒绝" }}
                        </span>
                      </td>
                      <td class="pa-align-right pa-nowrap">
                        <span v-if="ev.changes && ev.changes.length" class="pa-pill is-accent pa-num">
                          {{ ev.changes.length }} 项变更
                        </span>
                        <span v-else class="pa-no-diff">无字段差异</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="pa-table-foot">
                <span class="pa-num">已加载 {{ allEvents.length }} 条记录</span>
                <button
                  v-if="nextCursor"
                  type="button"
                  class="pa-btn pa-btn-secondary pa-btn-sm"
                  :disabled="loadingMore || busy"
                  @click="loadMore"
                >
                  {{ loadingMore ? "正在加载…" : "加载更早日志" }}
                </button>
                <span v-else>已加载全部可用日志</span>
              </div>
            </template>

            <div v-else class="pa-empty-state">
              <div class="pa-empty-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                  <path d="M14 2v6h6" />
                </svg>
              </div>
              <div class="pa-empty-title">{{ isFiltered ? "没有匹配的审计事件" : "暂无平台审计记录" }}</div>
              <div class="pa-empty-desc">
                {{ isFiltered
                  ? "请调整左侧分类、结果过滤或搜索关键词。"
                  : "当管理员执行用户权限、团队生命周期、应用或订阅写操作时，日志将自动归档于此。" }}
              </div>
              <button
                v-if="isFiltered"
                type="button"
                class="pa-btn pa-btn-secondary"
                @click="resetFilters"
              >
                重置全部筛选
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>

    <AuditEventDrawer
      :event="selectedEvent"
      :can-open-tenant="hasTenantRead"
      @close="selectedEvent = null"
      @notify="emit('notify', $event)"
      @open-tenant="emit('openTenant', $event)"
    />
  </section>
</template>

<style scoped>
.pa-shell { display: grid; grid-template-columns: 244px minmax(0, 1fr); min-height: 100svh; }
.pa-num { font-variant-numeric: tabular-nums; }
.pa-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; color: var(--muted); }
.pa-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-nowrap { white-space: nowrap; }
.pa-align-right { text-align: right; }

/* Left Category Rail */
.pa-rail {
  position: sticky; top: 0; height: 100svh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 12px;
  padding: 18px 14px 20px; background: #f9f9fb; border-right: 1px solid var(--line);
}
.pa-rail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px; }
.pa-rail-title-wrap { display: flex; align-items: center; gap: 7px; }
.pa-rail-head h1 { margin: 0; font-size: 15px; font-weight: 650; color: var(--ink); letter-spacing: -0.01em; }
.pa-pill-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px; height: 20px; padding: 0 7px; border-radius: 999px;
  background: #ececf0; color: var(--muted); font-size: 11.5px; font-weight: 600;
}
.pa-rail-section-label { font-size: 11px; font-weight: 600; color: #8e8e98; padding: 2px 4px 0; letter-spacing: 0.03em; }
.pa-section-spaced { margin-top: 6px; }
.pa-rail-list { display: flex; flex-direction: column; gap: 4px; }

.platform-audit-page button.pa-cat-btn {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; min-height: 36px; padding: 8px 10px; border-radius: 9px;
  border: 1px solid transparent; background: transparent;
  color: #3f3f46; font-size: 13px; font-weight: 500; text-align: left;
}
.pa-cat-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pa-cat-btn svg { width: 15px; height: 15px; opacity: 0.7; flex: none; }
.platform-audit-page button.pa-cat-btn:enabled:hover { background: rgba(255, 255, 255, 0.72); color: var(--ink); }
.platform-audit-page button.pa-cat-btn.is-active {
  background: var(--surface); border-color: #d5d5db; color: var(--ink);
  font-weight: 600; box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.pa-cat-btn.is-active svg { opacity: 1; color: var(--accent); }

.pa-filter-pills { display: flex; gap: 5px; flex-wrap: wrap; }
.platform-audit-page button.pa-filter-pill {
  min-height: 26px; padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface);
  color: var(--muted); font-size: 12px; font-weight: 500;
}
.platform-audit-page button.pa-filter-pill:enabled:hover { border-color: #d5d5db; color: var(--ink); }
.platform-audit-page button.pa-filter-pill.is-active {
  background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600;
}

.pa-rail-note {
  margin-top: auto; padding: 11px 12px; border-radius: 10px;
  background: var(--surface); border: 1px solid var(--line);
  font-size: 12px; color: var(--muted); line-height: 1.5;
}
.pa-rail-note strong { display: block; color: #3f3f46; font-size: 12px; margin-bottom: 3px; }

/* Right Workbench */
.pa-workbench { padding: 28px 34px 56px; min-width: 0; }
.pa-workbench-inner { max-width: 1040px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
.pa-hero-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.pa-hero-head h2 { margin: 0; font-size: 21px; font-weight: 650; letter-spacing: -0.015em; color: var(--ink); line-height: 1.3; }
.pa-hero-sub { margin: 4px 0 0; font-size: 13px; color: var(--muted); }
.pa-hero-actions { display: flex; align-items: center; gap: 8px; }

.pa-alert {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 14px; border: 1px solid #f4d3d6; border-radius: 10px; background: #fdf1f2; color: #a62b33; font-size: 13px;
}

.pa-context-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 11px 15px; border-radius: 11px;
  background: var(--accent-soft); border: 1px solid #d5def5; color: var(--ink); font-size: 13px;
}
.pa-context-left { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.pa-context-actions { display: flex; align-items: center; gap: 8px; }

/* Buttons & Pills */
.platform-audit-page button.pa-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 36px; min-height: 36px; padding: 0 14px; border-radius: 9px;
  font-size: 13px; font-weight: 600; border: 1px solid transparent; white-space: nowrap;
}
.platform-audit-page button.pa-btn-sm { height: 30px; min-height: 30px; padding: 0 10px; font-size: 12px; border-radius: 7px; }
.platform-audit-page button.pa-btn-secondary {
  background: var(--surface); border-color: #d5d5db; color: var(--ink);
  box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.platform-audit-page button.pa-btn-secondary:enabled:hover { background: #fafafb; border-color: #c2c2cb; }
.platform-audit-page button.pa-btn-ghost { background: transparent; color: var(--muted); }
.platform-audit-page button.pa-btn-ghost:enabled:hover { background: #e3e7f5; color: var(--ink); }

.pa-pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
  border: 1px solid transparent; white-space: nowrap;
}
.pa-pill.is-success { background: #ecf7f0; color: #216b46; border-color: #cbe8d7; }
.pa-pill.is-danger { background: #fdf1f2; color: #a62b33; border-color: #f4d3d6; }
.pa-pill.is-accent { background: var(--accent-soft); color: var(--accent); border-color: #d5def5; }
.pa-pill.is-team { background: #eae9f9; color: #4b4899; }

/* KPI Strip */
.pa-kpi-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.pa-kpi-card {
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  padding: 15px 17px; box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
  display: flex; flex-direction: column; gap: 4px;
}
.pa-kpi-label { font-size: 12px; color: var(--muted); font-weight: 500; }
.pa-kpi-value { font-size: 19px; font-weight: 650; color: var(--ink); letter-spacing: -0.015em; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.pa-kpi-value.is-success { color: #216b46; }
.pa-kpi-value.is-danger { color: #a62b33; }
.pa-kpi-sub { font-size: 12px; color: #8e8e98; }

/* Unified Audit Table Card */
.pa-card {
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04); overflow: hidden;
}
.pa-table-toolbar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 20px; border-bottom: 1px solid var(--line); flex-wrap: wrap;
}
.pa-search-box { position: relative; flex: 1; min-width: 220px; max-width: 440px; }
.pa-search-box svg {
  position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
  width: 14px; height: 14px; color: #8e8e98; pointer-events: none;
}
.platform-audit-page .pa-search-input {
  width: 100%; height: 34px; margin: 0; padding: 0 10px 0 32px;
  border-radius: 9px; border: 1px solid var(--line); background: var(--surface);
  color: var(--ink); font-size: 13px;
}
.platform-audit-page .pa-search-input:focus {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(80, 104, 183, 0.14);
}

.pa-table-wrap { overflow-x: auto; }
.pa-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.pa-table th {
  text-align: left; font-size: 11.5px; font-weight: 600; color: var(--muted);
  padding: 10px 16px; background: #fafafb; border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.pa-table td {
  padding: 12px 16px; border-bottom: 1px solid var(--line); vertical-align: middle;
}
.pa-table tbody tr { cursor: pointer; transition: background-color 120ms ease; }
.pa-table tbody tr:hover { background: #fafafd; }
.pa-table tbody tr.is-selected { background: var(--accent-soft); }
.pa-table tbody tr:last-child td { border-bottom: 0; }

.pa-time-main { font-size: 12.5px; color: var(--ink); white-space: nowrap; }
.pa-time-rel { font-size: 11px; color: #8e8e98; }
.pa-tenant-hint { margin-top: 2px; }
.pa-op-title { font-weight: 600; color: var(--ink); line-height: 1.3; }
.pa-op-code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11.5px; color: #8e8e98; margin-top: 1px; }
.pa-actor-name { font-weight: 500; color: var(--ink); line-height: 1.3; }
.pa-target-cell { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pa-no-diff { color: #8e8e98; font-size: 12px; }

.pa-kind-tag {
  font-size: 10.5px; font-weight: 650; padding: 1px 6px; border-radius: 5px;
  background: #efeff3; color: #3f3f46; letter-spacing: 0.02em;
}
.pa-kind-tag.is-tenant { background: #eae9f9; color: #4b4899; }
.pa-kind-tag.is-app { background: #e6f4ee; color: #216b46; }
.pa-kind-tag.is-user { background: #eef1fa; color: #5068b7; }
.pa-kind-tag.is-billing { background: #fff8e6; color: #8a5a10; }

.pa-table-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 12px 20px; border-top: 1px solid var(--line);
  background: #fafafb; font-size: 12.5px; color: var(--muted);
}

.pa-empty-state { padding: 46px 24px; text-align: center; color: var(--muted); }
.pa-empty-icon {
  width: 44px; height: 44px; border-radius: 12px; margin: 0 auto 12px;
  display: grid; place-items: center; background: #efeff3; color: var(--muted);
}
.pa-empty-title { font-size: 14.5px; font-weight: 650; color: var(--ink); margin-bottom: 4px; }
.pa-empty-desc { font-size: 13px; color: var(--muted); max-width: 380px; margin: 0 auto 14px; }

@media (max-width: 1080px) {
  .pa-shell { grid-template-columns: 1fr; min-height: 0; }
  .pa-rail { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .pa-rail-note { display: none; }
  .pa-workbench { padding: 20px 20px 56px; }
}
@media (max-width: 720px) {
  .pa-kpi-grid { grid-template-columns: 1fr; }
}
</style>
