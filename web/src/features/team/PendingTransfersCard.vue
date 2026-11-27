<script setup lang="ts">
import { pendingPageContext } from "./use-pending.ts";

const { transfers, loading, showTransfers, transfersLoading, moreTransfers, errors, read, loadTransfers, handleTransferClick, transferRows, busy } = pendingPageContext.use();
</script>
<template>
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
        v-for="transfer in transferRows"
        :key="transfer.transferId"
        class="console-row pending-item is-warn"
        :class="{ 'is-urgent': transfer.operation === 'accept' && transfer.expiry?.urgent }"
      >
        <div class="pending-row-icon" :class="transfer.operation === 'accept' ? 'is-transfer-in' : 'is-transfer-out'" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M17 3l4 4-4 4" />
            <path d="M3 7h18" />
            <path d="M7 21l-4-4 4-4" />
            <path d="M21 17H3" />
          </svg>
        </div>
        <div class="pending-row-main">
          <div class="pending-row-title-line">
            <span class="pending-item-text">{{ transfer.title }}</span>
            <span v-if="transfer.operation === 'accept'" class="pending-pill is-warning"><i class="pending-pill-dot" aria-hidden="true"></i>待你接收</span>
            <span v-else class="pending-pill is-neutral">等待对方确认</span>
          </div>
          <p class="pending-row-desc">
            {{ transfer.operation === "accept"
              ? "确认接收后，你将成为该团队的所有者，拥有成员管理、角色调整及团队订阅结算权限。"
              : "你已发起该团队的所有权交接，在对方确认接收前，你仍为当前所有者并可随时取消。" }}
          </p>
          <div v-if="transfer.expiry" class="pending-row-meta">
            <span class="pending-meta-item" :class="{ 'is-urgent': transfer.operation === 'accept' && transfer.expiry?.urgent }">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              <span>{{ transfer.expiry?.remaining }}（{{ transfer.expiry?.formatted }} 到期）</span>
            </span>
          </div>
        </div>
        <div class="pending-item-actions">
          <button
            v-if="transfer.operation"
            type="button"
            class="pending-btn"
            :class="transfer.operation === 'accept' ? 'pending-primary' : 'pending-danger-soft'"
            :disabled="busy || transfersLoading"
            @click="handleTransferClick(transfer)"
          >
            {{ transfer.operation === "accept" ? "接受交接" : "取消交接" }}
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
</template>
