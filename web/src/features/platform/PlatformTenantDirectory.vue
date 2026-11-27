<script setup lang="ts">
import { platformTenantsContext } from "./use-platform-tenants.ts";

const { canCreate, tenantCollection, tenants, nextCursor, loadingMore, directoryLoading, busy, selectedTenant, search, statusFilter, dialogs, hasFilters, tenantOwner, selectTenant, reportError, run, load } = platformTenantsContext.use();
</script>
<template>
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
      :disabled="busy || !dialogs"
      @click="dialogs?.openCreateModal()"
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
</template>
