import { dateFormatter as sharedDateFormatter } from "../../shared/format/date.ts";
import { toRefs } from "vue";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { AuthError, type AccountClient } from "../../shared/api/account-client.ts";
import type {
  BillingBalance, BillingInterval, BillingLedgerEntry, BillingOrder, BillingPlan,
  BillingSubscription, CreateBillingOrder,
} from "./billing-types.ts";
import { cursorCollection } from "../../shared/api/cursor-collection.ts";
import { accountErrorMessage } from "../../shared/api/errors.ts";
import { IdempotentSubmit } from "../../shared/api/idempotent-submit.ts";

import { createRequiredContext, type EmitFor } from "../../shared/composables/create-required-context.ts";

export type Props = {
  client: AccountClient;
  viewerId: string;
  ownerName: string;
  tenantId?: string;
  roleLabel?: string;
  canManageOrders: boolean;
};
export type Events = {
  expired: [error: AuthError];
  orderAccessDenied: [];
  summary: [subject: string, value: { active: boolean | null; available: number | null }];
};
type Emit = EmitFor<Events>;

export function useBillingSubject(props: Props, emit: Emit) {
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
    emit("summary", ownerKind === "USER" ? "personal" : ownerId, {
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
  const dateTime = sharedDateFormatter("en-CA", {
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
  const currencies = new Map<string, { format: Intl.NumberFormat; minorUnits: number }>();
  function money(minor: number, currency: string) {
    let entry = currencies.get(currency);
    if (!entry) {
      const format = new Intl.NumberFormat("zh-CN", { style: "currency", currency });
      entry = { format, minorUnits: 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2) };
      currencies.set(currency, entry);
    }
    return entry.format.format(minor / entry.minorUnits);
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
  function refreshFromControl() {
    props.client.invalidateReads("/billing/catalog/plans");
    return refresh();
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
  const maxTimeoutMs = 2 ** 31 - 1;
  function scheduleOrderExpiry(deadline: number) {
    const delay = deadline - Date.now();
    if (delay <= 0) {
      void loadOrders();
      return;
    }
    orderExpiryTimer = setTimeout(() => scheduleOrderExpiry(deadline), Math.min(maxTimeoutMs, delay));
  }
  watch(orderRows, rows => {
    clearTimeout(orderExpiryTimer);
    const now = Date.now();
    const next = Math.min(...rows
      .filter(order => order.status === "PENDING_PAYMENT" && order.paymentExpiresAt > now)
      .map(order => order.paymentExpiresAt));
    if (Number.isFinite(next)) scheduleOrderExpiry(next);
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

  const { ownerName, viewerId } = toRefs(props);
  return { ownerKind, avatarText, effectiveRoleLabel, subjectBadgeText, viewerZone, zoneOffset, panelError, saving, openingOrder, loading, refreshFromControl, notice, actionError, confirmation, canManage, balance, credits, grantedCredits, reservedCredits, consumedCredits, creditPercent, localTime, errors, subscription, plans, quote, hasFuturePeriod, money, interval, intervalName, yearlySavingsMinor, availablePlans, planId, createOrder, orderLabels, orderFilters, orderFilter, orderRows, filteredOrders, nextOrders, nextLedger, activeHistoryTab, historyTab, openOrder, ledger, orders, read, visibleLedger, ledgerChanges, ledgerHeadlineDelta, ledgerLabels, signedCredits, orderPlanName, dialog, cancelConfirmation, confirmOrder, ownerName, viewerId };
}

export const billingPanelContext = createRequiredContext<ReturnType<typeof useBillingSubject>>("BillingPanel");
