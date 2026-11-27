<script setup lang="ts">
import { platformAuditContext } from "./use-platform-audit.ts";

const { resultFilter, query } = platformAuditContext.use();
</script>
<template>
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
</template>
