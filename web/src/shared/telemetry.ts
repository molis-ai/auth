const PATH = "/api/account/telemetry";
const BATCH_SIZE = 16;
const DETAIL_LIMIT = 20;
const FLUSH_DELAY_MS = 3000;
const ENDPOINTS = new Set([
  "/session", "/auth/login/password", "/auth/login/code", "/auth/verification-codes",
  "/auth/transactions", "/tenants", "/tenant-creation-policy", "/login-methods",
  "/billing/catalog/plans", "/billing/subscriptions", "/billing/orders",
  "/billing/credits/balance", "/billing/credits/ledger",
]);
const CODES = new Set([
  "AUTH_UNAVAILABLE", "BILLING_UNAVAILABLE", "INVALID_RESPONSE", "NETWORK_ERROR", "TIMEOUT",
  "RATE_LIMITED", "NOT_FOUND", "FORBIDDEN", "SESSION_EXPIRED", "UNAUTHENTICATED",
]);
const ERROR_NAMES = new Set([
  "Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "AbortError", "ChunkLoadError",
]);
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

type ErrorKind = "js_error" | "unhandled_rejection" | "vue_error" | "chunk_load";
type PopupOutcome = "started" | "completed" | "closed" | "blocked" | "retry_started" | "failed";
type Detail =
  | { kind: "error"; error_kind: ErrorKind; name: string; view: string }
  | { kind: "oauth_popup"; provider: string; outcome: PopupOutcome }
  | { kind: "api_issue"; endpoint: string; status: number; error_code: string; degraded: boolean;
      duration_ms: number; parent_request_id?: string };

type BrowserMetric = PerformanceEntry & {
  responseStart?: number; activationStart?: number; value?: number; hadRecentInput?: boolean;
  interactionId?: number;
};

let details: Detail[] | undefined;
let detailsSent = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let collectPerformance = false;
const chunkErrors = new WeakSet<object>();
let hadError = false;
const cache = new Map<string, { hits: number; misses: number }>();

function push(event: Detail) {
  if (!details || detailsSent + details.length >= DETAIL_LIMIT) return;
  details.push(event);
  flushTimer ??= setTimeout(flushDetails, FLUSH_DELAY_MS);
}

function send(events: unknown[]) {
  for (let offset = 0; offset < events.length; offset += BATCH_SIZE) {
    const body = new Blob([JSON.stringify(events.slice(offset, offset + BATCH_SIZE))], { type: "application/json" });
    navigator.sendBeacon(PATH, body);
  }
}

function flushDetails() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!details?.length) return;
  send(details);
  detailsSent += details.length;
  details.length = 0;
}

function endpoint(path: string) {
  const [resource] = path.split("?", 1);
  if (ENDPOINTS.has(resource)) return resource;
  const order = /^\/billing\/orders\/[^/]+(\/(?:mock-pay|refund))?$/.exec(resource);
  return order ? `/billing/orders/{id}${order[1] ?? ""}` : "other";
}

function currentView() {
  if (location.pathname !== "/console") return "login";
  const page = new URLSearchParams(location.search).get("page") ?? "";
  if (page === "subscriptions") return "billing";
  if (page === "security") return "security";
  if (page.startsWith("platform-") || page === "audit") return "platform";
  if (page === "tenant" || page === "pending") return "team";
  return "account";
}

export function reportBrowserError(kind: ErrorKind, error?: unknown) {
  if (!details) return;
  hadError = true;
  if (error && typeof error === "object") {
    if (chunkErrors.has(error)) return;
    if (kind === "chunk_load") chunkErrors.add(error);
  }
  const name = error instanceof Error ? error.name : "Other";
  push({ kind: "error", error_kind: kind, name: ERROR_NAMES.has(name) ? name : "Other", view: currentView() });
}

export function reportPopup(provider: string, outcome: PopupOutcome) {
  if (provider === "GOOGLE" || provider === "GITHUB")
    push({ kind: "oauth_popup", provider: provider.toLowerCase(), outcome });
}

export function reportApiIssue(path: string, status: number, code: string, started: number, requestId: string) {
  if (!details || (status !== 0 && (status < 400 || status >= 600))) return;
  push({ kind: "api_issue", endpoint: endpoint(path), status,
    error_code: CODES.has(code) ? code : "OTHER", degraded: false,
    duration_ms: Math.min(120_000, Math.max(0, Math.round(performance.now() - started))),
    ...(UUID.test(requestId) ? { parent_request_id: requestId } : {}),
  });
}

export function markApiDegraded(path: string, requestId: string) {
  if (!details) return;
  const route = endpoint(path);
  for (let index = details.length - 1; index >= 0; index--) {
    const item = details[index];
    if (item.kind === "api_issue" && item.endpoint === route && (item.parent_request_id ?? "") === requestId) {
      item.degraded = true;
      break;
    }
  }
}

export function reportCache(path: string, hit: boolean) {
  if (!collectPerformance) return;
  const route = endpoint(path);
  const entry = cache.get(route) ?? { hits: 0, misses: 0 };
  const key = hit ? "hits" : "misses";
  if (entry[key] < 1000) entry[key]++;
  cache.set(route, entry);
}

function collectVitals() {
  const values: Record<string, number> = {};
  const observers: { observer: PerformanceObserver; handle(rows: BrowserMetric[]): void }[] = [];
  function observe(type: string, handle: (rows: BrowserMetric[]) => void, durationThreshold?: number) {
    if (!globalThis.PerformanceObserver?.supportedEntryTypes?.includes(type)) return;
    try {
      const observer = new PerformanceObserver(list => handle(list.getEntries() as BrowserMetric[]));
      observer.observe({ type, buffered: true, ...(durationThreshold === undefined ? {} : { durationThreshold }) });
      observers.push({ observer, handle });
    } catch { /* An unavailable observer does not affect the page. */ }
  }
  const navigation = performance.getEntriesByType("navigation")[0] as BrowserMetric | undefined;
  if (navigation?.responseStart) values.TTFB = Math.max(0, navigation.responseStart - (navigation.activationStart ?? 0));
  observe("paint", rows => { for (const row of rows) if (row.name === "first-contentful-paint") values.FCP = row.startTime; });
  observe("largest-contentful-paint", rows => { const last = rows.at(-1); if (last) values.LCP = last.startTime; });
  let firstShift = 0, lastShift = 0, windowSum = 0;
  if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes("layout-shift")) values.CLS = 0;
  observe("layout-shift", rows => {
    for (const row of rows) {
      if (row.hadRecentInput || typeof row.value !== "number") continue;
      if (!lastShift || row.startTime - lastShift > 1000 || row.startTime - firstShift > 5000) {
        firstShift = row.startTime; windowSum = 0;
      }
      lastShift = row.startTime;
      windowSum += row.value;
      values.CLS = Math.max(values.CLS ?? 0, windowSum);
    }
  });
  const interactions = new Map<number, number>();
  observe("event", rows => {
    for (const row of rows) if (row.interactionId) {
      const id = row.interactionId;
      interactions.set(id, Math.max(interactions.get(id) ?? 0, row.duration));
      if (interactions.size > 10) {
        let fastest = id;
        for (const [candidate, duration] of interactions) {
          if (duration < (interactions.get(fastest) ?? Infinity)) fastest = candidate;
        }
        interactions.delete(fastest);
      }
    }
  }, 16);
  return () => {
    for (const { observer, handle } of observers) {
      handle(observer.takeRecords() as BrowserMetric[]);
      observer.disconnect();
    }
    const count = (performance as Performance & { interactionCount?: number }).interactionCount;
    if (count && interactions.size) {
      const candidates = [...interactions.values()].sort((a, b) => b - a);
      values.INP = candidates[Math.min(candidates.length - 1, Math.floor(count / 50))];
    }
    return values;
  };
}

export function startBrowserTelemetry() {
  const environment = document.querySelector<HTMLMetaElement>('meta[name="molis-environment"]')?.content;
  if (details || typeof navigator.sendBeacon !== "function") return;
  const sampled = environment?.startsWith("TEST") || environment?.startsWith("DEV") || Math.random() < 0.1;
  const page = currentView() === "login" ? "login" : "account";
  details = [];
  let finishVitals: ReturnType<typeof collectVitals> | undefined;
  let reportedPerformance = false;

  const startVitals = () => {
    if (!sampled || reportedPerformance || finishVitals || document.visibilityState !== "visible") return;
    collectPerformance = true;
    finishVitals = collectVitals();
  };
  startVitals();

  window.addEventListener("error", (event: Event) => {
    if (event instanceof ErrorEvent) reportBrowserError("js_error", event.error);
    else if (event.target instanceof HTMLScriptElement &&
      event.target.src.startsWith(`${location.origin}/auth-ui/assets/`)) reportBrowserError("chunk_load");
  }, { capture: true });
  window.addEventListener("unhandledrejection", event => reportBrowserError("unhandled_rejection", event.reason));
  window.addEventListener("vite:preloadError", event =>
    reportBrowserError("chunk_load", (event as Event & { payload?: unknown }).payload));
  const flush = () => {
    flushDetails();
    if (!finishVitals) return;
    send([
      { kind: "session", page, outcome: hadError ? "error" : "clean" },
      ...Object.entries(finishVitals()).map(([metric, value]) => ({ kind: "vital", page, metric, value })),
      ...Array.from(cache, ([endpoint, counts]) => ({ kind: "cache", endpoint, ...counts })),
    ]);
    finishVitals = undefined;
    reportedPerformance = true;
    collectPerformance = false;
    cache.clear();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
    else startVitals();
  });
  window.addEventListener("pagehide", flush);
}
