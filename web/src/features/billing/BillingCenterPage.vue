<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { AuthError, type AccountClient } from "../../shared/api/account-client.ts";
import { cursorCollection } from "../../shared/api/cursor-collection.ts";
import { accountErrorMessage } from "../../shared/api/errors.ts";
import BillingPanel from "./BillingPanel.vue";

interface TenantLedger {
  tenantId: string;
  name: string;
  status: string;
  myRole: string;
  membershipId: string;
  version: number;
}

interface LedgerSummary {
  active: boolean | null;
  available: number | null;
}

const props = defineProps<{
  client: AccountClient;
  viewerId: string;
  viewerName: string;
  viewerEmail?: string | null;
  initialSubjectId?: string;
}>();
const emit = defineEmits<{ expired: [error: AuthError] }>();

const roleLabels: Record<string, string> = { OWNER: "所有者", ADMIN: "管理员", MEMBER: "成员" };
const credits = new Intl.NumberFormat("zh-CN");
const selectedKey = ref<string>(props.initialSubjectId || "personal");
const tenantDirectory = cursorCollection<TenantLedger>(props.client);
const { items: tenants, loading: tenantsLoading, nextCursor: moreTenants } = tenantDirectory;
const tenantsError = ref("");
const summaries = reactive<Record<string, LedgerSummary>>({});
let disposed = false;

const selectedTenant = computed(() =>
  selectedKey.value === "personal"
    ? undefined
    : tenants.value.find(tenant => tenant.tenantId === selectedKey.value),
);

const billingScope = computed(() => {
  const tenant = selectedTenant.value;
  if (!tenant) return JSON.stringify([props.viewerId, "USER"]);
  return JSON.stringify([props.viewerId, "TENANT", tenant.tenantId, tenant.membershipId, tenant.myRole, tenant.status]);
});

const canManageSelected = computed(() => {
  const tenant = selectedTenant.value;
  if (!tenant) return true;
  return tenant.status === "ACTIVE" && ["OWNER", "ADMIN"].includes(tenant.myRole);
});

async function loadTenants(append = false) {
  if (disposed) return;
  tenantsError.value = "";
  try {
    if (append) await tenantDirectory.more();
    else await tenantDirectory.first("/tenants");
    if (disposed) return;
    if (selectedKey.value !== "personal" && !tenants.value.some(t => t.tenantId === selectedKey.value)) {
      selectedKey.value = "personal";
    }
  } catch (error) {
    if (disposed || (error instanceof AuthError && error.code === "CANCELLED")) return;
    if (error instanceof AuthError && error.status === 401) {
      emit("expired", new AuthError("SESSION_EXPIRED", error.status, error.requestId));
      return;
    }
    tenantsError.value = accountErrorMessage(error);
  }
}

function updateSummary(key: string, value: LedgerSummary) {
  summaries[key] = value;
}

function selectLedger(key: string) {
  selectedKey.value = key;
}

onMounted(() => void loadTenants(false));
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <section class="console-card billing-center-page" aria-label="订阅与账单">
    <div class="billing-directory-shell">
      <aside class="billing-rail" aria-label="账本目录">
        <div class="billing-rail-head">
          <h1>订阅与账单</h1>
        </div>

        <div class="billing-rail-group">
          <p class="billing-rail-label">个人账本</p>
          <div class="billing-rail-list">
            <button
              type="button"
              class="billing-rail-item"
              :class="{ 'is-active': selectedKey === 'personal' }"
              :aria-current="selectedKey === 'personal' ? 'true' : undefined"
              @click="selectLedger('personal')"
            >
              <span class="billing-rail-avatar" aria-hidden="true">{{ viewerName.slice(0, 1) || "M" }}</span>
              <span class="billing-rail-body">
                <span class="billing-rail-top">
                  <span class="billing-rail-name">{{ viewerName }}</span>
                  <span
                    v-if="summaries.personal?.active !== undefined && summaries.personal?.active !== null"
                    class="billing-rail-dot"
                    :class="summaries.personal.active ? 'is-on' : 'is-off'"
                    :title="summaries.personal.active ? '生效中' : '未订阅'"
                  />
                </span>
                <span class="billing-rail-sub">
                  <span>本人</span>
                  <span v-if="typeof summaries.personal?.available === 'number'" class="billing-rail-cr">
                    {{ credits.format(summaries.personal.available) }} Cr
                  </span>
                </span>
              </span>
            </button>
          </div>
        </div>

        <div class="billing-rail-group">
          <p class="billing-rail-label">
            团队账本<span v-if="tenants.length">（{{ tenants.length }}）</span>
          </p>
          <p v-if="tenantsLoading && tenants.length === 0" class="billing-rail-hint" role="status">正在读取团队…</p>
          <div v-else-if="tenantsError && tenants.length === 0" class="billing-rail-error" role="alert">
            <span>{{ tenantsError }}</span>
            <button type="button" @click="loadTenants(false)">重试</button>
          </div>
          <div v-else-if="tenants.length > 0" class="billing-rail-list">
            <button
              v-for="tenant in tenants"
              :key="tenant.tenantId"
              type="button"
              class="billing-rail-item"
              :class="{ 'is-active': selectedKey === tenant.tenantId }"
              :aria-current="selectedKey === tenant.tenantId ? 'true' : undefined"
              @click="selectLedger(tenant.tenantId)"
            >
              <span class="billing-rail-avatar is-team" aria-hidden="true">{{ tenant.name.slice(0, 1) || "T" }}</span>
              <span class="billing-rail-body">
                <span class="billing-rail-top">
                  <span class="billing-rail-name">{{ tenant.name }}</span>
                  <span
                    v-if="summaries[tenant.tenantId]?.active !== undefined && summaries[tenant.tenantId]?.active !== null"
                    class="billing-rail-dot"
                    :class="summaries[tenant.tenantId]?.active ? 'is-on' : 'is-off'"
                    :title="summaries[tenant.tenantId]?.active ? '生效中' : '未订阅'"
                  />
                </span>
                <span class="billing-rail-sub">
                  <span>{{ roleLabels[tenant.myRole] ?? tenant.myRole }}{{ tenant.status !== "ACTIVE" ? " · 已停用" : "" }}</span>
                  <span v-if="typeof summaries[tenant.tenantId]?.available === 'number'" class="billing-rail-cr">
                    {{ credits.format(summaries[tenant.tenantId]!.available!) }} Cr
                  </span>
                </span>
              </span>
            </button>
            <button v-if="moreTenants" type="button" class="billing-rail-more" :disabled="tenantsLoading" @click="loadTenants(true)">
              {{ tenantsLoading ? "正在加载…" : "加载更多团队" }}
            </button>
          </div>
          <p v-else class="billing-rail-hint">暂无所属团队，创建或加入团队后可在此切换查看团队账单。</p>
        </div>
      </aside>

      <div class="billing-directory-detail">
        <div class="billing-directory-inner">
          <BillingPanel
            :key="billingScope"
            :client="client"
            :viewer-id="viewerId"
            :owner-name="selectedTenant ? selectedTenant.name : viewerName"
            :tenant-id="selectedTenant?.tenantId"
            :role-label="selectedTenant ? (roleLabels[selectedTenant.myRole] ?? selectedTenant.myRole) : '本人'"
            :can-manage-orders="canManageSelected"
            @expired="emit('expired', $event)"
            @order-access-denied="loadTenants(false)"
            @summary="updateSummary(selectedKey, $event)"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.billing-center-page { margin: 0; }
.billing-directory-shell {
  display: grid;
  grid-template-columns: 244px minmax(0, 1fr);
  min-height: 100svh;
}

.billing-rail {
  position: sticky; top: 0; height: 100svh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 18px;
  padding: 24px 12px 24px;
  background: #f9f9fb;
  border-right: 1px solid var(--line);
}
.billing-rail-head { padding: 0 10px; }
.billing-rail-head h1 {
  margin: 0; font-size: 16px; font-weight: 650; color: var(--ink);
}
.billing-rail-group { display: grid; gap: 6px; }
.billing-rail-label {
  margin: 0; padding: 0 10px; font-size: 11.5px; font-weight: 600; color: var(--muted);
}
.billing-rail-list { display: grid; gap: 4px; }

.billing-rail .billing-rail-item {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 52px;
  padding: 9px 10px; border: 1px solid transparent; border-radius: 10px;
  background: transparent; text-align: left; color: var(--ink); cursor: pointer;
}
.billing-rail .billing-rail-item:hover { background: #efeff4; }
.billing-rail .billing-rail-item.is-active {
  background: var(--surface); border-color: var(--line);
  box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}

.billing-rail-avatar {
  width: 28px; height: 28px; flex-shrink: 0; border-radius: 50%;
  display: grid; place-items: center;
  background: #e3e8f8; color: #40558f; font-size: 12.5px; font-weight: 600;
}
.billing-rail-avatar.is-team { border-radius: 8px; background: #eae9f9; color: #4b4899; }
.billing-rail-body { min-width: 0; flex: 1; display: grid; gap: 2px; }
.billing-rail-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.billing-rail-name {
  font-size: 13px; font-weight: 600; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.billing-rail-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.billing-rail-dot.is-on { background: #26925c; }
.billing-rail-dot.is-off { background: #c5c5cf; }
.billing-rail-sub {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  font-size: 11.5px; color: var(--muted);
}
.billing-rail-cr { font-variant-numeric: tabular-nums; font-weight: 500; }

.billing-rail-hint { margin: 0; padding: 4px 10px; font-size: 12px; color: var(--muted); line-height: 1.5; }
.billing-rail-error {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: 0 4px; padding: 8px 10px; border-radius: 8px;
  background: #fdf1f2; border: 1px solid #f4d3d6; color: #a32921; font-size: 12px;
}
.billing-rail .billing-rail-more {
  min-height: 32px; height: 32px; margin-top: 2px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--surface); color: var(--muted); font-size: 12px;
}
.billing-directory-detail { min-width: 0; padding: 28px 36px 72px; }
.billing-directory-inner { max-width: 940px; margin: 0 auto; }

@media (max-width: 1060px) {
  .billing-directory-shell { grid-template-columns: 1fr; min-height: 0; }
  .billing-rail {
    position: static; height: auto; overflow-y: visible;
    border-right: 0; border-bottom: 1px solid var(--line);
    padding: 18px 20px; gap: 12px;
  }
  .billing-rail-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .billing-rail .billing-rail-item { width: auto; min-width: 170px; flex: 0 1 auto; min-height: 44px; padding: 7px 10px; }
  .billing-directory-detail { padding: 22px 20px 64px; }
}
@media (max-width: 540px) {
  .billing-rail { padding: 16px; }
  .billing-rail .billing-rail-item { width: 100%; }
  .billing-directory-detail { padding: 16px 14px 56px; }
}
</style>
