<script setup lang="ts">
import { billingPanelContext } from "./use-billing-subject.ts";

const { ownerKind, avatarText, saving, actionError, confirmation, credits, localTime, money, interval, intervalName, dialog, cancelConfirmation, confirmOrder, ownerName } = billingPanelContext.use();
</script>
<template>
  <dialog ref="dialog" class="billing-dialog" aria-labelledby="billing-confirm-title" @cancel.prevent="cancelConfirmation">
    <form v-if="confirmation" @submit.prevent="confirmOrder">
      <div class="billing-dialog-head">
        <h3 id="billing-confirm-title">{{ confirmation.action === "refund" ? "确认模拟退款" : "确认模拟支付" }}</h3>
      </div>
      <div class="billing-dialog-body">
        <div class="billing-dialog-subject" :class="{ 'is-team': ownerKind === 'TENANT' }">
          <span class="billing-avatar is-sm" :class="{ 'is-team': ownerKind === 'TENANT' }" aria-hidden="true">{{ avatarText }}</span>
          <span>归属主体：<strong>{{ ownerKind === "USER" ? `个人账号 · ${ownerName}` : `团队 · ${ownerName}` }}</strong></span>
        </div>
        <div class="billing-dialog-amount">
          <span>{{ confirmation.action === "refund" ? "退款金额" : "应付金额" }}</span>
          <strong>{{ money(confirmation.order.amountMinor, confirmation.order.currency) }}</strong>
        </div>
        <dl class="billing-facts billing-dialog-facts">
          <div><dt>{{ ownerKind === "USER" ? "账号" : "团队" }}</dt><dd>{{ ownerName }}</dd></div>
          <div><dt>套餐</dt><dd>{{ confirmation.planName }} · {{ intervalName(confirmation.order.interval) }}</dd></div>
          <div><dt>订单</dt><dd class="billing-mono">{{ confirmation.order.id }}</dd></div>
          <div><dt>{{ confirmation.action === "refund" ? "退款金额" : "应付金额" }}</dt><dd>{{ money(confirmation.order.amountMinor, confirmation.order.currency) }}</dd></div>
          <template v-if="confirmation.action === 'mock-pay'">
            <div><dt>每月到账</dt><dd>{{ credits.format(confirmation.order.monthlyCredits) }} Credit</dd></div>
            <div><dt>付款截止</dt><dd>{{ localTime(confirmation.order.paymentExpiresAt) }}</dd></div>
          </template>
          <div v-else-if="confirmation.order.servicePeriod"><dt>下期开始</dt><dd>{{ localTime(confirmation.order.servicePeriod.startsAt) }}</dd></div>
        </dl>
        <p v-if="confirmation.action === 'refund'" class="billing-dialog-warn">退款将撤回本订单的下期服务并重算已付至日期。当前服务期和可用余额保持原有账务结果。</p>
        <p v-if="actionError" class="billing-issue" role="alert">{{ actionError }}</p>
      </div>
      <footer class="billing-dialog-actions">
        <button type="button" :disabled="saving" autofocus @click="cancelConfirmation">关闭</button>
        <button type="submit" class="billing-primary" :class="{ 'is-danger': confirmation.action === 'refund' }" :disabled="saving">
          {{ saving ? "正在提交…" : confirmation.action === "refund" ? "确认退款" : "确认模拟支付" }}
        </button>
      </footer>
    </form>
  </dialog>
</template>
