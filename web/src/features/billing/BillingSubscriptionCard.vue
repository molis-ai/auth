<script setup lang="ts">
import { billingPanelContext } from "./use-billing-subject.ts";

const { loading, canManage, credits, localTime, errors, subscription, interval, intervalName } = billingPanelContext.use();
</script>
<template>
  <section class="billing-card billing-subscription" aria-label="订阅服务">
    <div class="billing-card-head">
      <div>
        <h3>订阅服务周期</h3>
        <p v-if="subscription?.paidThroughAt !== null && subscription?.paidThroughAt !== undefined" class="billing-card-sub">
          已付至 {{ localTime(subscription.paidThroughAt) }}
        </p>
      </div>
      <span v-if="subscription" class="billing-pill" :class="subscription.currentPeriod ? 'is-success' : 'is-neutral'">
        <span class="billing-pill-dot" aria-hidden="true" />
        {{ subscription.currentPeriod ? "生效中" : "未订阅" }}
      </span>
    </div>

    <p v-if="loading.has('subscription')" class="billing-loading" role="status">正在读取订阅…</p>
    <div v-else-if="errors.subscription" class="billing-issue" role="alert">
      <span>{{ errors.subscription.message }}</span>
      <button type="button" @click="errors.subscription.retry">重试订阅</button>
    </div>
    <template v-else-if="subscription">
      <div v-if="subscription.currentPeriod" class="billing-timeline">
        <div class="billing-timeline-node is-active">
          <div class="billing-timeline-kicker">
            <span>当前服务期</span>
            <span class="billing-pill is-success is-compact">使用中</span>
          </div>
          <p class="billing-feature">{{ subscription.currentPeriod.planName }}</p>
          <p class="billing-node-meta">{{ intervalName(subscription.currentPeriod.interval) }} · 每月 {{ credits.format(subscription.currentPeriod.monthlyCredits) }} Credit</p>
          <dl class="billing-facts">
            <div><dt>服务开始</dt><dd>{{ localTime(subscription.currentPeriod.startsAt) }}</dd></div>
            <div><dt>服务结束</dt><dd>{{ localTime(subscription.currentPeriod.endsAt) }}</dd></div>
          </dl>
        </div>

        <div v-if="subscription.futurePeriod" class="billing-timeline-node is-future billing-future">
          <div class="billing-timeline-kicker">
            <span>已购买的下期</span>
            <span class="billing-pill is-accent is-compact">已锁定</span>
          </div>
          <p class="billing-feature">{{ subscription.futurePeriod.planName }}</p>
          <p class="billing-node-meta">{{ intervalName(subscription.futurePeriod.interval) }} · 每月 {{ credits.format(subscription.futurePeriod.monthlyCredits) }} Credit</p>
          <dl class="billing-facts">
            <div><dt>下期开始</dt><dd>{{ localTime(subscription.futurePeriod.startsAt) }}</dd></div>
            <div><dt>下期结束</dt><dd>{{ localTime(subscription.futurePeriod.endsAt) }}</dd></div>
            <div v-if="canManage && subscription.futurePeriod.orderId"><dt>关联订单</dt><dd class="billing-mono">{{ subscription.futurePeriod.orderId }}</dd></div>
          </dl>
        </div>

        <div v-else class="billing-timeline-node">
          <div class="billing-timeline-kicker">
            <span>下一服务期</span>
            <span class="billing-muted-tag">未预购</span>
          </div>
          <p class="billing-node-empty-title">{{ canManage ? "可提前续购一期" : "暂无下期续费" }}</p>
          <p class="billing-node-meta">
            {{ canManage ? "续费期将无缝衔接在当前到期时刻之后；下期生效前支持自助整笔退款。" : "团队所有者或管理员可在当前服务期到期前提前续购一期。" }}
          </p>
        </div>
      </div>

      <div v-else class="billing-empty-inline">
        <p class="billing-empty-title">暂无生效套餐</p>
        <p class="billing-empty-desc">
          {{ canManage ? "可在下方直接选购套餐，支付成功后立即生效并到账首月 Credit。" : "请联系团队所有者或管理员开通团队套餐。" }}
        </p>
      </div>

      <dl v-if="subscription.paidThroughAt !== null" class="billing-facts billing-paid-through">
        <div><dt>已付至</dt><dd>{{ localTime(subscription.paidThroughAt) }}</dd></div>
      </dl>
    </template>
  </section>
</template>
