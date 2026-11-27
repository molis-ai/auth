<script setup lang="ts">
import { platformAuditContext } from "./use-platform-audit.ts";

const { allEvents, categories, category, resultFilter } = platformAuditContext.use();
</script>
<template>
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
</template>
