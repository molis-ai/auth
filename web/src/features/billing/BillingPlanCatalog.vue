<script setup lang="ts">
import { billingPanelContext } from "./use-billing-subject.ts";

const { ownerKind, saving, openingOrder, loading, canManage, credits, errors, subscription, plans, quote, hasFuturePeriod, money, interval, intervalName, yearlySavingsMinor, availablePlans, planId, createOrder, ownerName } = billingPanelContext.use();
</script>
<template>
  <section class="billing-card billing-catalog" aria-label="套餐">
    <div class="billing-card-head">
      <div>
        <h3>{{ !canManage ? "套餐说明" : subscription?.currentPeriod ? "续费套餐" : "开通订阅" }}</h3>
        <p v-if="canManage && quote && !hasFuturePeriod" class="billing-card-sub">
          归属主体：{{ ownerKind === "USER" ? `个人账号（${ownerName}）` : `团队（${ownerName}）` }}
        </p>
      </div>
      <div v-if="canManage && quote && !hasFuturePeriod && subscription" class="billing-segmented" role="group" aria-label="付款周期">
        <button
          type="button"
          data-interval="MONTH"
          :aria-pressed="interval === 'MONTH'"
          :class="{ 'is-active': interval === 'MONTH' }"
          :disabled="saving"
          @click="interval = 'MONTH'"
        >
          月付 {{ money(quote.monthlyPriceMinor, quote.currency) }}
        </button>
        <button
          type="button"
          data-interval="YEAR"
          :aria-pressed="interval === 'YEAR'"
          :class="{ 'is-active': interval === 'YEAR' }"
          :disabled="saving"
          @click="interval = 'YEAR'"
        >
          年付 {{ money(quote.yearlyPriceMinor, quote.currency) }}
          <span v-if="yearlySavingsMinor > 0" class="billing-save-tag">省 {{ money(yearlySavingsMinor, quote.currency) }}</span>
        </button>
      </div>
    </div>

    <p v-if="loading.has('catalog')" class="billing-loading" role="status">正在读取套餐…</p>
    <div v-else-if="errors.catalog" class="billing-issue" role="alert">
      <span>{{ errors.catalog.message }}</span>
      <button type="button" @click="errors.catalog.retry">重试套餐</button>
    </div>
    <template v-else-if="plans">
      <template v-if="canManage">
        <div v-if="hasFuturePeriod" class="billing-future-locked">
          <p>已购买下期服务，可在下期生效后继续续费。如需更换周期，可在下方订单列表中对未生效的续费订单申请退款。</p>
        </div>
        <p v-else-if="!quote" class="billing-empty-desc">{{ subscription?.currentPeriod ? "当前套餐暂无可续费报价。" : "暂无可售套餐。" }}</p>
        <form v-else-if="subscription" class="billing-purchase" @submit.prevent="createOrder">
          <div class="billing-purchase-info">
            <div class="billing-purchase-title-row">
              <label v-if="availablePlans.length > 1" class="billing-plan-select">
                <span>套餐</span>
                <select :value="quote.planId" :disabled="saving"
                  @change="planId = ($event.target as HTMLSelectElement).value">
                  <option v-for="plan in availablePlans" :key="plan.planId" :value="plan.planId">{{ plan.name }}</option>
                </select>
              </label>
              <strong v-else class="billing-plan-name">{{ quote.name }}</strong>
              <span class="billing-pill is-neutral">{{ intervalName(interval) }}</span>
            </div>
            <span class="billing-quote">
              应付 <strong>{{ money(interval === "MONTH" ? quote.monthlyPriceMinor : quote.yearlyPriceMinor, quote.currency) }}</strong>
              · 每月 {{ credits.format(quote.monthlyCredits) }} Credit
            </span>
          </div>
          <button class="billing-primary" :class="{ 'is-team': ownerKind === 'TENANT' }" type="submit" :disabled="saving || Boolean(openingOrder)">
            {{ subscription.currentPeriod ? "创建续费订单" : "创建订单" }}
          </button>
        </form>
      </template>
      <template v-else>
        <p v-if="plans.length === 0" class="billing-empty-desc">暂无可售套餐。</p>
        <ul v-else class="billing-readonly-plans">
          <li v-for="plan in plans" :key="plan.planId">
            <strong>{{ plan.name }}</strong>
            <span>每月 {{ credits.format(plan.monthlyCredits) }} Credit</span>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>
