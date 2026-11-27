<script setup lang="ts">
import { billingPanelContext } from "./use-billing-subject.ts";

const { ownerKind, saving, openingOrder, loading, canManage, credits, localTime, errors, money, interval, intervalName, orderLabels, orderFilters, orderFilter, orderRows, filteredOrders, nextOrders, nextLedger, activeHistoryTab, historyTab, openOrder, ledger, orders, read, visibleLedger, ledgerChanges, ledgerHeadlineDelta, ledgerLabels, orderPlanName, viewerId } = billingPanelContext.use();
</script>
<template>
  <section class="billing-card billing-history-card">
    <div class="billing-tabs-bar">
      <div class="billing-tabs" role="tablist" aria-label="账务明细">
        <button
          v-if="canManage"
          type="button"
          role="tab"
          class="billing-tab"
          :class="{ 'is-active': activeHistoryTab === 'orders' }"
          :aria-selected="activeHistoryTab === 'orders'"
          @click="historyTab = 'orders'"
        >
          订单
          <span class="billing-tab-count">{{ orderRows.length }}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="billing-tab"
          :class="{ 'is-active': activeHistoryTab === 'ledger' }"
          :aria-selected="activeHistoryTab === 'ledger'"
          @click="historyTab = 'ledger'"
        >
          {{ ownerKind === "TENANT" && !canManage ? "我的团队 Credit 用量" : "Credit 流水" }}
          <span class="billing-tab-count">{{ visibleLedger.length }}</span>
        </button>
      </div>
      <div v-if="activeHistoryTab === 'orders' && orderRows.length > 0" class="billing-filter-pills" role="group" aria-label="按订单状态筛选">
        <button
          v-for="[key, label] in orderFilters"
          :key="key"
          type="button"
          class="billing-filter-pill"
          :class="{ 'is-active': orderFilter === key }"
          @click="orderFilter = key"
        >
          {{ label }}
        </button>
      </div>
    </div>

    <!-- Orders Tab Content -->
    <section v-if="canManage && activeHistoryTab === 'orders'" class="billing-orders" aria-label="订单">
      <ul v-if="filteredOrders.length" class="billing-list">
        <li v-for="order in filteredOrders" :key="order.id" class="billing-order">
          <div class="billing-row-heading">
            <div class="billing-order-title">
              <strong>{{ orderPlanName(order) }} · {{ intervalName(order.interval) }}</strong>
              <span class="billing-order-price">{{ money(order.amountMinor, order.currency) }} · 每月 {{ credits.format(order.monthlyCredits) }} Credit</span>
            </div>
            <span class="billing-order-status" :data-status="order.status">
              <span class="billing-pill-dot" aria-hidden="true" />
              {{ orderLabels[order.status] }}
            </span>
          </div>
          <dl class="billing-facts billing-order-facts">
            <div><dt>订单</dt><dd class="billing-mono">{{ order.id }}</dd></div>
            <div><dt>下单时间</dt><dd>{{ localTime(order.createdAt) }}</dd></div>
            <div v-if="order.status === 'PENDING_PAYMENT' || order.status === 'EXPIRED'"><dt>付款截止</dt><dd>{{ localTime(order.paymentExpiresAt) }}</dd></div>
            <div v-if="order.paidAt !== null"><dt>支付时间</dt><dd>{{ localTime(order.paidAt) }}</dd></div>
            <div v-if="order.servicePeriod"><dt>服务开始</dt><dd>{{ localTime(order.servicePeriod.startsAt) }}</dd></div>
            <div v-if="order.servicePeriod"><dt>服务结束</dt><dd>{{ localTime(order.servicePeriod.endsAt) }}</dd></div>
            <div v-if="order.refundedAt !== null"><dt>退款时间</dt><dd>{{ localTime(order.refundedAt) }}</dd></div>
            <div v-if="order.status === 'REFUNDED'"><dt>退款金额</dt><dd>{{ money(order.amountMinor, order.currency) }}</dd></div>
          </dl>
          <div class="billing-order-actions">
            <button v-if="order.status === 'PENDING_PAYMENT'" type="button" class="billing-action-primary" :disabled="saving || Boolean(openingOrder)" @click="openOrder('mock-pay', order.id)">继续付款</button>
            <button v-if="order.refundable" type="button" class="billing-action-danger" :disabled="saving || Boolean(openingOrder)" @click="openOrder('refund', order.id)">申请退款</button>
            <span v-if="openingOrder === order.id" class="billing-loading" role="status">正在核对订单…</span>
          </div>
        </li>
      </ul>
      <p v-if="loading.has('orders')" class="billing-loading billing-padded" role="status">正在读取订单…</p>
      <div v-else-if="errors.orders" class="billing-issue billing-padded" role="alert">
        <span>{{ errors.orders.message }}</span>
        <button type="button" @click="errors.orders.retry">重试订单</button>
      </div>
      <div v-else-if="nextOrders" class="billing-more-wrap">
        <button type="button" @click="read('orders', orders.more)">加载更多订单</button>
      </div>
      <div v-else-if="orderRows.length === 0" class="billing-empty-state">
        <p class="billing-empty-title">暂无订单</p>
        <p class="billing-empty-desc">创建订阅或续费订单后，可在此继续付款或对尚未生效的订单申请退款。</p>
      </div>
      <div v-else-if="filteredOrders.length === 0" class="billing-empty-state">
        <p class="billing-empty-title">当前筛选下暂无订单</p>
        <p class="billing-empty-desc">可切换上方状态标签查看其它订单记录。</p>
      </div>
    </section>

    <!-- Credit Ledger Tab Content -->
    <section v-if="activeHistoryTab === 'ledger'" class="billing-ledger" aria-label="Credit 流水">
      <ul v-if="visibleLedger.length" class="billing-list">
        <li v-for="entry in visibleLedger" :key="entry.id" class="billing-entry">
          <div class="billing-row-heading">
            <div class="billing-entry-left">
              <span class="billing-ledger-kind" :data-kind="entry.kind">{{ ledgerLabels[entry.kind] }}</span>
              <span class="billing-entry-deltas">{{ ledgerChanges(entry) }}</span>
            </div>
            <strong class="billing-entry-headline" :data-tone="ledgerHeadlineDelta(entry).tone">
              {{ ledgerHeadlineDelta(entry).text }}
            </strong>
          </div>
          <div class="billing-entry-meta">
            <span>{{ localTime(entry.occurredAt) }}</span>
            <span v-if="ownerKind === 'TENANT' && canManage">操作者 {{ entry.actorUserId ? (entry.actorUserId === viewerId ? "本人" : "其他成员") : "系统" }}</span>
            <span v-if="entry.referenceId" class="billing-mono">关联 {{ entry.referenceId }}</span>
          </div>
        </li>
      </ul>
      <p v-if="loading.has('ledger')" class="billing-loading billing-padded" role="status">正在读取流水…</p>
      <div v-else-if="errors.ledger" class="billing-issue billing-padded" role="alert">
        <span>{{ errors.ledger.message }}</span>
        <button type="button" @click="errors.ledger.retry">重试流水</button>
      </div>
      <div v-else-if="nextLedger" class="billing-more-wrap">
        <button type="button" @click="read('ledger', ledger.more)">加载更多流水</button>
      </div>
      <div v-else-if="visibleLedger.length === 0" class="billing-empty-state">
        <p class="billing-empty-title">暂无流水</p>
        <p class="billing-empty-desc">产生月度额度变动或任务消耗后，所有 Credit 明细将记录于此。</p>
      </div>
    </section>
  </section>
</template>
