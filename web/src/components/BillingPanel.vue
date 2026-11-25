<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { AuthError, type AccountClient } from "../lib/account-client.ts";
import type {
  BillingBalance, BillingInterval, BillingLedgerEntry, BillingOrder, BillingPlan,
  BillingSubscription, CreateBillingOrder,
} from "../lib/billing-types.ts";
import { cursorCollection } from "../lib/cursor-collection.ts";
import { accountErrorMessage } from "../lib/errors.ts";
import { IdempotentSubmit } from "../lib/idempotent-submit.ts";

const props = defineProps<{
  client: AccountClient;
  viewerId: string;
  ownerName: string;
  tenantId?: string;
  canManageOrders: boolean;
}>();
const emit = defineEmits<{ expired: [error: AuthError]; orderAccessDenied: [] }>();
const ownerKind = props.tenantId === undefined ? "USER" : "TENANT";
const ownerId = props.tenantId ?? props.viewerId;
const query = new URLSearchParams({ product: "WORK", ownerKind, ownerId });
const path = (suffix: string) => "/billing" + suffix + "?" + query;
const submissions = new IdempotentSubmit();
submissions.setAccount(props.viewerId);

let readScope = new AbortController();
const lifetime = new AbortController();
const readClient: Pick<AccountClient, "request"> = {
  request: <T,>(resource: string) => props.client.request<T>(resource, undefined, "GET", undefined, readScope.signal),
};
const orders = cursorCollection<BillingOrder>(readClient);
const ledger = cursorCollection<BillingLedgerEntry>(readClient);
const { items: orderRows, nextCursor: nextOrders } = orders;
const { items: ledgerRows, nextCursor: nextLedger } = ledger;
const subscription = shallowRef<BillingSubscription>();
const balance = shallowRef<BillingBalance>();
const plans = shallowRef<BillingPlan[]>();
const teamOrdersDenied = ref(false);
const canManage = computed(() => props.canManageOrders && !teamOrdersDenied.value);
const visibleLedger = computed(() => ownerKind === "TENANT" && !canManage.value
  ? ledgerRows.value.filter(entry => entry.actorUserId === props.viewerId && memberLedgerKinds.has(entry.kind))
  : ledgerRows.value);
const memberLedgerKinds = new Set(["HOLD", "SETTLE", "RELEASE", "CONSUME"]);

type Section = "subscription" | "balance" | "catalog" | "orders" | "ledger";
const loading = reactive(new Set<Section>());
const errors = reactive<Partial<Record<Section, { message: string; code?: string; retry: () => void }>>>({});
const accessError = ref("");
const panelError = computed(() => {
  if (accessError.value) return accessError.value;
  const outage = errors.subscription;
  const sections: Section[] = ["subscription", "balance", "catalog", "ledger"];
  if (canManage.value) sections.push("orders");
  return outage && (outage.code === "BILLING_UNAVAILABLE" || outage.code === "AUTH_UNAVAILABLE") &&
    sections.every(section => errors[section]?.code === outage.code) ? outage.message : "";
});
const saving = ref(false);
const openingOrder = ref("");
const actionError = ref("");
const notice = ref("");
const dialog = ref<HTMLDialogElement>();
const confirmation = shallowRef<{ action: "mock-pay" | "refund"; order: BillingOrder; planName: string }>();

const interval = ref<BillingInterval>("MONTH");
const planId = ref("");
const availablePlans = computed(() => {
  const current = subscription.value?.currentPeriod;
  return (plans.value ?? []).filter(plan => !current || plan.planId === current.planId);
});
const quote = computed(() => availablePlans.value.find(plan => plan.planId === planId.value) ?? availablePlans.value[0]);
const hasFuturePeriod = computed(() => Boolean(subscription.value?.futurePeriod));

const orderLabels: Record<BillingOrder["status"], string> = {
  PENDING_PAYMENT: "待付款", PAID: "支付成功", EXPIRED: "订单超时", REFUNDED: "已退款",
};
const ledgerLabels: Record<BillingLedgerEntry["kind"], string> = {
  GRANT: "发放", HOLD: "预扣", SETTLE: "结算", RELEASE: "释放", CONSUME: "消费", EXPIRE: "到期失效", REVOKE: "撤销",
};
const billingErrors: Record<string, string> = {
  TENANT_DISABLED: "团队已停用，暂时无法查看团队账单。",
  BILLING_UNAVAILABLE: "账务服务暂时不可用，请重试。",
  NOT_FOUND: "账务记录或购买主体已不存在，或当前账号无法访问。",
  INVALID_TIMEZONE: "浏览器提供的时区无效，请检查设备时区后重试。",
  ORDER_EXPIRED: "订单超时。可按当前报价重新下单。",
  ORDER_NOT_REFUNDABLE: "该订单当前不可退款，请查看最新订单状态。",
  RENEWAL_ALREADY_PURCHASED: "已购买下期服务，本单仍待付款，请核对最新订阅。",
  PLAN_DISCONTINUED: "该套餐已停售，请查看最新可售套餐。",
  RESULT_UNKNOWN: "暂时无法确认结果。重试同一操作会沿用原请求。",
};

const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateTime = new Intl.DateTimeFormat("en-CA", {
  timeZone: viewerZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset",
});
const credits = new Intl.NumberFormat("zh-CN");
const signedCredits = new Intl.NumberFormat("zh-CN", { signDisplay: "exceptZero" });

function localTime(timestamp: number) {
  const parts = Object.fromEntries(dateTime.formatToParts(timestamp).map(({ type, value }) => [type, value]));
  const offset = parts.timeZoneName === "GMT" ? "UTC+00:00" : parts.timeZoneName.replace("GMT", "UTC");
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}（${viewerZone}，${offset}）`;
}
function money(minor: number, currency: string) {
  const format = new Intl.NumberFormat("zh-CN", { style: "currency", currency });
  return format.format(minor / 10 ** format.resolvedOptions().maximumFractionDigits!);
}
function intervalName(value: BillingInterval) {
  return value === "MONTH" ? "月付" : "年付";
}
function orderPlanName(order: BillingOrder) {
  const matches = (plan: { planId: string; planVersion: number }) =>
    plan.planId === order.planId && plan.planVersion === order.planVersion;
  const period = [subscription.value?.currentPeriod, subscription.value?.futurePeriod]
    .find(item => item && matches(item));
  return plans.value?.find(matches)?.name ?? period?.planName ?? order.planId;
}
function ledgerChanges(entry: BillingLedgerEntry) {
  const deltas = [
    ["发放", entry.deltaGranted], ["可用", entry.deltaAvailable], ["预留", entry.deltaReserved],
    ["实耗", entry.deltaConsumed], ["失效", entry.deltaExpired],
  ] as const;
  return deltas.filter(([, value]) => value !== 0)
    .map(([label, value]) => `${label} ${signedCredits.format(value)}`).join(" · ");
}
function message(error: unknown) {
  return (error instanceof AuthError && billingErrors[error.code]) || accountErrorMessage(error);
}

function resetReads() {
  readScope.abort();
  readScope = new AbortController();
  loading.clear();
  for (const section of Object.keys(errors) as Section[]) delete errors[section];
  subscription.value = undefined;
  balance.value = undefined;
  plans.value = undefined;
  orders.clear();
  ledger.clear();
}
function accessChanged(error: unknown, fromOrder: boolean, subjectRead: boolean) {
  if (!(error instanceof AuthError)) return false;
  if (error.status === 401) {
    resetReads();
    emit("expired", new AuthError("SESSION_EXPIRED", error.status, error.requestId));
    return true;
  }
  if (ownerKind !== "TENANT") return false;
  if (error.code === "FORBIDDEN" && fromOrder && canManage.value) {
    teamOrdersDenied.value = true;
    closeConfirmation();
    actionError.value = "";
    notice.value = "";
    emit("orderAccessDenied");
    void refresh();
    return true;
  }
  if (error.code === "TENANT_DISABLED" || (subjectRead && [403, 404].includes(error.status))) {
    resetReads();
    closeConfirmation();
    actionError.value = "";
    notice.value = "";
    accessError.value = message(error);
    return true;
  }
  return false;
}

async function read(section: Section, task: () => Promise<unknown>) {
  if (loading.has(section) || lifetime.signal.aborted) return;
  const signal = readScope.signal;
  loading.add(section);
  delete errors[section];
  try {
    await task();
  } catch (error) {
    if (signal.aborted || accessChanged(error, section === "orders", true)) return;
    errors[section] = {
      message: message(error), code: error instanceof AuthError ? error.code : undefined,
      retry: () => void read(section, task),
    };
  } finally {
    if (!signal.aborted) loading.delete(section);
  }
}

function loadSubscription() {
  return read("subscription", async () => {
    const signal = readScope.signal;
    const result = await readClient.request<BillingSubscription>(path("/subscriptions"));
    if (!signal.aborted) subscription.value = result;
  });
}
function loadBalance() {
  return read("balance", async () => {
    const signal = readScope.signal;
    const result = await readClient.request<BillingBalance>(path("/credits/balance"));
    if (!Number.isSafeInteger(result?.available)) throw new AuthError("INVALID_RESPONSE");
    if (!signal.aborted) balance.value = result;
  });
}
function loadCatalog() {
  return read("catalog", async () => {
    const signal = readScope.signal;
    const result = await readClient.request<{ items: BillingPlan[] }>(path("/catalog/plans"));
    if (!signal.aborted) plans.value = result.items;
  });
}
function loadOrders() {
  return read("orders", () => orders.first(path("/orders")));
}
function loadLedger() {
  return read("ledger", () => ledger.first(path("/credits/ledger")));
}
async function refresh() {
  resetReads();
  accessError.value = "";
  const signal = readScope.signal;
  const reads = [loadSubscription(), loadCatalog(), ...(canManage.value ? [loadOrders()] : [])];
  // Balance synchronizes due Credit periods before ledger reads the corresponding entries.
  await loadBalance();
  if (!signal.aborted) await loadLedger();
  await Promise.all(reads);
}

let orderExpiryTimer: ReturnType<typeof setTimeout> | undefined;
watch(orderRows, rows => {
  clearTimeout(orderExpiryTimer);
  const now = Date.now();
  const next = Math.min(...rows
    .filter(order => order.status === "PENDING_PAYMENT" && order.paymentExpiresAt > now)
    .map(order => order.paymentExpiresAt));
  if (Number.isFinite(next)) {
    orderExpiryTimer = setTimeout(() => void loadOrders(), next - now);
  }
});

function closeConfirmation() {
  dialog.value?.close();
  confirmation.value = undefined;
}
function cancelConfirmation() {
  if (!saving.value) {
    closeConfirmation();
    actionError.value = "";
  }
}
function showConfirmation(action: "mock-pay" | "refund", order: BillingOrder) {
  const pending = { action, order, planName: orderPlanName(order) };
  confirmation.value = pending;
  void nextTick(() => {
    if (confirmation.value === pending) dialog.value?.showModal();
  });
}
async function openOrder(action: "mock-pay" | "refund", orderId: string) {
  if (!canManage.value || saving.value || openingOrder.value) return;
  openingOrder.value = orderId;
  actionError.value = "";
  notice.value = "";
  const signal = readScope.signal;
  try {
    const order = await props.client.request<BillingOrder>(
      path("/orders/" + encodeURIComponent(orderId)), undefined, "GET", undefined, signal,
    );
    if (signal.aborted) return;
    if (action === "mock-pay" && order.status !== "PENDING_PAYMENT") {
      actionError.value = order.status === "EXPIRED" ? billingErrors.ORDER_EXPIRED! : "订单状态已更新，请核对订单列表。";
      await loadOrders();
    } else if (action === "refund" && !order.refundable) {
      actionError.value = billingErrors.ORDER_NOT_REFUNDABLE!;
      await loadOrders();
    } else {
      showConfirmation(action, order);
    }
  } catch (error) {
    if (!signal.aborted && !accessChanged(error, true, false)) actionError.value = message(error);
  } finally {
    openingOrder.value = "";
  }
}

async function write(resource: string, body: unknown, committed: (order: BillingOrder) => void) {
  if (!canManage.value || saving.value || openingOrder.value || accessError.value) return;
  saving.value = true;
  actionError.value = "";
  notice.value = "";
  const signal = lifetime.signal;
  try {
    const order = await submissions.send(resource, "POST", resource, body,
      key => props.client.request<BillingOrder>(resource, body, "POST", key, signal));
    if (signal.aborted || !canManage.value || accessError.value) return;
    committed(order);
    void refresh();
  } catch (error) {
    if (signal.aborted || accessChanged(error, true, false)) return;
    actionError.value = message(error);
    if (error instanceof AuthError && [
      "ORDER_EXPIRED", "ORDER_NOT_REFUNDABLE", "RENEWAL_ALREADY_PURCHASED",
      "PLAN_DISCONTINUED", "IDEMPOTENCY_CONFLICT",
    ].includes(error.code)) {
      closeConfirmation();
      void refresh();
    }
  } finally {
    saving.value = false;
  }
}
function createOrder() {
  if (!subscription.value || hasFuturePeriod.value || !quote.value) return;
  const input: CreateBillingOrder = { planId: quote.value.planId, interval: interval.value, billingTimeZone: viewerZone };
  void write(path("/orders"), input, order => {
    notice.value = "订单已创建";
    showConfirmation("mock-pay", order);
  });
}
function confirmOrder() {
  const pending = confirmation.value;
  if (!pending) return;
  const { action, order } = pending;
  void write(path(`/orders/${encodeURIComponent(order.id)}/${action}`), {}, updated => {
    closeConfirmation();
    notice.value = orderLabels[updated.status];
  });
}

onMounted(() => void refresh());
onBeforeUnmount(() => {
  lifetime.abort();
  readScope.abort();
  clearTimeout(orderExpiryTimer);
  submissions.setAccount(undefined);
  closeConfirmation();
});
</script>

<template>
  <div class="billing-panel">
    <div v-if="ownerKind === 'USER' || !panelError" class="billing-header">
      <h2 v-if="ownerKind === 'USER'">{{ ownerName }}</h2>
      <button v-if="!panelError" type="button" :disabled="saving || Boolean(openingOrder) || loading.size > 0" @click="refresh">刷新账单</button>
    </div>

    <p v-if="notice" class="billing-notice" role="status">{{ notice }}</p>
    <p v-if="actionError && !confirmation" class="billing-issue" role="alert">{{ actionError }}</p>
    <div v-if="panelError" class="billing-issue" role="alert">
      <span>{{ panelError }}</span><button type="button" @click="refresh">重试账单</button>
    </div>
    <template v-else>
      <div class="billing-overview">
        <section class="billing-card billing-subscription" aria-label="订阅服务">
          <h3>订阅服务</h3>
          <p v-if="loading.has('subscription')" role="status">正在读取订阅…</p>
          <div v-else-if="errors.subscription" class="billing-issue" role="alert">
            <span>{{ errors.subscription.message }}</span><button type="button" @click="errors.subscription.retry">重试订阅</button>
          </div>
          <template v-else-if="subscription">
            <template v-if="subscription.currentPeriod">
              <p class="billing-feature">{{ subscription.currentPeriod.planName }}</p>
              <p>{{ intervalName(subscription.currentPeriod.interval) }} · 每月 {{ credits.format(subscription.currentPeriod.monthlyCredits) }} Credit</p>
              <dl class="billing-facts">
                <div><dt>服务开始</dt><dd>{{ localTime(subscription.currentPeriod.startsAt) }}</dd></div>
                <div><dt>服务结束</dt><dd>{{ localTime(subscription.currentPeriod.endsAt) }}</dd></div>
              </dl>
            </template>
            <p v-else>暂无生效套餐</p>
            <dl v-if="subscription.paidThroughAt !== null" class="billing-facts">
              <div><dt>已付至</dt><dd>{{ localTime(subscription.paidThroughAt) }}</dd></div>
            </dl>
            <div v-if="subscription.futurePeriod" class="billing-future">
              <h4>已购买的下期</h4>
              <p>{{ subscription.futurePeriod.planName }} · {{ intervalName(subscription.futurePeriod.interval) }} · 每月 {{ credits.format(subscription.futurePeriod.monthlyCredits) }} Credit</p>
              <dl class="billing-facts">
                <div><dt>下期开始</dt><dd>{{ localTime(subscription.futurePeriod.startsAt) }}</dd></div>
                <div><dt>下期结束</dt><dd>{{ localTime(subscription.futurePeriod.endsAt) }}</dd></div>
                <div v-if="canManage && subscription.futurePeriod.orderId"><dt>关联订单</dt><dd>{{ subscription.futurePeriod.orderId }}</dd></div>
              </dl>
            </div>
          </template>
        </section>

        <section class="billing-card billing-balance" aria-label="可用余额">
          <h3>可用余额</h3>
          <p v-if="loading.has('balance')" role="status">正在读取余额…</p>
          <div v-else-if="errors.balance" class="billing-issue" role="alert">
            <span>{{ errors.balance.message }}</span><button type="button" @click="errors.balance.retry">重试余额</button>
          </div>
          <template v-else-if="balance">
            <p class="billing-feature billing-credit">{{ credits.format(balance.available) }} <span>Credit</span></p>
            <dl v-if="balance.currentCreditPeriod" class="billing-facts">
              <div><dt>本期额度开始</dt><dd>{{ localTime(balance.currentCreditPeriod.startsAt) }}</dd></div>
              <div><dt>本期额度到期</dt><dd>{{ localTime(balance.currentCreditPeriod.expiresAt) }}</dd></div>
            </dl>
          </template>
        </section>
      </div>

      <section class="billing-card billing-catalog" aria-label="套餐">
        <h3>{{ canManage && subscription?.currentPeriod ? "续费套餐" : "套餐" }}</h3>
        <p v-if="loading.has('catalog')" role="status">正在读取套餐…</p>
        <div v-else-if="errors.catalog" class="billing-issue" role="alert">
          <span>{{ errors.catalog.message }}</span><button type="button" @click="errors.catalog.retry">重试套餐</button>
        </div>
        <template v-else-if="plans">
          <template v-if="canManage">
            <p v-if="hasFuturePeriod">已购买下期服务，可在下期生效后继续续费。</p>
            <p v-else-if="!quote">{{ subscription?.currentPeriod ? "当前套餐暂无可续费报价。" : "暂无可售套餐。" }}</p>
            <form v-else-if="subscription" class="billing-purchase" @submit.prevent="createOrder">
              <label v-if="availablePlans.length > 1">套餐
                <select :value="quote.planId" :disabled="saving"
                  @change="planId = ($event.target as HTMLSelectElement).value">
                  <option v-for="plan in availablePlans" :key="plan.planId" :value="plan.planId">{{ plan.name }}</option>
                </select>
              </label>
              <strong v-else>{{ quote.name }}</strong>
              <label>付款周期
                <select v-model="interval" :disabled="saving">
                  <option value="MONTH">月付</option><option value="YEAR">年付</option>
                </select>
              </label>
              <span class="billing-quote">
                应付 <strong>{{ money(interval === "MONTH" ? quote.monthlyPriceMinor : quote.yearlyPriceMinor, quote.currency) }}</strong>
                · 每月 {{ credits.format(quote.monthlyCredits) }} Credit
              </span>
              <button class="billing-primary" type="submit" :disabled="saving || Boolean(openingOrder)">
                {{ subscription.currentPeriod ? "创建续费订单" : "创建订单" }}
              </button>
            </form>
          </template>
          <template v-else>
            <p v-if="plans.length === 0">暂无可售套餐。</p>
            <p v-for="plan in plans" :key="plan.planId">{{ plan.name }} · 每月 {{ credits.format(plan.monthlyCredits) }} Credit</p>
          </template>
        </template>
      </section>

      <section v-if="canManage" class="billing-card billing-orders" aria-label="订单">
        <h3>订单</h3>
        <ul v-if="orderRows.length" class="billing-list">
          <li v-for="order in orderRows" :key="order.id" class="billing-order">
            <div class="billing-row-heading">
              <div><strong>{{ orderPlanName(order) }}</strong><p>{{ intervalName(order.interval) }} · {{ money(order.amountMinor, order.currency) }} · 每月 {{ credits.format(order.monthlyCredits) }} Credit</p></div>
              <span class="billing-order-status" :data-status="order.status">{{ orderLabels[order.status] }}</span>
            </div>
            <dl class="billing-facts">
              <div><dt>订单</dt><dd>{{ order.id }}</dd></div>
              <div><dt>下单时间</dt><dd>{{ localTime(order.createdAt) }}</dd></div>
              <div v-if="order.status === 'PENDING_PAYMENT' || order.status === 'EXPIRED'"><dt>付款截止</dt><dd>{{ localTime(order.paymentExpiresAt) }}</dd></div>
              <div v-if="order.paidAt !== null"><dt>支付时间</dt><dd>{{ localTime(order.paidAt) }}</dd></div>
              <div v-if="order.servicePeriod"><dt>服务开始</dt><dd>{{ localTime(order.servicePeriod.startsAt) }}</dd></div>
              <div v-if="order.servicePeriod"><dt>服务结束</dt><dd>{{ localTime(order.servicePeriod.endsAt) }}</dd></div>
              <div v-if="order.refundedAt !== null"><dt>退款时间</dt><dd>{{ localTime(order.refundedAt) }}</dd></div>
              <div v-if="order.status === 'REFUNDED'"><dt>退款金额</dt><dd>{{ money(order.amountMinor, order.currency) }}</dd></div>
            </dl>
            <div class="billing-order-actions">
              <button v-if="order.status === 'PENDING_PAYMENT'" type="button" :disabled="saving || Boolean(openingOrder)" @click="openOrder('mock-pay', order.id)">继续付款</button>
              <button v-if="order.refundable" type="button" :disabled="saving || Boolean(openingOrder)" @click="openOrder('refund', order.id)">申请退款</button>
              <span v-if="openingOrder === order.id" role="status">正在核对订单…</span>
            </div>
          </li>
        </ul>
        <p v-if="loading.has('orders')" role="status">正在读取订单…</p>
        <div v-else-if="errors.orders" class="billing-issue" role="alert">
          <span>{{ errors.orders.message }}</span><button type="button" @click="errors.orders.retry">重试订单</button>
        </div>
        <button v-else-if="nextOrders" type="button" @click="read('orders', orders.more)">加载更多订单</button>
        <p v-else-if="orderRows.length === 0">暂无订单</p>
      </section>

      <section class="billing-card billing-ledger" aria-label="Credit 流水">
        <h3>{{ ownerKind === "TENANT" && !canManage ? "我的团队 Credit 用量" : "Credit 流水" }}</h3>
        <ul v-if="visibleLedger.length" class="billing-list">
          <li v-for="entry in visibleLedger" :key="entry.id" class="billing-entry">
            <div class="billing-row-heading"><strong>{{ ledgerLabels[entry.kind] }}</strong><span>{{ ledgerChanges(entry) }}</span></div>
            <p>{{ localTime(entry.occurredAt) }}</p>
            <p v-if="ownerKind === 'TENANT' && canManage">操作者 {{ entry.actorUserId || '系统' }}</p>
            <p v-if="entry.referenceId">关联 {{ entry.referenceId }}</p>
          </li>
        </ul>
        <p v-if="loading.has('ledger')" role="status">正在读取流水…</p>
        <div v-else-if="errors.ledger" class="billing-issue" role="alert">
          <span>{{ errors.ledger.message }}</span><button type="button" @click="errors.ledger.retry">重试流水</button>
        </div>
        <button v-else-if="nextLedger" type="button" @click="read('ledger', ledger.more)">加载更多流水</button>
        <p v-else-if="visibleLedger.length === 0">暂无流水</p>
      </section>
    </template>

    <dialog ref="dialog" class="billing-dialog" aria-labelledby="billing-confirm-title" @cancel.prevent="cancelConfirmation">
      <form v-if="confirmation" @submit.prevent="confirmOrder">
        <h3 id="billing-confirm-title">{{ confirmation.action === "refund" ? "确认模拟退款" : "确认模拟支付" }}</h3>
        <dl class="billing-facts">
          <div><dt>{{ ownerKind === "USER" ? "账号" : "团队" }}</dt><dd>{{ ownerName }}</dd></div>
          <div><dt>套餐</dt><dd>{{ confirmation.planName }} · {{ intervalName(confirmation.order.interval) }}</dd></div>
          <div><dt>订单</dt><dd>{{ confirmation.order.id }}</dd></div>
          <div><dt>{{ confirmation.action === "refund" ? "退款金额" : "应付金额" }}</dt><dd>{{ money(confirmation.order.amountMinor, confirmation.order.currency) }}</dd></div>
          <template v-if="confirmation.action === 'mock-pay'">
            <div><dt>每月到账</dt><dd>{{ credits.format(confirmation.order.monthlyCredits) }} Credit</dd></div>
            <div><dt>付款截止</dt><dd>{{ localTime(confirmation.order.paymentExpiresAt) }}</dd></div>
          </template>
          <div v-else-if="confirmation.order.servicePeriod"><dt>下期开始</dt><dd>{{ localTime(confirmation.order.servicePeriod.startsAt) }}</dd></div>
        </dl>
        <p v-if="confirmation.action === 'refund'">退款将撤回本订单的下期服务并重算已付至日期。当前服务期和可用余额保持原有账务结果。</p>
        <p v-if="actionError" class="billing-issue" role="alert">{{ actionError }}</p>
        <footer class="billing-dialog-actions">
          <button type="button" :disabled="saving" autofocus @click="cancelConfirmation">关闭</button>
          <button type="submit" class="billing-primary" :disabled="saving">
            {{ saving ? "正在提交…" : confirmation.action === "refund" ? "确认退款" : "确认模拟支付" }}
          </button>
        </footer>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.billing-panel { display: grid; gap: 16px; min-width: 0; color: var(--ink); }
.billing-header, .billing-row-heading, .billing-dialog-actions, .billing-issue {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px;
}
.billing-header h2 { margin: 0; font-size: 22px; font-weight: 550; overflow-wrap: anywhere; }
.billing-header button { margin-inline-start: auto; }
.billing-overview { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 16px; }
.billing-card { min-width: 0; padding: 17px 19px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.billing-card h3, .billing-dialog h3 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
.billing-card p, .billing-dialog p { margin: 5px 0; line-height: 1.55; font-size: 13px; }
.billing-card .billing-feature { color: var(--ink); margin: 1px 0 6px; font-size: 18px; font-weight: 550; }
.billing-card .billing-credit { font-variant-numeric: tabular-nums; font-size: 27px; }
.billing-credit span { font-size: 13px; color: var(--muted); font-weight: 500; }
.billing-facts { display: grid; gap: 5px; margin: 10px 0 0; font-size: 12px; line-height: 1.45; }
.billing-facts div { display: grid; grid-template-columns: 6em minmax(0, 1fr); gap: 4px 6px; }
.billing-facts dt { color: var(--muted); }
.billing-facts dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.billing-future { border-top: 1px solid var(--line); margin-top: 13px; padding-top: 10px; }
.billing-future h4 { margin: 0; font-size: 13px; }
.billing-panel .billing-card .billing-purchase { display: flex; flex-wrap: wrap; align-items: end; gap: 10px 16px; max-width: none; margin: 0; }
.billing-purchase label { display: grid; gap: 4px; margin: 0; color: var(--muted); font-size: 12px; }
.billing-purchase select { margin: 0; min-height: 40px; max-width: 100%; }
.billing-purchase > strong, .billing-quote { align-self: center; font-size: 13px; }
.billing-quote strong { font-variant-numeric: tabular-nums; }
.billing-panel button.billing-primary { background: var(--ink); color: var(--surface); }
.billing-panel button.billing-primary:enabled:hover { opacity: .85; }
.billing-list { list-style: none; padding: 0; margin: 0 0 8px; }
.billing-list > li { border-top: 1px solid var(--line); padding: 13px 0; }
.billing-order-status { padding: 3px 8px; border-radius: 5px; color: var(--muted); background: var(--sidebar); font-size: 12px; }
.billing-order-status[data-status="PAID"] { color: #276447; background: #edf5ef; }
.billing-order-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
.billing-order-actions:not(:empty) { margin-top: 10px; }
.billing-entry p { color: var(--muted); overflow-wrap: anywhere; }
.billing-row-heading { font-size: 13px; }
.billing-issue { margin: 0; font-size: 13px; color: #a32921; }
.billing-notice { margin: 0; color: #276447; font-size: 13px; }
.billing-dialog { width: min(465px, calc(100vw - 32px)); max-height: 90vh; overflow: auto; padding: 22px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); color: var(--ink); }
.billing-dialog::backdrop { background: #19191b55; }
.billing-dialog form { margin: 0; }
.billing-dialog p { margin: 12px 0 0; }
.billing-dialog .billing-dialog-actions { justify-content: end; margin: 18px 0 0; }
@media (max-width: 1050px) { .billing-overview { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 540px) {
  .billing-card { padding: 13px; }
  .billing-facts div { grid-template-columns: minmax(0, 1fr); gap: 1px; }
}
</style>
