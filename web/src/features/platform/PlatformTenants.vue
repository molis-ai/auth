<script setup lang="ts">
import { lazyComponent } from "../../shared/components/lazy-component.ts";
const AuditEventDrawer = lazyComponent(() => import("./AuditEventDrawer.vue"));
const PlatformTenantDialogs = lazyComponent(() => import("./PlatformTenantDialogs.vue"));
import PlatformTenantMembers from "./PlatformTenantMembers.vue";
import PlatformTenantAuditPreview from "./PlatformTenantAuditPreview.vue";
import PlatformTenantOverview from "./PlatformTenantOverview.vue";
import PlatformTenantDirectory from "./PlatformTenantDirectory.vue";
import { platformTenantsContext, usePlatformTenants, type Props, type Events } from "./use-platform-tenants.ts";

const props = defineProps<Props>();
const emit = defineEmits<Events>();
const state = usePlatformTenants(props, emit);
platformTenantsContext.provide(state);
const { client, submitWrite, canCreate, hasUserRead, tenants, members, membersLoading, memberCursor, memberCollection, detailRequested, directoryLoading, busy, message, activeAuditEvent, selectedTenant, selectedOwner, dialogs, hasFilters, resetFilters, reportError, run, load, applyCommitted, refreshCommitted } = state;
</script>

<template>
  <section class="platform-tenants-page" data-console-layout="rail" data-console-flush>
    <div class="pt-shell">
      <!-- Left Secondary Rail (268px) -->
      <PlatformTenantDirectory />

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
            <PlatformTenantOverview />

            <PlatformTenantMembers
              :members="members" :count="selectedTenant.memberCount" :loading="membersLoading"
              :can-load-more="Boolean(memberCursor)" @more="memberCollection.more().catch(reportError)"
            />

            <!-- Card 2: Related Audit Events Preview -->
            <PlatformTenantAuditPreview />
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
                :disabled="!dialogs" @click="dialogs?.openCreateModal()"
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

    <PlatformTenantDialogs
      ref="dialogs" v-model:busy="busy" :client="client" :has-user-read="hasUserRead"
      :submit-write="submitWrite" :refresh="refreshCommitted"
      @expired="emit('expired', $event)" @committed="applyCommitted"
    />

    <!-- Shared Audit Event Detail Drawer -->
    <AuditEventDrawer
      :event="activeAuditEvent"
      :can-open-tenant="false"
      @close="activeAuditEvent = null"
      @notify="emit('notify', $event)"
    />
  </section>
</template>

<style src="./platform-tenants.css"></style>
