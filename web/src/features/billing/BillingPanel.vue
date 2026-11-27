<script setup lang="ts">
import BillingConfirmDialog from "./BillingConfirmDialog.vue";
import BillingHistoryCard from "./BillingHistoryCard.vue";
import BillingPlanCatalog from "./BillingPlanCatalog.vue";
import BillingSubscriptionCard from "./BillingSubscriptionCard.vue";
import BillingBalanceCard from "./BillingBalanceCard.vue";
import { billingPanelContext, useBillingSubject, type Props, type Events } from "./use-billing-subject.ts";

const props = defineProps<Props>();
const emit = defineEmits<Events>();
const state = useBillingSubject(props, emit);
billingPanelContext.provide(state);
const { ownerKind, avatarText, effectiveRoleLabel, subjectBadgeText, viewerZone, zoneOffset, panelError, saving, openingOrder, loading, refreshFromControl, notice, actionError, confirmation, canManage } = state;
</script>

<template>
  <div class="billing-panel" :data-owner-kind="ownerKind">
    <header v-if="!panelError || ownerKind === 'USER'" class="billing-header">
      <div class="billing-subject">
        <span class="billing-avatar" :class="{ 'is-team': ownerKind === 'TENANT' }" aria-hidden="true">{{ avatarText }}</span>
        <div class="billing-subject-copy">
          <div class="billing-subject-row">
            <h2>{{ ownerName }}</h2>
            <span class="billing-pill" :class="ownerKind === 'TENANT' ? 'is-accent' : 'is-dark'">{{ subjectBadgeText }}</span>
            <span class="billing-pill" :class="canManage ? 'is-neutral' : 'is-warning'">{{ effectiveRoleLabel }}{{ canManage ? "" : " · 只读" }}</span>
          </div>
          <p class="billing-subject-meta">Molis Work · 时区：{{ viewerZone }}（{{ zoneOffset }}）</p>
        </div>
      </div>
      <button v-if="!panelError" type="button" class="billing-refresh" :disabled="saving || Boolean(openingOrder) || loading.size > 0" @click="refreshFromControl">
        <svg :class="{ 'is-spinning': loading.size > 0 }" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
        </svg>
        <span>{{ loading.size > 0 ? "正在刷新…" : "刷新账单" }}</span>
      </button>
    </header>

    <p v-if="notice" class="billing-notice" role="status">{{ notice }}</p>
    <p v-if="actionError && !confirmation" class="billing-issue" role="alert">{{ actionError }}</p>
    <div v-if="panelError" class="billing-issue billing-panel-alert" role="alert">
      <span>{{ panelError }}</span>
      <button type="button" @click="refreshFromControl">重试账单</button>
    </div>

    <template v-else>
      <div v-if="ownerKind === 'TENANT' && !canManage" class="billing-readonly-banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
        <span>你在 <strong>{{ ownerName }}</strong> 中的身份为普通成员：可查看团队套餐、共享余额及本人发起的消费流水；下单、续费与订单管理仅限团队所有者或管理员操作。</span>
      </div>

      <!-- Credit Asset Card -->
      <BillingBalanceCard />

      <!-- Subscription Service Period Timeline Card -->
      <BillingSubscriptionCard />

      <!-- Plan Purchase / Renewal Card -->
      <BillingPlanCatalog />

      <!-- Tabbed & Filterable Orders / Credit Ledger Card -->
      <BillingHistoryCard />
    </template>

    <!-- Confirmation Dialog -->
    <BillingConfirmDialog />
  </div>
</template>

<style src="./billing-panel.css"></style>
