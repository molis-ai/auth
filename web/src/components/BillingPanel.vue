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
  roleLabel?: string;
  canManageOrders: boolean;
}>();
const emit = defineEmits<{
  expired: [error: AuthError];
  orderAccessDenied: [];
  summary: [value: { active: boolean | null; available: number | null }];
}>();
const ownerKind = props.tenantId === undefined ? "USER" : "TENANT";
const ownerId = props.tenantId ?? props.viewerId;
const query = new URLSearchParams({ product: "WORK", ownerKind, ownerId });
const path = (suffix: string) => "/billing" + suffix + "?" + query;
const submissions = new IdempotentSubmit();
submissions.setAccount(props.viewerId);

let readScope = new AbortController();
const lifetime = new AbortController();
const readClient: Pick<AccountClient, "request"> = {
  request: <T,>(resource: string, _body?: unknown, _method?: string, _key?: string, signal?: AbortSignal) =>
    props.client.request<T>(resource, undefined, "GET", undefined,
      signal ? AbortSignal.any([readScope.signal, signal]) : readScope.signal),
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
const historyTab = ref<"orders" | "ledger">(props.canManageOrders ? "orders" : "ledger");
const orderFilter = ref<"ALL" | BillingOrder["status"]>("ALL");

const activeHistoryTab = computed<"orders" | "ledger">(() => (canManage.value ? historyTab.value : "ledger"));
const filteredOrders = computed(() =>
  orderFilter.value === "ALL"
    ? orderRows.value
    : orderRows.value.filter(order => order.status === orderFilter.value),
);

const availablePlans = computed(() => {
  const current = subscription.value?.currentPeriod;
  return (plans.value ?? []).filter(plan => !current || plan.planId === current.planId);
});
const quote = computed(() => availablePlans.value.find(plan => plan.planId === planId.value) ?? availablePlans.value[0]);
const hasFuturePeriod = computed(() => Boolean(subscription.value?.futurePeriod));
const yearlySavingsMinor = computed(() => {
  if (!quote.value) return 0;
  return Math.max(0, quote.value.monthlyPriceMinor * 12 - quote.value.yearlyPriceMinor);
});

const grantedCredits = computed(() => {
  if (!balance.value) return 0;
  if (typeof balance.value.granted === "number") return balance.value.granted;
  if (!balance.value.currentCreditPeriod) return 0;
  return subscription.value?.currentPeriod?.monthlyCredits ?? balance.value.available;
});
const reservedCredits = computed(() => (typeof balance.value?.reserved === "number" ? balance.value.reserved : 0));
const consumedCredits = computed(() => {
  if (!balance.value) return 0;
  if (typeof balance.value.consumed === "number") return balance.value.consumed;
  return Math.max(0, grantedCredits.value - balance.value.available - reservedCredits.value);
});
const creditPercent = computed(() => {
  if (!balance.value || grantedCredits.value <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((balance.value.available / grantedCredits.value) * 100)));
});

const effectiveRoleLabel = computed(() => props.roleLabel ?? (ownerKind === "USER" ? "本人" : canManage.value ? "管理员" : "成员"));
const avatarText = computed(() => props.ownerName.trim().slice(0, 1) || "M");
const subjectBadgeText = computed(() => (ownerKind === "USER" ? "个人账本" : "团队账本"));

watch([subscription, balance], ([nextSub, nextBal]) => {
  emit("summary", {
    active: nextSub ? Boolean(nextSub.currentPeriod) : null,
    available: nextBal ? nextBal.available : null,
  });
});

watch(canManage, allowed => {
  if (!allowed) historyTab.value = "ledger";
});

const orderLabels: Record<BillingOrder["status"], string> = {
  PENDING_PAYMENT: "待付款", PAID: "支付成功", EXPIRED: "订单超时", REFUNDED: "已退款",
};
const ledgerLabels: Record<BillingLedgerEntry["kind"], string> = {
  GRANT: "发放", HOLD: "预扣", SETTLE: "结算", RELEASE: "释放", CONSUME: "消费", EXPIRE: "到期失效", REVOKE: "撤销",
};
const orderFilters: ReadonlyArray<readonly ["ALL" | BillingOrder["status"], string]> = [
  ["ALL", "全部"],
  ["PENDING_PAYMENT", "待付款"],
  ["PAID", "支付成功"],
  ["EXPIRED", "订单超时"],
  ["REFUNDED", "已退款"],
];
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
const zoneOffset = (() => {
  const parts = Object.fromEntries(dateTime.formatToParts(Date.now()).map(({ type, value }) => [type, value]));
  return parts.timeZoneName === "GMT" ? "UTC+00:00" : parts.timeZoneName.replace("GMT", "UTC");
})();
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
function ledgerHeadlineDelta(entry: BillingLedgerEntry): { text: string; tone: "pos" | "neg" | "muted" } {
  if (entry.deltaAvailable !== 0) {
    return {
      text: `${signedCredits.format(entry.deltaAvailable)} Credit`,
      tone: entry.deltaAvailable > 0 ? "pos" : entry.kind === "EXPIRE" ? "muted" : "neg",
    };
  }
  if (entry.deltaConsumed !== 0) {
    return { text: `${signedCredits.format(-entry.deltaConsumed)} Credit`, tone: "neg" };
  }
  if (entry.deltaExpired !== 0) {
    return { text: `${signedCredits.format(-entry.deltaExpired)} Credit`, tone: "muted" };
  }
  return { text: "0 Credit", tone: "muted" };
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
    historyTab.value = "orders";
    orderFilter.value = "ALL";
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
      <button v-if="!panelError" type="button" class="billing-refresh" :disabled="saving || Boolean(openingOrder) || loading.size > 0" @click="refresh">
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
      <button type="button" @click="refresh">重试账单</button>
    </div>

    <template v-else>
      <div v-if="ownerKind === 'TENANT' && !canManage" class="billing-readonly-banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
        <span>你在 <strong>{{ ownerName }}</strong> 中的身份为普通成员：可查看团队套餐、共享余额及本人发起的消费流水；下单、续费与订单管理仅限团队所有者或管理员操作。</span>
      </div>

      <!-- Credit Asset Card -->
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

      <!-- Subscription Service Period Timeline Card -->
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

      <!-- Plan Purchase / Renewal Card -->
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

      <!-- Tabbed & Filterable Orders / Credit Ledger Card -->
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

    <!-- Confirmation Dialog -->
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
  </div>
</template>

<style scoped>
.billing-panel { display: grid; gap: 16px; min-width: 0; color: var(--ink); }

.billing-header {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px;
}
.billing-subject { display: flex; align-items: center; gap: 12px; min-width: 0; }
.billing-subject-copy { min-width: 0; }
.billing-subject-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.billing-header h2 { margin: 0; font-size: 22px; font-weight: 650; line-height: 1.3; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.billing-subject-meta { margin: 3px 0 0; font-size: 12.5px; color: var(--muted); }

.billing-avatar {
  width: 40px; height: 40px; flex-shrink: 0; border-radius: 50%;
  display: grid; place-items: center;
  background: #e3e8f8; color: #40558f; font-size: 16px; font-weight: 600;
}
.billing-avatar.is-team { border-radius: 10px; background: #eae9f9; color: #4b4899; }
.billing-avatar.is-sm { width: 24px; height: 24px; font-size: 11.5px; }

.billing-panel button.billing-refresh {
  display: inline-flex; align-items: center; gap: 6px; margin-inline-start: auto;
  min-height: 36px; height: 36px; padding: 0 13px; border-radius: 8px;
  border: 1px solid #d5d5db; background: var(--surface); color: var(--ink); font-size: 13px; font-weight: 500;
}
.billing-panel button.billing-refresh:enabled:hover { background: #f8f8fa; border-color: #c2c2cb; }
.billing-refresh svg { width: 14px; height: 14px; stroke-width: 1.8; }
.is-spinning { animation: billing-spin 700ms linear infinite; }
@keyframes billing-spin { to { transform: rotate(360deg); } }

.billing-pill {
  display: inline-flex; align-items: center; gap: 5px;
  height: 23px; padding: 0 9px; border-radius: 999px;
  font-size: 11.5px; font-weight: 500; white-space: nowrap; border: 1px solid transparent;
}
.billing-pill.is-compact { height: 20px; padding: 0 7px; font-size: 11px; }
.billing-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.billing-pill.is-dark { background: #222227; color: #f5f5f7; }
.billing-pill.is-accent { background: var(--accent-soft); color: var(--accent); border-color: #d5def5; }
.billing-pill.is-neutral { background: #efeff2; color: var(--muted); border-color: #e2e2e7; }
.billing-pill.is-success { background: #ecf7f0; color: #216b46; border-color: #cbe8d7; }
.billing-pill.is-warning { background: #fff8e6; color: #8a5a10; border-color: #f2dfb3; }

.billing-notice {
  margin: 0; padding: 10px 14px; border-radius: 10px;
  background: #ecf7f0; border: 1px solid #cbe8d7; color: #216b46; font-size: 13px;
}
.billing-issue {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 14px;
  margin: 0; padding: 11px 14px; border-radius: 10px;
  background: #fdf1f2; border: 1px solid #f4d3d6; color: #a32921; font-size: 13px;
}
.billing-panel-alert { padding: 14px 16px; }

.billing-readonly-banner {
  display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: 10px;
  background: #f5f6fa; border: 1px solid #dfe3f0; color: #414d75; font-size: 13px; line-height: 1.5;
}
.billing-readonly-banner svg { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; stroke-width: 1.8; }

.billing-card {
  min-width: 0; padding: 20px 22px; border: 1px solid var(--line); border-radius: 14px;
  background: var(--surface); box-shadow: 0 1px 2px rgba(25, 25, 27, 0.03);
}
.billing-card-head {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px;
  margin-bottom: 14px;
}
.billing-card h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); }
.billing-card-sub { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
.billing-card-meta { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.billing-loading { margin: 0; color: var(--muted); font-size: 13px; }
.billing-padded { margin: 16px 20px; }

/* Credit Asset Strip */
.billing-credit-strip {
  display: grid; grid-template-columns: minmax(0, 1.35fr) repeat(3, minmax(0, 0.72fr));
  gap: 12px; align-items: center;
}
.billing-credit-main { min-width: 0; }
.billing-card .billing-feature { color: var(--ink); margin: 0 0 4px; font-size: 16px; font-weight: 600; }
.billing-card .billing-credit {
  margin: 0 0 10px; font-size: 32px; line-height: 1.08; font-weight: 700;
  letter-spacing: -0.03em; font-variant-numeric: tabular-nums;
}
.billing-credit span { font-size: 13.5px; color: var(--muted); font-weight: 500; }
.billing-meter-track { width: 100%; height: 7px; border-radius: 999px; background: #ececf0; overflow: hidden; }
.billing-meter-fill {
  height: 100%; border-radius: 999px;
  background: linear-gradient(90deg, #27272c, #52525c); transition: width 280ms ease;
}
.billing-meter-fill.is-team { background: linear-gradient(90deg, #5068b7, #6d84d4); }
.billing-meter-caption { margin: 7px 0 0; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.billing-credit-mini {
  padding: 10px 12px; border-radius: 10px; background: #fafafb; border: 1px solid var(--line);
}
.billing-credit-mini span { display: block; font-size: 11.5px; color: var(--muted); }
.billing-credit-mini strong { display: block; margin-top: 3px; font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; color: var(--ink); }

/* Facts Lists */
.billing-facts { display: grid; gap: 5px; margin: 10px 0 0; font-size: 12px; line-height: 1.45; }
.billing-facts div { display: grid; grid-template-columns: 6.2em minmax(0, 1fr); gap: 4px 8px; }
.billing-facts dt { color: var(--muted); }
.billing-facts dd { margin: 0; color: var(--ink); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.billing-facts-inline {
  margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line);
  grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 16px;
}
.billing-paid-through { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.billing-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }

/* Subscription Timeline */
.billing-timeline { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.billing-timeline-node {
  min-width: 0; padding: 14px 16px; border-radius: 11px;
  border: 1px solid var(--line); background: #fafafb;
}
.billing-timeline-node.is-active { background: var(--surface); border-color: #cfd7f0; }
.billing-timeline-node.is-future { background: #f6f8fe; border-style: dashed; border-color: #c2cef0; }
.billing-timeline-kicker {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 11.5px; font-weight: 600; color: var(--muted); margin-bottom: 8px;
}
.billing-muted-tag { font-size: 11px; font-weight: 500; color: #8b8b96; }
.billing-node-meta { margin: 0; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
.billing-node-empty-title { margin: 0 0 4px; font-size: 14px; font-weight: 550; color: var(--muted); }

/* Segmented Interval Switch & Purchase Shelf */
.billing-segmented {
  display: inline-flex; align-items: center; padding: 3px; border-radius: 9px;
  background: #efeff2; border: 1px solid var(--line); gap: 2px;
}
.billing-panel .billing-segmented button {
  display: inline-flex; align-items: center; gap: 6px; min-height: 30px; height: 30px;
  padding: 0 11px; border: 0; border-radius: 7px; background: transparent;
  color: var(--muted); font-size: 12.5px; font-weight: 500; white-space: nowrap;
}
.billing-panel .billing-segmented button.is-active {
  background: var(--surface); color: var(--ink); font-weight: 600;
  box-shadow: 0 1px 3px rgba(25, 25, 27, 0.08);
}
.billing-save-tag {
  padding: 1px 6px; border-radius: 999px; background: #ecf7f0; color: #216b46;
  font-size: 11px; font-weight: 600;
}

.billing-panel .billing-card .billing-purchase {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 14px 20px; max-width: none; margin: 0; padding: 15px 18px;
  border-radius: 11px; background: #fafafb; border: 1px solid var(--line);
}
.billing-purchase-info { display: grid; gap: 4px; min-width: 0; }
.billing-purchase-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.billing-plan-name { font-size: 15px; font-weight: 600; color: var(--ink); }
.billing-plan-select { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-size: 12.5px; color: var(--muted); }
.billing-plan-select select { margin: 0; min-width: 180px; min-height: 36px; height: 36px; padding: 0 10px; }
.billing-quote { font-size: 13px; color: var(--muted); }
.billing-quote strong { color: var(--ink); font-variant-numeric: tabular-nums; }

.billing-panel button.billing-primary {
  min-height: 38px; height: 38px; padding: 0 18px; border: 1px solid var(--primary);
  border-radius: 8px; background: var(--primary); color: var(--surface); font-size: 13px; font-weight: 550;
}
.billing-panel button.billing-primary.is-team { background: var(--accent); border-color: var(--accent); }
.billing-panel button.billing-primary.is-danger { background: #a62b33; border-color: #a62b33; }
.billing-panel button.billing-primary:enabled:hover { opacity: 0.9; }

.billing-future-locked {
  padding: 12px 14px; border-radius: 10px; background: #f6f8fe; border: 1px solid #dce3f7;
}
.billing-future-locked p { margin: 0; font-size: 13px; color: #3d4d7c; }
.billing-readonly-plans { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.billing-readonly-plans li {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 14px; border-radius: 9px; background: #fafafb; border: 1px solid var(--line); font-size: 13px;
}
.billing-readonly-plans span { color: var(--muted); font-variant-numeric: tabular-nums; }

/* Unified History Card */
.billing-history-card { padding: 0; overflow: hidden; }
.billing-tabs-bar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 8px 14px; padding: 0 20px; border-bottom: 1px solid var(--line);
}
.billing-tabs { display: flex; gap: 18px; }
.billing-panel button.billing-tab {
  position: relative; display: inline-flex; align-items: center; gap: 6px;
  min-height: 46px; padding: 0 2px; border: 0; border-radius: 0;
  background: transparent; color: var(--muted); font-size: 14px; font-weight: 500;
}
.billing-panel button.billing-tab:hover { color: var(--ink); }
.billing-panel button.billing-tab.is-active { color: var(--ink); font-weight: 600; }
.billing-panel button.billing-tab.is-active::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -1px;
  height: 2px; background: var(--ink); border-radius: 2px 2px 0 0;
}
.billing-tab-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 19px; height: 19px; padding: 0 5px; border-radius: 999px;
  background: #efeff3; color: var(--muted); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.billing-tab.is-active .billing-tab-count { background: var(--ink); color: var(--surface); }

.billing-filter-pills { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0; }
.billing-panel button.billing-filter-pill {
  min-height: 26px; height: 26px; padding: 0 10px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface); color: var(--muted); font-size: 12px; font-weight: 500;
}
.billing-panel button.billing-filter-pill.is-active { background: var(--ink); border-color: var(--ink); color: var(--surface); }

.billing-list { list-style: none; padding: 0; margin: 0; }
.billing-list > li { padding: 16px 20px; border-bottom: 1px solid var(--line); }
.billing-list > li:last-child { border-bottom: 0; }
.billing-row-heading {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; font-size: 13.5px;
}
.billing-order-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.billing-order-price { font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.billing-order-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 18px; margin-top: 10px; }

.billing-order-status {
  display: inline-flex; align-items: center; gap: 5px; height: 23px; padding: 0 9px;
  border-radius: 999px; font-size: 11.5px; font-weight: 500; white-space: nowrap;
  color: var(--muted); background: #efeff2; border: 1px solid #e2e2e7;
}
.billing-order-status[data-status="PAID"] { color: #216b46; background: #ecf7f0; border-color: #cbe8d7; }
.billing-order-status[data-status="PENDING_PAYMENT"] { color: #8a5a10; background: #fff8e6; border-color: #f2dfb3; }
.billing-order-status[data-status="REFUNDED"] { color: #a62b33; background: #fdf1f2; border-color: #f4d3d6; }

.billing-order-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.billing-order-actions:not(:empty) { margin-top: 12px; }
.billing-panel button.billing-action-primary {
  min-height: 32px; height: 32px; padding: 0 12px; border-radius: 7px;
  border: 1px solid var(--primary); background: var(--primary); color: var(--surface); font-size: 12px; font-weight: 500;
}
.billing-panel button.billing-action-danger {
  min-height: 32px; height: 32px; padding: 0 12px; border-radius: 7px;
  border: 1px solid #f4d3d6; background: var(--surface); color: #a62b33; font-size: 12px; font-weight: 500;
}
.billing-panel button.billing-action-danger:enabled:hover { background: #fdf1f2; }

.billing-entry-left { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.billing-ledger-kind {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px;
  background: #efeff2; color: var(--muted); font-size: 11.5px; font-weight: 550;
}
.billing-ledger-kind[data-kind="GRANT"] { background: #ecf7f0; color: #216b46; }
.billing-ledger-kind[data-kind="HOLD"] { background: #fff8e6; color: #8a5a10; }
.billing-ledger-kind[data-kind="RELEASE"] { background: var(--accent-soft); color: var(--accent); }
.billing-ledger-kind[data-kind="REVOKE"] { background: #fdf1f2; color: #a62b33; }
.billing-entry-deltas { font-size: 13px; color: #3f3f46; }
.billing-entry-headline { font-size: 13px; font-variant-numeric: tabular-nums; }
.billing-entry-headline[data-tone="pos"] { color: #216b46; }
.billing-entry-headline[data-tone="neg"] { color: var(--ink); }
.billing-entry-headline[data-tone="muted"] { color: var(--muted); font-weight: 500; }
.billing-entry-meta {
  display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px;
  font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
}

.billing-more-wrap { padding: 14px 20px; border-top: 1px solid var(--line); }
.billing-empty-state { padding: 34px 20px; text-align: center; }
.billing-empty-inline { padding: 8px 0 2px; }
.billing-empty-title { margin: 0 0 4px; font-size: 13.5px; font-weight: 550; color: var(--ink); }
.billing-empty-desc { margin: 0; font-size: 12.5px; color: var(--muted); }

/* Dialog */
.billing-dialog {
  width: min(465px, calc(100vw - 32px)); max-height: 90vh; overflow: auto;
  padding: 0; border: 1px solid var(--line); border-radius: 14px;
  background: var(--surface); color: var(--ink); box-shadow: 0 24px 60px rgba(25, 25, 27, 0.2);
}
.billing-dialog::backdrop { background: rgba(25, 25, 27, 0.4); backdrop-filter: blur(2px); }
.billing-dialog form { margin: 0; max-width: none; }
.billing-dialog-head { padding: 18px 22px 14px; border-bottom: 1px solid var(--line); }
.billing-dialog-head h3 { margin: 0; font-size: 16px; font-weight: 600; }
.billing-dialog-body { padding: 18px 22px; display: grid; gap: 14px; }
.billing-dialog-subject {
  display: flex; align-items: center; gap: 9px; padding: 9px 12px; border-radius: 9px;
  background: #f3f3f6; border: 1px solid var(--line); font-size: 13px;
}
.billing-dialog-subject.is-team { background: var(--accent-soft); border-color: #d5def5; color: #243361; }
.billing-dialog-amount {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 12px 14px; border-radius: 10px; background: #fafafb; border: 1px solid var(--line);
}
.billing-dialog-amount span { font-size: 13px; color: var(--muted); }
.billing-dialog-amount strong { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
.billing-dialog-facts { margin: 0; gap: 8px; font-size: 13px; }
.billing-dialog-facts div { grid-template-columns: 5.5em minmax(0, 1fr); }
.billing-dialog-facts dd { text-align: right; }
.billing-dialog-warn {
  margin: 0; padding: 10px 12px; border-radius: 9px;
  background: #fff8e6; border: 1px solid #f2dfb3; color: #8a5a10; font-size: 12.5px; line-height: 1.5;
}
.billing-dialog-actions {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 14px 22px 18px; border-top: 1px solid var(--line); background: #fafafb;
}

@media (max-width: 960px) {
  .billing-credit-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .billing-credit-main { grid-column: 1 / -1; }
  .billing-timeline, .billing-facts-inline, .billing-order-facts { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 540px) {
  .billing-card { padding: 15px; }
  .billing-history-card { padding: 0; }
  .billing-tabs-bar { padding: 0 14px; }
  .billing-list > li { padding: 14px; }
  .billing-facts div { grid-template-columns: minmax(0, 1fr); gap: 1px; }
  .billing-dialog-facts dd { text-align: left; }
}
</style>
