// Deterministic Billing DTOs for page QA. Auth still verifies each browser subject.
const paymentWindow = 30 * 60 * 1000;
const plans = {
  USER: { planId: "work-personal-test", name: "个人测试套餐", monthlyPriceMinor: 1000, yearlyPriceMinor: 10000, monthlyCredits: 100 },
  TENANT: { planId: "work-team-test", name: "团队测试套餐", monthlyPriceMinor: 3000, yearlyPriceMinor: 30000, monthlyCredits: 500 },
};
const paidLabel = "PAID";
const response = (data, status = 200) => Response.json({ data }, { status });
const error = (status, code) => Response.json({ error: { code } }, { status });

function addMonths(at, months) {
  const date = new Date(at);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return date.setUTCDate(Math.min(day, lastDay));
}

export function billingBrowserFixture(verify, shared) {
  const orders = new Map();
  const ledger = new Map();
  const receipts = new Map();
  let clockOffset = 0;

  function useCredit(ownerId, actorUserId, referenceId) {
    ledger.get(ownerId).unshift({
      id: referenceId, kind: "CONSUME", actorUserId, referenceId, occurredAt: Date.now() + clockOffset,
      deltaGranted: 0, deltaAvailable: -1, deltaReserved: 0, deltaConsumed: 1, deltaExpired: 0,
    });
  }

  async function fetch(request) {
    const url = new URL(request.url);
    const { pathname: path, searchParams: query } = url;
    const requestId = request.headers.get("X-Request-Id");
    const authorization = request.headers.get("Authorization");
    if (!requestId || !authorization || request.headers.get("X-Molis-Internal-Secret") !== shared ||
        ["Cookie", "Origin", "X-CSRF-Token"].some(name => request.headers.has(name))) {
      throw Error("Billing fixture received an invalid private request");
    }
    const ownerId = query.get("ownerId");
    const ownerKind = query.get("ownerKind");
    const product = query.get("product");
    const assertion = await verify({
      method: "POST", headers: {
        "Content-Type": "application/json", Authorization: authorization,
        "X-Request-Id": requestId, "X-Molis-Internal-Secret": shared,
      },
      body: JSON.stringify({ product, owner: { kind: ownerKind, id: ownerId } }),
    });
    if (!assertion.ok) return assertion;
    const { data: { role, userId, owner } } = await assertion.json();
    if (owner.id !== ownerId || owner.kind !== ownerKind) throw Error("Unexpected verified Billing subject");
    const canManage = role !== "MEMBER";
    const subject = { product, ownerKind, ownerId };
    const plan = { ...plans[ownerKind], product, ownerKind, currency: "CNY", planVersion: 1 };
    const now = Date.now() + clockOffset;
    const scopeOrders = [...orders.values()].reverse().filter(order => order.ownerId === ownerId);
    const isRefundable = order => order.status === paidLabel && order.servicePeriod.startsAt > now;
    const orderView = order => ({
      ...order,
      status: order.status === "PENDING_PAYMENT" && order.paymentExpiresAt <= now ? "EXPIRED" : order.status,
      refundable: isRefundable(order),
    });
    const active = scopeOrders.find(order => order.status === paidLabel &&
      order.servicePeriod.startsAt <= now && now < order.servicePeriod.endsAt);
    const next = scopeOrders.find(isRefundable);
    const periodView = order => order ? {
      ...order.servicePeriod, orderId: canManage ? order.id : undefined, planId: order.planId,
      planVersion: order.planVersion, planName: plan.name, interval: order.interval, monthlyCredits: order.monthlyCredits,
    } : null;
    const movements = ledger.get(ownerId) ?? [];
    const page = items => {
      const start = query.has("cursor") ? items.findIndex(item => item.id === query.get("cursor").split(":")[1]) + 1 : 0;
      const limit = Number(query.get("limit") ?? 20);
      const slice = items.slice(start, start + limit);
      return response({ items: slice, nextCursor: start + limit < items.length ? "1:" + slice.at(-1).id : null });
    };

    if (path === "/api/v1/catalog/plans") return response({ items: [plan] });
    if (path === "/api/v1/subscriptions") {
      return response({ ...subject, billingTimeZone: (active ?? next)?.billingTimeZone ?? null,
        currentPeriod: periodView(active), futurePeriod: periodView(next),
        paidThroughAt: (next ?? active)?.servicePeriod.endsAt ?? null });
    }
    if (path === "/api/v1/credits/balance") {
      const available = active ? active.monthlyCredits + movements.filter(item => item.kind === "CONSUME").reduce((total, item) => total + item.deltaAvailable, 0) : 0;
      const currentCreditPeriod = active ? {
        startsAt: active.servicePeriod.startsAt,
        expiresAt: Math.min(addMonths(active.servicePeriod.startsAt, 1), active.servicePeriod.endsAt),
      } : null;
      return response({ ...subject, available, currentCreditPeriod });
    }
    if (path === "/api/v1/credits/ledger") {
      return page(canManage ? movements : movements.filter(entry => entry.actorUserId === userId && entry.kind === "CONSUME"));
    }
    if (!path.startsWith("/api/v1/orders")) return error(404, "NOT_FOUND");
    if (!canManage) return error(403, "FORBIDDEN");
    const [, , , , id, action] = path.split("/");
    const order = scopeOrders.find(order => order.id === id);
    if (request.method === "GET") {
      if (!id) return page(scopeOrders.map(orderView));
      return order ? response(orderView(order)) : error(404, "NOT_FOUND");
    }

    const key = request.headers.get("Idempotency-Key");
    const saved = receipts.get(key);
    if (saved) return response(saved.data, saved.status);
    const commit = (result, status = 200) => {
      const data = structuredClone(orderView(result));
      receipts.set(key, { data, status });
      return response(data, status);
    };
    if (!id) {
      const input = await request.json();
      const result = {
        ...subject, ...input, id: "qa-order-" + (orders.size + 1), actorUserId: userId,
        planVersion: plan.planVersion, currency: plan.currency,
        amountMinor: input.interval === "MONTH" ? plan.monthlyPriceMinor : plan.yearlyPriceMinor,
        monthlyCredits: plan.monthlyCredits, status: "PENDING_PAYMENT",
        createdAt: now, paymentExpiresAt: now + paymentWindow, paidAt: null, refundedAt: null, servicePeriod: null,
      };
      orders.set(result.id, result);
      return commit(result, 201);
    }
    if (!order) return error(404, "NOT_FOUND");
    if (action === "mock-pay") {
      if (order.paymentExpiresAt <= now) return error(409, "ORDER_EXPIRED");
      if (next) return error(409, "RENEWAL_ALREADY_PURCHASED");
      const startsAt = active?.servicePeriod.endsAt ?? now;
      order.status = paidLabel;
      order.paidAt = now;
      order.servicePeriod = { orderId: id, startsAt, endsAt: addMonths(startsAt, order.interval === "MONTH" ? 1 : 12), revokedAt: null };
      if (!active) {
        movements.unshift({ id: "grant-" + id, kind: "GRANT", actorUserId: null, referenceId: id, occurredAt: now,
          deltaGranted: order.monthlyCredits, deltaAvailable: order.monthlyCredits, deltaReserved: 0, deltaConsumed: 0, deltaExpired: 0 });
        ledger.set(ownerId, movements);
      }
      return commit(order);
    }
    if (action === "refund") {
      if (!isRefundable(order)) return error(409, "ORDER_NOT_REFUNDABLE");
      order.status = "REFUNDED";
      order.refundedAt = now;
      order.servicePeriod.revokedAt = now;
      return commit(order);
    }
    return error(404, "NOT_FOUND");
  }

  return {
    fetch, useCredit,
    latest: (ownerId, status) => [...orders.values()].reverse().find(order => order.ownerId === ownerId && order.status === status) ?? null,
    order: id => orders.get(id),
    setClock: timestamp => { clockOffset = timestamp - Date.now(); },
  };
}
