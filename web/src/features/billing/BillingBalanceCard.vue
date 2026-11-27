<script setup lang="ts">
import { billingPanelContext } from "./use-billing-subject.ts";

const { ownerKind, loading, balance, credits, grantedCredits, reservedCredits, consumedCredits, creditPercent, localTime, errors } = billingPanelContext.use();
</script>
<template>
  <section class="billing-card billing-balance" aria-label="可用余额">
    <div class="billing-card-head">
      <h3>可用 Credit 资产</h3>
      <span class="billing-card-meta">
        {{ balance?.currentCreditPeriod ? `本期到期：${localTime(balance.currentCreditPeriod.expiresAt)}` : "未激活月度额度" }}
      </span>
    </div>
    <p v-if="loading.has('balance')" class="billing-loading" role="status">正在读取余额…</p>
    <div v-else-if="errors.balance" class="billing-issue" role="alert">
      <span>{{ errors.balance.message }}</span>
      <button type="button" @click="errors.balance.retry">重试余额</button>
    </div>
    <template v-else-if="balance">
      <div class="billing-credit-strip">
        <div class="billing-credit-main">
          <p class="billing-feature billing-credit">{{ credits.format(balance.available) }} <span>Credit</span></p>
          <div class="billing-meter-track" aria-hidden="true">
            <div class="billing-meter-fill" :class="{ 'is-team': ownerKind === 'TENANT' }" :style="{ width: `${creditPercent}%` }" />
          </div>
          <p class="billing-meter-caption">
            {{ grantedCredits > 0 ? `本期剩余 ${creditPercent}%` : "开通套餐后按订阅月自动到账，换期自动重置" }}
          </p>
        </div>
        <div class="billing-credit-mini">
          <span>本期额度</span>
          <strong>{{ credits.format(grantedCredits) }}</strong>
        </div>
        <div class="billing-credit-mini">
          <span>任务预留</span>
          <strong>{{ credits.format(reservedCredits) }}</strong>
        </div>
        <div class="billing-credit-mini">
          <span>本期实耗</span>
          <strong>{{ credits.format(consumedCredits) }}</strong>
        </div>
      </div>
      <dl v-if="balance.currentCreditPeriod" class="billing-facts billing-facts-inline">
        <div><dt>本期额度开始</dt><dd>{{ localTime(balance.currentCreditPeriod.startsAt) }}</dd></div>
        <div><dt>本期额度到期</dt><dd>{{ localTime(balance.currentCreditPeriod.expiresAt) }}</dd></div>
      </dl>
    </template>
  </section>
</template>
