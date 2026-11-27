<script setup lang="ts">
import { lazyComponent } from "../../shared/components/lazy-component.ts";
const AuditEventDrawer = lazyComponent(() => import("./AuditEventDrawer.vue"));
import PlatformAuditTable from "./PlatformAuditTable.vue";
import PlatformAuditFilters from "./PlatformAuditFilters.vue";
import PlatformAuditCategories from "./PlatformAuditCategories.vue";
import { platformAuditContext, usePlatformAudit, type Props, type Events } from "./use-platform-audit.ts";

const props = defineProps<Props>();
const emit = defineEmits<Events>();
const state = usePlatformAudit(props, emit);
platformAuditContext.provide(state);
const { hasTenantRead, tenantScope, scopedName, selectedEvent, allEvents, succeededCount, deniedCount, busy, message, load } = state;
</script>

<template>
  <section class="platform-audit-page" data-console-layout="rail" data-console-flush>
    <div class="pa-shell">
      <!-- Left Category Rail (244px) -->
      <PlatformAuditCategories />

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
            <PlatformAuditFilters />

            <PlatformAuditTable />
          </section>
        </div>
      </div>
    </div>

    <AuditEventDrawer
      v-if="selectedEvent"
      :event="selectedEvent"
      :can-open-tenant="hasTenantRead"
      @close="selectedEvent = null"
      @notify="emit('notify', $event)"
      @open-tenant="emit('openTenant', $event)"
    />
  </section>
</template>

<style src="./platform-audit.css"></style>
