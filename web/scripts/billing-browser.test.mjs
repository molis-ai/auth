// Run the built Auth Worker and page in Chrome against an isolated Billing contract fixture.
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compatibilityDate, webAssetConfig } from "../../worker/scripts/environment.mjs";
import { initializeLocalRuntime } from "../../worker/scripts/local-runtime.mjs";
import { billingBrowserFixture } from "./billing-browser-fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { Miniflare, Response: WorkerResponse, convertV4MiniflareOptions } = createRequire(new URL("../../worker/package.json", import.meta.url))("miniflare");
assert.ok(process.env.MOLIS_WORK_SOURCE, "Set MOLIS_WORK_SOURCE to a checkout with the built Chrome test kit");
const workSource = resolve(process.env.MOLIS_WORK_SOURCE);
const load = (source, file) => import(pathToFileURL(join(source, file)).href);
const { ChromeHarness } = await load(workSource, "packages/test-kit/dist/browser/index.js");
const { acquireSlot } = await load(workSource, "scripts/machine-slot.mjs");
await acquireSlot("browser", { label: "Auth subscription browser checks" });

const evidence = process.env.AUTH_BROWSER_EVIDENCE_DIR
  ? resolve(process.env.AUTH_BROWSER_EVIDENCE_DIR)
  : mkdtempSync(join(tmpdir(), "auth-billing-browser-evidence-"));
mkdirSync(evidence, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "auth-billing-chrome-"));
const secret = () => randomBytes(32).toString("base64url");
const shared = secret();
const phones = ["13800000991", "13800000992"];
const trace = [];
const prefix = "/api/account/billing";
let origin, runtime, browser, page, auth, unavailable, identity;
let useMissingBinding = () => false;
let holdResponse;
let handlerError;
const billing = billingBrowserFixture(init => identity.fetch("https://auth.internal/internal/v1/subjects/verify", init), shared);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    const body = [];
    for await (const part of req) body.push(part);
    const billing = url.pathname.startsWith(prefix + "/");
    const target = billing && useMissingBinding(url) ? unavailable : auth;
    if (billing) {
      assert.ok(req.headers.cookie, "billing request carried the browser session");
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers["x-molis-internal-secret"], undefined);
      if (req.method === "POST") {
        assert.ok(req.headers["x-csrf-token"]);
        assert.ok(req.headers["idempotency-key"]);
      }
    }
    const response = await target.fetch(url.href, {
      method: req.method, headers: req.headers, redirect: "manual",
      ...(body.length && { body: Buffer.concat(body) }),
    });
    const result = Buffer.from(await response.arrayBuffer());
    if (billing) {
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("authorization"), null);
      assert.equal(response.headers.get("x-molis-internal-secret"), null);
      const payload = JSON.parse(result.toString());
      assert.doesNotMatch(result.toString(), /"(?:accessToken|refreshToken|idToken)"\s*:/);
      const event = {
        method: req.method, path: url.pathname.slice(prefix.length),
        ownerKind: url.searchParams.get("ownerKind"),
        ownerId: url.searchParams.get("ownerId"),
        cursor: url.searchParams.get("cursor"),
        status: response.status, code: payload.error?.code,
      };
      trace.push(event);
      await holdResponse?.(event);
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(result);
  } catch (error) {
    handlerError = error;
    res.writeHead(500).end("Isolated QA unavailable");
  }
});

function workerModules(source, ...modules) {
  const modulesRoot = join(source, "worker/rust");
  return {
    modulesRoot,
    modules: [...modules.map(path => ({ type: "ESModule", path: join(modulesRoot, path) })),
      { type: "ESModule", path: join(modulesRoot, "build/index.js") },
      { type: "CompiledWasm", path: join(modulesRoot, "build/index_bg.wasm") }],
  };
}
function holdNext(predicate) {
  let reached, release;
  const arrived = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  holdResponse = event => {
    if (!predicate(event)) return;
    holdResponse = undefined;
    reached();
    return gate;
  };
  return {
    wait: () => Promise.race([arrived, new Promise((_, reject) =>
      setTimeout(() => reject(Error("The selected Billing response did not reach the gate")), 6000).unref())]),
    release,
  };
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = "http://127.0.0.1:" + server.address().port;
  const bindings = {
    MOLIS_ENVIRONMENT: "test", MOLIS_INTERNAL_SECRET: shared,
    AUTH_ORIGIN: origin, PROVIDER_STATE_KEY: secret(),
    AUTH_WEB_CLIENT_ID: "molis-auth-web-local", AUTH_WEB_SESSION_KEY: secret(),
    TENANT_CREATION_POLICY: "SELF_SERVICE",
    AUTH_TEST_ADMISSION: JSON.stringify({ emails: [], phones: phones.map(phone => "+86" + phone) }),
    UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
      environmentId: "unified-local", kind: "TEST", authOrigin: origin,
      deliveryMode: "MOCK", providerMode: "MOCK",
    }),
  };
  const authWorker = {
    ...workerModules(root, "src/runtime/entrypoint.js", "src/runtime/internal-transport.js"),
    compatibilityDate, bindings, d1Databases: { DB: "auth-billing-browser" },
    durableObjects: { PASSWORD_KDF: { className: "PasswordKdf", useSQLite: true } },
  };
  const assets = webAssetConfig(join(root, "web/dist"));
  runtime = new Miniflare(convertV4MiniflareOptions({
    d1Persist: false,
    workers: [
      {
        ...authWorker, name: "auth",
        serviceBindings: {
          BILLING: async request => {
            const reply = await billing.fetch(request);
            return new WorkerResponse(await reply.arrayBuffer(), { status: reply.status, headers: reply.headers });
          },
        },
        assets: { ...assets, routerConfig: { has_user_worker: true } },
      },
      { ...authWorker, name: "without-billing" },
      {
        name: "verify-fixture", compatibilityDate, modules: true,
        script: `export default { fetch: (request, env) => env.AUTH.fetch(request) }`,
        serviceBindings: { AUTH: { name: "auth", entrypoint: "AuthInternal" } },
      },
    ],
  }));
  const authDb = await runtime.getD1Database("DB", "auth");
  await initializeLocalRuntime({ env: { DB: authDb } });
  const run = (db, sql, ...params) => db.prepare(sql).bind(...params).run();
  const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();
  await run(authDb, "UPDATE auth_environment SET kind='TEST',auth_origin=?", origin);
  await run(authDb, "UPDATE auth_client SET allowed_origins=?", JSON.stringify([origin]));
  await run(authDb, "UPDATE auth_client SET redirects=?", JSON.stringify([origin + "/account/callback"]));
  auth = { fetch: (url, options) => runtime.dispatchFetch(url, options) };
  unavailable = await runtime.getWorker("without-billing");
  identity = await runtime.getWorker("verify-fixture");
  browser = await ChromeHarness.start(profile);
  page = await browser.page();
  await page.command("Page.enable");
  await page.command("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" });
  await page.viewport(1440, 900);
  await page.command("Page.navigate", { url: origin + "/login" });

  function includes(selector, text) {
    return `Boolean(document.querySelector(${JSON.stringify(selector)})?.innerText.includes(${JSON.stringify(text)}))`;
  }
  const waitText = (selector, text) => page.wait(includes(selector, text));
  const click = async (label, selector = "button") => {
    const button = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(button =>
      button.innerText.trim() === ${JSON.stringify(label)} && !button.disabled && button.getClientRects().length)`;
    await page.wait(`Boolean(${button})`);
    await page.evaluate(`{
      document.querySelector('[data-billing-click]')?.removeAttribute('data-billing-click');
      (${button}).dataset.billingClick = '';
    }`);
    await page.click("[data-billing-click]");
  };
  const nav = (label) => click(label, ".console-tabs button");
  const panel = ".billing-panel";
  const dialog = ".billing-dialog[open]";
  const interval = async (value) => {
    const selector = `.billing-segmented button[data-interval="${value}"]`;
    await page.wait(`Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`);
    await page.click(selector);
  };
  const openHistoryTab = async (prefixText) => {
    const button = `[...document.querySelectorAll('.billing-tab')].find(button =>
      button.innerText.trim().startsWith(${JSON.stringify(prefixText)}) && !button.disabled && button.getClientRects().length)`;
    await page.wait(`Boolean(${button})`);
    await page.evaluate(`{
      document.querySelector('[data-billing-tab]')?.removeAttribute('data-billing-tab');
      (${button}).dataset.billingTab = '';
    }`);
    await page.click("[data-billing-tab]");
  };
  const selectLedger = async (name) => {
    const button = `[...document.querySelectorAll('.billing-rail-item')].find(button =>
      button.querySelector('.billing-rail-name')?.innerText.trim() === ${JSON.stringify(name)})`;
    await page.wait(`Boolean(${button})`);
    await page.evaluate(`(${button}).click()`);
  };
  const save = name => page.screenshot(join(evidence, name + ".png"));
  const assertAbsent = async (selector) => assert.equal(await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), false);
  const waitReady = () => page.wait("Boolean(document.querySelector('.billing-header button:enabled'))");
  const currentOrder = billing.latest;
  const login = async (phone) => {
    await run(authDb, "UPDATE auth_rate_bucket SET expires_at=0");
    await page.wait("Boolean(document.querySelector('.auth-entry input[autocomplete=username]'))");
    await click("手机验证");
    await page.fill("input[type=tel]", phone);
    await click("继续");
    await page.wait("Boolean(document.querySelector('input[autocomplete=one-time-code]'))");
    const delivery = await first(authDb, "SELECT credential FROM auth_mock_delivery WHERE destination=? ORDER BY created_at DESC LIMIT 1", "+86" + phone);
    await page.fill("input[autocomplete=one-time-code]", delivery.credential);
    await click("验证");
    await waitText(".console-tabs", "个人资料");
    await page.wait("Boolean(document.querySelector('.profile-identity'))");
    return (await first(authDb, "SELECT user_id FROM auth_user_phone WHERE canonical_phone=?", "+86" + phone)).user_id;
  };
  const logout = async () => {
    await page.click('[aria-label="账号菜单"]');
    await click("退出登录");
    await page.wait("Boolean(document.querySelector('.auth-entry input[autocomplete=username]'))");
    await assertAbsent(panel);
  };
  const createTeam = async (name) => {
    await click("＋ 创建团队");
    await page.fill("#tenant-create-name", name);
    await click("创建", ".tenant-create-dialog button");
    await waitText(".tm-heading", name);
    return (await first(authDb, "SELECT id FROM auth_tenant WHERE name=?", name)).id;
  };

  const buyer = await login(phones[0]);
  assert.equal(trace.length, 0, "login and profile never read Billing");
  useMissingBinding = () => true;
  await nav("订阅与账单");
  await waitText(".billing-panel > [role=alert]", "账务服务暂时不可用");
  await assertAbsent(".billing-credit");
  assert.ok(trace.some(item => item.code === "BILLING_UNAVAILABLE" && item.status === 503));
  await save("A11-missing-binding");
  await nav("个人资料");
  await page.wait("Boolean(document.querySelector('.profile-identity'))");
  const beforeTenantSetup = trace.length;
  await nav("团队");
  const managerTeam = await createTeam("账单验收团队");
  const otherTeam = await createTeam("独立账单团队");
  await waitText(".tm-tabs [aria-current]", "成员管理");
  assert.equal(trace.length, beforeTenantSetup);
  useMissingBinding = () => false;

  await nav("订阅与账单");
  await waitText(".billing-rail", "账单验收团队");
  await waitText(".billing-subscription", "暂无生效套餐");
  await waitText(".billing-credit", "0 Credit");
  await waitText(".billing-quote", "10.00");
  await click("创建订单");
  await waitText(dialog, "100 Credit");
  const firstOrder = currentOrder(buyer, "PENDING_PAYMENT");
  assert.equal(firstOrder.amountMinor, 1000);
  assert.equal(firstOrder.interval, "MONTH");
  assert.equal(firstOrder.billingTimeZone, "Asia/Shanghai");
  assert.equal(currentOrder(buyer, "PAID"), null);
  assert.equal(firstOrder.servicePeriod, null);
  await waitText(".billing-subscription", "暂无生效套餐");
  await waitText(".billing-credit", "0 Credit");
  await click("确认模拟支付", dialog + " button");
  await waitText(".billing-notice", "支付成功");
  await waitText(".billing-credit", "100 Credit");
  await waitText(".billing-subscription", "UTC+08:00");
  await waitText(".billing-orders", "支付成功");
  const paid = currentOrder(buyer, "PAID");
  assert.equal(paid.servicePeriod.startsAt, paid.paidAt);
  const originalPaidThrough = await page.evaluate("document.querySelector('.billing-paid-through dd').innerText");
  await assertAbsent(".billing-orders button");
  await save("A02-personal-paid");
  await page.command("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
  await nav("个人资料");
  await nav("订阅与账单");
  await waitText(".billing-subscription", "America/New_York，UTC-");
  assert.equal(paid.billingTimeZone, "Asia/Shanghai");
  await page.command("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" });
  await nav("个人资料");
  await nav("订阅与账单");
  await waitText(".billing-subscription", "UTC+08:00");
  console.log("PASS A02 personal monthly checkout, payment timestamp, ¥10 and 100 Credit");

  await waitReady();
  await interval("YEAR");
  await click("创建续费订单");
  await waitText(dialog, "100.00");
  const renewal = currentOrder(buyer, "PENDING_PAYMENT");
  const deadline = await page.evaluate("document.querySelector('.billing-dialog dl > div:last-child dd').innerText");
  await click("关闭", dialog + " button");
  await logout();
  assert.equal(await login(phones[0]), buyer);
  await nav("订阅与账单");
  await click("继续付款");
  await waitText(dialog, renewal.id);
  assert.equal(await page.evaluate("document.querySelector('.billing-dialog dl > div:last-child dd').innerText"), deadline);
  assert.equal((currentOrder(buyer, "PENDING_PAYMENT")).paymentExpiresAt, renewal.paymentExpiresAt);
  await save("A04-resume-locked-quote");
  await click("关闭", dialog + " button");
  await waitReady();
  await click("创建续费订单");
  await waitText(dialog, "10.00");
  const monthlyRenewal = currentOrder(buyer, "PENDING_PAYMENT");
  assert.notEqual(monthlyRenewal.id, renewal.id);
  assert.equal(monthlyRenewal.amountMinor, 1000);
  await click("确认模拟支付", dialog + " button");
  await waitText(".billing-future", monthlyRenewal.id);
  await waitText(".billing-credit", "100 Credit");
  assert.notEqual(await page.evaluate("document.querySelector('.billing-paid-through dd').innerText"), originalPaidThrough);
  await click("申请退款");
  await waitText(dialog, "退款将撤回本订单的下期服务");
  await waitText(dialog, "10.00");
  await save("A07-refund-confirm");
  await click("确认退款", dialog + " button");
  await waitText(".billing-notice", "已退款");
  await waitText(".billing-credit", "100 Credit");
  await waitText(".billing-orders", "退款金额");
  assert.equal(await page.evaluate("document.querySelector('.billing-paid-through dd').innerText"), originalPaidThrough);
  await assertAbsent(".billing-future");
  assert.equal((currentOrder(buyer, "REFUNDED")).id, monthlyRenewal.id);
  assert.equal((currentOrder(buyer, "PAID")).id, paid.id);
  await save("A07-refunded");
  console.log("PASS A07 renewal appears immediately, pre-start refund restores paid-through and preserves the active order and balance");

  await click("继续付款");
  await waitText(dialog, renewal.id);
  await click("确认模拟支付", dialog + " button");
  await waitText(".billing-future", renewal.id);
  assert.equal((currentOrder(buyer, "PAID")).id, renewal.id);

  // Verify switching to a team ledger directly inside the unified Billing Center left rail.
  await selectLedger("独立账单团队");
  await waitText(".billing-header h2", "独立账单团队");
  await waitText(".billing-credit", "0 Credit");
  await waitText(".billing-quote", "30.00");
  await selectLedger("Molis 用户");
  await waitText(".billing-credit", "100 Credit");
  await waitText(".billing-future", renewal.id);

  // Keep a pending order while the fixture clock reaches its original deadline.
  await click("申请退款");
  await waitText(dialog, renewal.id);
  await click("确认退款", dialog + " button");
  await waitText(".billing-notice", "已退款");
  await click("创建续费订单");
  await waitText(dialog, "10.00");
  const expiring = currentOrder(buyer, "PENDING_PAYMENT");
  billing.setClock(expiring.paymentExpiresAt);
  await click("确认模拟支付", dialog + " button");
  await waitText(".billing-panel > [role=alert]", "订单超时");
  await page.wait("Boolean(document.querySelector('.billing-order-status[data-status=EXPIRED]'))");
  assert.ok(trace.some(item => item.status === 409 && item.code === "ORDER_EXPIRED"));
  await page.evaluate("document.querySelector('.billing-order-status[data-status=EXPIRED]').scrollIntoView({block:'center'})");
  await save("A04-expired");
  console.log("PASS A04 logout/relogin, same quote and deadline, alternate pending order, 409 and expired list status");

  await nav("团队");
  await waitText(".tenant-directory", "账单验收团队");
  const selectTeam = async (name) => {
    const expression = `[...document.querySelectorAll('.tenant-choice')].find(button =>
      button.querySelector('.tenant-choice-name').innerText === ${JSON.stringify(name)})`;
    await page.wait(`Boolean(${expression})`);
    await page.evaluate(`(${expression}).click()`);
    await waitText(".tm-heading", name);
  };
  await selectTeam("账单验收团队");
  await click("套餐与账单");
  await waitText(".tm-heading", "账单验收团队");
  await interval("YEAR");
  await click("创建订单");
  await waitText(dialog, "300.00");
  await click("确认模拟支付", dialog + " button");
  await waitText(".billing-credit", "500 Credit");
  await waitText(".billing-orders", "支付成功");
  await waitText(".billing-subscription", "已付至");
  const teamPaidThrough = await page.evaluate("document.querySelector('.billing-paid-through dd').innerText");
  const teamAnnual = currentOrder(managerTeam, "PAID");
  assert.equal(teamAnnual.amountMinor, 30000);
  assert.equal(teamAnnual.interval, "YEAR");
  await assertAbsent(".billing-orders button");
  await save("A09-manager");
  await waitReady();
  await interval("MONTH");
  await click("创建续费订单");
  await waitText(dialog, "30.00");
  const teamPending = currentOrder(managerTeam, "PENDING_PAYMENT");
  await click("关闭", dialog + " button");
  await waitReady();

  const hold = holdNext(event => event.ownerId === managerTeam && event.path === "/credits/balance");
  await click("刷新账单");
  await hold.wait();
  const nextBalance = holdNext(event => event.ownerId === otherTeam && event.path === "/credits/balance");
  await selectTeam("独立账单团队");
  await waitText(".tm-heading", "独立账单团队");
  await nextBalance.wait();
  await assertAbsent(".billing-credit");
  hold.release();
  await page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await assertAbsent(".billing-credit");
  assert.equal(await page.evaluate(includes(panel, teamPending.id)), false);
  nextBalance.release();
  await waitText(".billing-credit", "0 Credit");
  await selectTeam("账单验收团队");
  await waitText(".billing-credit", "500 Credit");
  await waitReady();

  useMissingBinding = url => url.pathname.endsWith("/credits/balance");
  await click("刷新账单");
  await waitText(".billing-balance [role=alert]", "账务服务暂时不可用");
  await waitText(".billing-subscription", "已付至");
  await assertAbsent(".billing-credit");
  await waitReady();
  await save("A11-balance-retry");
  useMissingBinding = () => false;
  const retryTraceStart = trace.length;
  await click("重试余额");
  await waitText(".billing-credit", "500 Credit");
  await waitReady();
  assert.deepEqual(trace.slice(retryTraceStart).map(item => item.path), ["/credits/balance"]);
  await run(authDb, "UPDATE auth_tenant SET status='DISABLED' WHERE id=?", managerTeam);
  await click("刷新账单");
  await waitText(".billing-panel > [role=alert]", "团队已停用");
  await assertAbsent(".billing-credit");
  assert.ok(trace.some(item => item.code === "TENANT_DISABLED" && item.status === 403));
  await run(authDb, "UPDATE auth_tenant SET status='ACTIVE' WHERE id=?", managerTeam);
  await click("重试账单");
  await waitText(".billing-credit", "500 Credit");
  await waitText(".billing-subscription", "已付至");
  assert.equal(await page.evaluate("document.querySelector('.billing-paid-through dd').innerText"), teamPaidThrough);
  await click("成员管理");
  await page.wait("Boolean(document.querySelector('.tm-table-wrap').getClientRects().length)");
  await assertAbsent(panel);
  console.log("PASS A11 missing binding, local balance retry, disable/restore and late team response");

  // Keep a real member and administrator on the same team for the visibility checks.
  await run(authDb, "UPDATE auth_tenant_membership SET role='MEMBER' WHERE tenant_id=? AND user_id=?", managerTeam, buyer);
  await run(authDb, "INSERT INTO auth_user(id,display_name,status,created_at,updated_at) VALUES ('fixture-colleague','验收同事','ACTIVE',0,0)");
  await run(authDb, "INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at) VALUES ('fixture-coworker',?,'fixture-colleague','OWNER','ACTIVE',0)", managerTeam);
  billing.useCredit(managerTeam, buyer, "my-work-task");
  billing.useCredit(managerTeam, "fixture-colleague", "other-work-task");
  await nav("个人资料");
  await nav("团队");
  await selectTeam("账单验收团队");
  const memberTraceStart = trace.length;
  await click("套餐与账单");
  await waitText(".billing-credit", "498 Credit");
  await waitText(".billing-ledger", "my-work-task");
  assert.equal(await page.evaluate(includes(panel, "other-work-task")), false);
  assert.equal(await page.evaluate(includes(panel, "发放")), false);
  assert.equal(await page.evaluate(includes(panel, teamPending.id)), false);
  await assertAbsent(".billing-orders");
  await assertAbsent(".billing-purchase");
  assert.equal(trace.slice(memberTraceStart).some(item => item.path.startsWith("/orders")), false);
  await page.viewport(390, 900);
  assert.ok(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"));
  await save("A09-member-390");
  await page.evaluate("document.querySelector('.billing-balance').scrollIntoView({block:'start'})");
  await save("A09-member-credit-390");
  await page.viewport(1440, 900);
  await run(authDb, "UPDATE auth_tenant_membership SET status='LEFT',ended_at=? WHERE tenant_id=? AND user_id=?", Date.now(), managerTeam, buyer);
  await click("刷新账单");
  await waitText(".billing-panel > [role=alert]", "无法访问");
  await assertAbsent(".billing-credit");
  assert.ok(trace.some(item => item.ownerId === managerTeam && item.status === 404));
  await logout();
  const admin = await login(phones[1]);
  assert.notEqual(admin, buyer);
  await nav("订阅与账单");
  await waitText(".billing-credit", "0 Credit");
  assert.equal(await page.evaluate(includes(panel, paid.id)), false);
  await run(authDb, "INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at) VALUES ('fixture-admin',?,?,'ADMIN','ACTIVE',0)", managerTeam, admin);
  await nav("团队");
  await selectTeam("账单验收团队");
  await click("套餐与账单");
  await openHistoryTab("Credit 流水");
  await waitText(".billing-ledger", "other-work-task");
  await waitText(".billing-ledger", "my-work-task");
  await waitText(".billing-ledger", "操作者 其他成员");
  assert.equal(await page.evaluate(includes(".billing-ledger", "fixture-colleague")), false);
  await waitText(".billing-ledger", "发放");
  await openHistoryTab("订单");
  await click("继续付款");
  await waitText(dialog, teamPending.id);
  await click("确认模拟支付", dialog + " button");
  await waitText(".billing-future", teamPending.id);
  assert.equal(billing.order(teamPending.id).status, "PAID");
  await click("申请退款");
  await waitText(dialog, teamPending.id);
  billing.setClock(teamPending.servicePeriod.startsAt);
  await click("确认退款", dialog + " button");
  await waitText(".billing-panel > [role=alert]", "当前不可退款");
  assert.ok(trace.some(item => item.code === "ORDER_NOT_REFUNDABLE" && item.status === 409));
  assert.equal(billing.order(teamPending.id).status, "PAID");
  console.log("PASS A09 member-only usage, admin ledger and former member order; A07 service-start refusal");

  await waitReady();
  await run(authDb, "UPDATE auth_tenant_membership SET role='MEMBER' WHERE tenant_id=? AND user_id=?", managerTeam, admin);
  billing.useCredit(managerTeam, admin, "my-work-after-downgrade");
  const downgradeTraceStart = trace.length;
  await click("刷新账单");
  await waitText(".tm-heading p", "成员 ·");
  await waitText('.tenant-choice[aria-current=true] span:last-child', "成员 · 正常");
  await waitText(".billing-ledger", "my-work-after-downgrade");
  await waitReady();
  assert.ok(trace.slice(downgradeTraceStart).some(item => item.path === "/orders" && item.status === 403));
  await assertAbsent(".billing-orders");
  await assertAbsent(".billing-purchase");
  assert.equal(await page.evaluate(includes(panel, "other-work-task")), false);
  assert.equal(await page.evaluate(includes(panel, "发放")), false);
  assert.equal(await page.evaluate(includes(panel, teamPending.id)), false);
  await page.evaluate("document.querySelector('.billing-ledger').scrollIntoView({block:'center'})");
  await save("A09-role-downgraded");
  await click("成员管理");
  await page.wait("document.querySelector('.tm-self')?.closest('tr')?.cells[2].innerText === '成员'");
  await assertAbsent(".tm-tools .tm-primary");
  console.log("PASS A09 open billing panel clears order controls and unrelated ledger on role downgrade");

  assert.ifError(handlerError);
  writeFileSync(join(evidence, "billing-requests.json"), JSON.stringify(trace, null, 2) + "\n");
  console.log("Browser evidence " + evidence);
} catch (error) {
  if (page) {
    await page.screenshot(join(evidence, "billing-failure.png")).catch(() => {});
    console.error(await page.evaluate("document.querySelector('main')?.innerText").catch(() => ""));
  }
  writeFileSync(join(evidence, "billing-requests.json"), JSON.stringify(trace, null, 2) + "\n");
  throw handlerError ?? error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await runtime?.dispose();
  rmSync(profile, { recursive: true, force: true });
}
