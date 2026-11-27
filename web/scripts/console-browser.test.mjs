// V2U-03/05/07: real Auth WASM/D1 and Chrome; temporary data, explicit mock delivery only.
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import policy from "../../contracts/unified-account/policy.json" with { type: "json" };
import { bootstrapPlatform } from "../../worker/scripts/platform-bootstrap.mjs";
import { authenticatedLoginEntryCheck, loginEntryChecks, loginEntryFixtures } from "./login-entry-checks.mjs";
const workRoot = process.env.MOLIS_WORK_SOURCE;
assert.ok(
  workRoot,
  "MOLIS_WORK_SOURCE must identify a built Work checkout for its public test-kit and machine slot",
);
const { ChromeHarness } = await import(
  pathToFileURL(
    join(resolve(workRoot), "packages/test-kit/dist/browser/index.js"),
  ).href
);
const { acquireSlot } = await import(
  pathToFileURL(join(resolve(workRoot), "scripts/machine-slot.mjs")).href
);
await acquireSlot("browser", { label: "Auth V2 browser regression" });
import {
  getRustProxy,
  initializeLocalRuntime,
} from "../../worker/scripts/local-runtime.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const evidence = process.env.AUTH_BROWSER_EVIDENCE_DIR
  ? resolve(process.env.AUTH_BROWSER_EVIDENCE_DIR)
  : mkdtempSync(join(tmpdir(), "auth-v2-browser-evidence-"));
mkdirSync(evidence, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "auth-v2-chrome-"));
let proxy, browser, page, origin;
const requests = [];
const scripts = new Set();
const memberReads = [];
const entryFixtures = loginEntryFixtures();
const server = http.createServer(async (req, res) => {
  try {
    const parts = [];
    for await (const p of req) parts.push(p);
    const url = new URL(origin + req.url);
    const r = await entryFixtures.fetch(req.method, url.pathname, () =>
      proxy.fetch(
        new Request(url, {
          method: req.method,
          headers: req.headers,
          ...(["GET", "HEAD"].includes(req.method)
            ? {}
            : { body: Buffer.concat(parts) }),
        }),
      ),
    );
    requests.push({method:req.method,path:url.pathname,status:r.status});
    if (r.ok && url.pathname.endsWith(".js")) scripts.add(url.pathname);
    if (req.method === "GET" && /^\/api\/account\/tenants\/[^/]+\/members$/.test(url.pathname)) {
      memberReads.push(url.searchParams);
    }
    if(requests.length>30)requests.shift();
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (error) {
    res.writeHead(500).end("Isolated QA unavailable");
  }
});
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = "http://127.0.0.1:" + server.address().port;
  proxy = await getRustProxy(
    {
      AUTH_ORIGIN: origin,
      PROVIDER_STATE_KEY: randomBytes(32).toString("base64url"),
      AUTH_WEB_CLIENT_ID: "molis-auth-web-local",
      AUTH_WEB_SESSION_KEY: randomBytes(32).toString("base64url"),
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
        environmentId: "unified-local",
        kind: "LOCAL",
        authOrigin: origin,
        providerMode: "MOCK",
        deliveryMode: "MOCK",
      }),
    },
    undefined,
    undefined,
    { assetsDirectory: join(root, "web/dist") },
  );
  await initializeLocalRuntime(proxy);
  // ENTRY-04: an alias document redirects before login; cross-origin writes remain denied.
  const alias = origin.replace('127.0.0.1', 'localhost');
  const aliasPage = await proxy.fetch(new Request(alias + '/login'));
  assert.equal(aliasPage.status, 302);
  assert.equal(aliasPage.headers.get('Location'), origin + '/login');
  const aliasWrite = await proxy.fetch(new Request(alias + '/api/account/auth/transactions', {method:'POST', headers:{Origin:alias,'Content-Type':'application/json'},body:'{}'}));
  assert.equal(aliasWrite.status, 403);

  const db = proxy.env.DB;
  await db
    .prepare("UPDATE auth_environment SET auth_origin=?")
    .bind(origin)
    .run();
  await db
    .prepare("UPDATE auth_client SET redirects=?")
    .bind(JSON.stringify([origin + "/account/callback"]))
    .run();
  await db
    .prepare("UPDATE auth_client SET allowed_origins=?")
    .bind(JSON.stringify([origin]))
    .run();
  browser = await ChromeHarness.start(profile);
  assert.ok(browser);
  page = await browser.page();
  await page.command("Page.enable");
  await page.viewport(1440, 900);
  await loginEntryChecks({ page, origin, fixtures: entryFixtures, evidence });
  await page.command("Page.addScriptToEvaluateOnNewDocument", {source: `{
    const original = window.fetch;
    const trace = window.__authPerformance = {requests: [], gates: {}, holdNext: []};
    const firstDocument = location.search === '?check=startup-failure';
    const authenticatedProbe = location.search === '?check=authenticated-startup';
    const logoutProbe = location.search === '?check=logout-activity';
    const hold = async (name, signal) => {
      let cancel;
      try {
        await new Promise((resolve, reject) => {
          cancel = () => reject(signal.reason);
          signal?.throwIfAborted();
          signal?.addEventListener('abort', cancel, {once: true});
          trace.gates[name] = resolve;
        });
      } finally {
        signal?.removeEventListener('abort', cancel);
        delete trace.gates[name];
      }
    };
    window.fetch = async (url, options) => {
      const path = new URL(url, location.href).pathname.replace(/^\\/api\\/account/, '');
      const entry = {path, query: new URL(url, location.href).search, method: options?.method ?? 'GET', started: performance.now()};
      trace.requests.push(entry);
      if (firstDocument && path === '/session' && trace.requests.length === 1) {
        await hold('startup', options?.signal);
        return Response.json({error: {code: 'AUTH_UNAVAILABLE'}}, {status: 503});
      }
      const scheduled = entry.method === 'GET' ? trace.holdNext.indexOf(path) : -1;
      if (scheduled !== -1) trace.holdNext.splice(scheduled, 1);
      const response = await original(url, options);
      entry.status = response.status;
      if (scheduled !== -1 || ((authenticatedProbe && ['/activity', '/login-methods'].includes(path) ||
          logoutProbe && path === '/activity') && trace.requests.filter(item => item.path === path).length === 1)) {
        const abort = () => { entry.aborted = performance.now(); };
        options?.signal?.addEventListener('abort', abort, {once: true});
        try { await hold(path, options?.signal); }
        finally { options?.signal?.removeEventListener('abort', abort); }
      }
      entry.finished = performance.now();
      return response;
    };
  }`});
  await page.command("Page.navigate", { url: origin + "/?check=startup-failure" });
  await page.wait(
    "Boolean(window.__authPerformance?.gates.startup && document.querySelector('.session-startup [role=status]'))",
  );
  assert.equal(await page.evaluate("Boolean(document.querySelector('.auth-entry'))"), false);
  await page.evaluate("window.__authPerformance.gates.startup()");
  await page.wait("Boolean(document.querySelector('.session-startup [role=alert]'))");
  assert.equal(await page.evaluate("Boolean(document.querySelector('.auth-entry'))"), false);
  await page.click(".session-startup button");
  const click = async (text) => {
    if(text.startsWith('绑定') && text !== '绑定') await click('登录方式');
    if(['退出登录','切换账号'].includes(text)) await page.click('[aria-label="账号菜单"]');
    await page.wait(
      `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled&&b.getClientRects().length)`,
    );
    await page.evaluate(
      `{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled&&b.getClientRects().length);if(!b)throw Error('Missing '+${JSON.stringify(text)});document.querySelectorAll('[data-qa-click]').forEach(b=>b.removeAttribute('data-qa-click'));b.dataset.qaClick='';}`,
    );
    await page.click("[data-qa-click]");
  };
  const fillLabel = async (text, value, scope = "main") => {
    const field = `[...document.querySelectorAll(${JSON.stringify(scope + ' label')})].find(label => label.textContent.trim() === ${JSON.stringify(text)})?.querySelector('input,textarea')`;
    await page.wait(`(() => { const input = ${field}; return input && !input.disabled && input.getClientRects().length; })()`);
    await page.evaluate(
      `{const input=${field};document.querySelectorAll('[data-qa-input]').forEach(e=>e.removeAttribute('data-qa-input'));input.dataset.qaInput='';}`,
    );
    await page.fill("[data-qa-input]", value);
  };
  const clickRow = async (marker, text) => {
    const match = `Array.from(document.querySelectorAll('.console-row')).find(r=>r.textContent.includes(${JSON.stringify(marker)}))`;
    await page.wait(
      `Array.from((${match})?.querySelectorAll('button')??[]).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled&&b.getClientRects().length)`,
    );
    await page.evaluate(
      `{const row=${match};const button=Array.from(row.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled&&b.getClientRects().length);document.querySelectorAll('[data-qa-click]').forEach(e=>e.removeAttribute('data-qa-click'));button.dataset.qaClick='';}`,
    );
    await page.click("[data-qa-click]");
  };
  // ENTRY-01: the original visual composition opens directly on the V2 form.
  await page.wait("Boolean(document.querySelector('.auth-entry input[autocomplete=username]')) && !document.querySelector('button[type=submit]').disabled");
  assert.deepEqual(await page.evaluate("window.__authPerformance.requests.slice(0, 3).map(item => item.path)"), ['/session', '/session', '/auth/capabilities']);
  await page.wait("Boolean(document.querySelector('.auth-entry img.brand-logo')?.naturalWidth)");
  assert.ok(await page.evaluate(`performance.getEntriesByType('resource').some(entry =>
    entry.name === document.querySelector('.auth-entry img.brand-logo').currentSrc &&
    entry.transferSize === 0 && entry.decodedBodySize > 0)`), "the login logo is cached by Chrome");
  await page.evaluate("history.replaceState(null, '', '/')");
  console.log("PASS P0-1 startup outage is visible and retry restores the anonymous entry");
  for (const width of [1440,1024,390]) {
    await page.viewport(width,900);
    assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'));
    await page.screenshot(join(evidence,'entry-zh-'+width+'.png'));
  }
  await page.viewport(1440,900);
  await click('English');
  await page.wait("document.documentElement.lang==='en' && document.body.textContent.includes('One account.') && document.body.textContent.includes('All your work.')");
  assert.match(await page.evaluate("document.querySelector('.intro').textContent"), /profile, teams and subscriptions/);
  await page.screenshot(join(evidence,'entry-en-1440.png'));
  await click('简体中文');
  await page.fill('input[autocomplete=current-password]', 'synthetic-visibility-check');
  await page.click('[aria-label="显示密码"]');
  assert.equal(await page.evaluate("document.querySelector('input[autocomplete=current-password]').type"),'text');
  await page.click('[aria-label="隐藏密码"]');
  assert.equal(await page.evaluate("document.querySelector('input[autocomplete=current-password]').type"),'password');
  await click('手机验证');
  await page.fill("input[type=tel]", "13800000999");
  await click("继续");
  await page.wait(
    "Boolean(document.querySelector('input[autocomplete=one-time-code]'))",
  );
  const code = await db
    .prepare(
      "SELECT credential FROM auth_mock_delivery ORDER BY created_at DESC LIMIT 1",
    )
    .first();
  await page.fill("input[autocomplete=one-time-code]", code.credential);
  await click("验证");
  await page.wait(
    "document.querySelector('.console-tabs')?.textContent.includes('个人资料')",
  );
  await page.wait("Boolean(document.querySelector('.profile-identity'))");
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.sidebar-nav-group .nav-caption')].map(label => label.textContent)"), ["工作台"]);
  assert.equal(await page.evaluate("document.querySelector('.workspace-sidebar').getBoundingClientRect().width"), 212);
  assert.equal(await page.evaluate("getComputedStyle(document.querySelector('.console-tabs button[aria-current=page]')).fontWeight"), "600");
  const stylesheets = () => page.evaluate("[...document.styleSheets].filter(sheet => sheet.href).map(sheet => new URL(sheet.href).pathname)");
  assert.match(await page.evaluate("document.querySelector('main').textContent"), /所属团队/);
  const profileStylesheets = await stylesheets();
  assert.ok(profileStylesheets.some(path => path.includes("/ConsoleShell-")));
  assert.ok(profileStylesheets.some(path => path.includes("/AccountProfile-")));
  assert.ok(profileStylesheets.every(path => !path.includes("/TenantPage-")));
  assert.equal(await page.evaluate("getComputedStyle(document.querySelector('.console-shell')).display"), "grid");
  assert.equal(await page.evaluate("getComputedStyle(document.querySelector('.profile-identity')).display"), "flex");
  console.log("PASS browser phone registration/login");
  await click("团队");
  await page.wait(
    "document.querySelector('main')?.textContent.includes('创建团队')",
  );
  assert.equal(await page.evaluate("document.querySelector('.collection-list h1').textContent"), "我的团队");
  assert.equal(await page.evaluate("document.querySelector('.collection-list input[type=search]').placeholder"), "搜索团队…");
  assert.ok((await stylesheets()).some(path => path.includes("/TenantPage-")));
  console.log("PASS console and profile styles arrive on sign-in, tenant styles arrive on navigation");
  await click("＋ 创建团队");
  await page.fill("#tenant-create-name", "QA 自助团队");
  await click("创建");
  await page.wait(
    "document.querySelector('.tm-heading h2')?.textContent==='QA 自助团队'",
  );
  await page.wait("document.querySelector('.tm-pagination > span')?.textContent.trim() === '本页 1 位成员' && Boolean(document.querySelector('.tm-page-size-trigger:enabled'))");
  assert.equal(await page.evaluate("document.querySelector('.tm-page-navigation span')?.textContent.trim()"), "第 1 页");
  assert.equal(await page.evaluate("document.querySelectorAll('.tm-page-navigation button:disabled').length"), 2);
  const pageSizeMenu = "#tm-page-sizes:popover-open";
  await page.click(".tm-page-size-trigger");
  await page.click(`${pageSizeMenu} button[aria-pressed=true]`);
  await page.wait(`!document.querySelector('${pageSizeMenu}')`);
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM auth_tenant").first()).n,
    1,
  );
  console.log("PASS browser self-service tenant");
  assert.ok([...scripts].some(path => path.includes("/TenantPage-")));
  assert.ok([...scripts].every(path => !/Platform(?:Users|Clients)-/.test(path)));
  const testTenant = await db.prepare("SELECT id FROM auth_tenant").first();
  const membersCte = "WITH RECURSIVE numbers(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM numbers WHERE n<12)";
  await db.batch([
    db.prepare(membersCte + " INSERT INTO auth_user(id,display_name,status,created_at,updated_at) SELECT 'qa-page-user-'||n,'QA 成员 '||n,'ACTIVE',0,0 FROM numbers"),
    db.prepare(membersCte + " INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at) SELECT 'qa-page-member-'||n,?,'qa-page-user-'||n,'MEMBER','ACTIVE',0 FROM numbers").bind(testTenant.id),
  ]);
  await click("个人资料");
  memberReads.length = 0;
  const tenantStart = await page.evaluate("window.__authPerformance.requests.length");
  await page.evaluate("window.__authPerformance.holdNext.push('/tenants')");
  await click("团队");
  await page.wait("Boolean(window.__authPerformance.gates['/tenants'])");
  assert.equal(memberReads.length, 0, 'members wait for the tenant directory response');
  await page.evaluate("window.__authPerformance.gates['/tenants']()");
  await page.wait("!document.querySelector('[aria-label=下一页]')?.disabled && document.querySelectorAll('.tm-table-wrap tbody tr').length===10");
  assert.equal(memberReads.length, 1);
  assert.equal(memberReads[0].get("limit"), "10");
  assert.equal(memberReads[0].has("cursor"), false);
  const tenantFirstPage = await page.evaluate(`window.__authPerformance.requests.slice(${tenantStart})`);
  const tenantFinished = tenantFirstPage.find(request => request.path === '/tenants').finished;
  const memberStart = tenantFirstPage.find(request => request.path.endsWith('/members')).started;
  assert.ok(tenantFinished <= memberStart);
  assert.ok(tenantFirstPage.every(request => !['/invitations', '/ownership-transfers'].includes(request.path)));
  assert.equal(await page.evaluate("Boolean(document.querySelector('.tenant-rail-note, .tenant-banners'))"), false);
  assert.match(await page.evaluate("document.querySelector('th[aria-sort=ascending]').textContent"), /角色/);
  await page.click(".tm-table-wrap th:first-child button");
  assert.match(await page.evaluate("document.querySelector('th[aria-sort=ascending]').textContent"), /用户/);
  await page.click("[aria-label=下一页]");
  await page.wait("document.querySelector('.tm-pagination')?.textContent.includes('第 2 页') && document.querySelectorAll('.tm-table-wrap tbody tr').length===3");
  assert.equal(memberReads.length, 2);
  assert.ok(memberReads[1].has("cursor"));
  await page.click("[aria-label=上一页]");
  await page.wait("document.querySelector('.tm-pagination')?.textContent.includes('第 1 页')");
  assert.equal(memberReads.length, 2);
  for (const width of [1440, 390]) {
    await page.viewport(width, 900);
    await page.click(".tm-page-size-trigger");
    await page.wait(`Boolean(document.querySelector('${pageSizeMenu}'))`);
    assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('${pageSizeMenu} button'), option =>
      [option.textContent.trim(), option.getAttribute('aria-pressed')])`), [["10 人", "true"], ["20 人", "false"], ["50 人", "false"]]);
    assert.ok(await page.evaluate(`(() => {
      const trigger = document.querySelector('.tm-page-size-trigger').getBoundingClientRect();
      const menu = document.querySelector('${pageSizeMenu}').getBoundingClientRect();
      return menu.left >= 0 && menu.right <= innerWidth && Math.abs(trigger.right - menu.right) < 1 &&
        (menu.bottom <= trigger.top || menu.top >= trigger.bottom);
    })()`), "the page size menu stays by its trigger inside the viewport");
    await page.screenshot(join(evidence, 'tenant-pagination-' + width + '.png'));
    await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.wait(`!document.querySelector('${pageSizeMenu}')`);
  }
  await page.viewport(1440, 900);
  await page.click(".tm-page-size-trigger");
  await page.click(`${pageSizeMenu} button:nth-child(2)`);
  await page.wait(`!document.querySelector('${pageSizeMenu}')`);
  await page.wait("document.querySelector('.tm-page-size-trigger')?.textContent.trim() === '每页 20 人' && document.querySelectorAll('.tm-table-wrap tbody tr').length === 13");
  assert.equal(memberReads.at(-1).get("limit"), "20");
  await page.click(".tm-page-size-trigger");
  await page.click(`${pageSizeMenu} button:first-child`);
  await page.wait(`!document.querySelector('${pageSizeMenu}')`);
  await page.wait("document.querySelector('.tm-page-size-trigger')?.textContent.trim() === '每页 10 人' && document.querySelectorAll('.tm-table-wrap tbody tr').length === 10");
  assert.equal(memberReads.at(-1).get("limit"), "10");
  console.log("PASS team pagination keeps controls visible on a single page and works on desktop and mobile");
  await click("＋ 邀请成员");
  assert.equal(await page.evaluate("document.querySelector('.tm-dialog[open] select')?.value"), "EMAIL");
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.tm-dialog[open] select option')].map(option => option.value)"), ["EMAIL", "PHONE"]);
  await page.evaluate(`{
    const method = document.querySelector('.tm-dialog[open] select');
    method.value = 'PHONE';
    method.dispatchEvent(new Event('change', {bubbles: true}));
  }`);
  await page.wait("Boolean(document.querySelector('.tm-dialog[open] input[type=tel]'))");
  await page.click(".tm-dialog[open] button[aria-label=关闭]");
  await page.evaluate("window.__authPerformance.holdNext.push('/invitations', '/ownership-transfers')");
  await click("待处理");
  await page.wait("['/invitations', '/ownership-transfers'].every(path => window.__authPerformance.gates[path])");
  assert.equal(await page.evaluate("document.querySelector('.pending-empty-card[role=status]')?.textContent.trim()"), "正在检查待处理事项…");
  assert.equal(await page.evaluate("document.querySelectorAll('.pending-group-card').length"), 0);
  await page.evaluate("window.__authPerformance.gates['/invitations'](); window.__authPerformance.gates['/ownership-transfers']()");
  await page.wait("document.querySelector('.pending-empty')?.textContent.trim() === '暂无待处理事项'");
  await page.evaluate("window.__authPerformance.holdNext.push('/invitations', '/ownership-transfers')");
  await click("刷新检查");
  await page.wait("['/invitations', '/ownership-transfers'].every(path => window.__authPerformance.gates[path])");
  assert.equal(await page.evaluate("document.querySelector('.pending-empty')?.textContent.trim()"), "暂无待处理事项");
  assert.equal(await page.evaluate("document.querySelector('.pending-empty-actions button:disabled')?.textContent.trim()"), "检查中…");
  assert.equal(await page.evaluate("document.querySelectorAll('.pending-group-card').length"), 0);
  await page.evaluate("window.__authPerformance.gates['/invitations'](); window.__authPerformance.gates['/ownership-transfers']()");
  await page.wait("document.querySelector('.pending-empty-actions button:enabled')?.textContent.trim() === '刷新检查'");
  await click("个人资料");
  const tenantOwner = await db.prepare("SELECT id,user_id FROM auth_tenant_membership WHERE tenant_id=? AND role='OWNER'").bind(testTenant.id).first();
  await page.wait("Boolean(document.querySelector('.profile-identity'))");
  assert.ok(await page.evaluate(`!document.querySelector('.profile-identity').textContent.includes(${JSON.stringify(tenantOwner.user_id)})`));
  const invite = db.prepare("INSERT INTO auth_tenant_invitation(id,tenant_id,target_kind,target_user_id,inviter_membership_id,status,created_at,expires_at) VALUES (?,?,'USER',?,?,'PENDING',?,?)");
  const invitedAt = Date.now();
  await db.batch([
    invite.bind("qa-current-invitation", testTenant.id, tenantOwner.user_id, tenantOwner.id, invitedAt, invitedAt + 600_000),
    invite.bind("qa-other-invitation", testTenant.id, "qa-page-user-2", tenantOwner.id, invitedAt, invitedAt + 600_000),
  ]);
  await page.evaluate("document.querySelector('meta[name=molis-tenant-invite-channels]').content='USER'");
  await click("团队");
  await click("＋ 邀请成员");
  assert.deepEqual(await page.evaluate(`(() => {
    const dialog = document.querySelector('.tm-dialog[open]');
    return [Boolean(dialog.querySelector('select')), dialog.querySelector('label').textContent.trim(), dialog.querySelector('input').type];
  })()`), [false, "邮箱地址", "email"]);
  assert.match(await page.evaluate("document.querySelector('.tm-dialog[open]').textContent"), /在「待处理」接受邀请/);
  assert.equal(await page.evaluate("document.activeElement === document.querySelector('.tm-invite-dialog input[type=email]')"), true);
  assert.equal(await page.evaluate("document.activeElement.placeholder"), "colleague@molis.ai");
  for (const width of [1440, 390]) {
    await page.viewport(width, 900);
    assert.ok(await page.evaluate(`(() => {
      const dialog = document.querySelector('.tm-invite-dialog[open]');
      const {left, right, width} = dialog.getBoundingClientRect();
      const footer = dialog.querySelector('footer');
      return width === Math.min(440, innerWidth - 32) && left >= 16 && right <= innerWidth - 16 &&
        getComputedStyle(footer).borderTopWidth === '1px' && footer.scrollWidth <= footer.clientWidth;
    })()`), "invite form and footer fit the viewport");
    await page.screenshot(join(evidence, 'team-invite-' + width + '.png'));
  }
  await page.viewport(1440, 900);
  await page.fill(".tm-dialog[open] input[type=email]", "qa-web-invite@example.test");
  await click("创建邀请");
  await page.wait("!document.querySelector('.tm-dialog[open]')");
  assert.deepEqual(await db.prepare("SELECT target_kind,target_user_id,status FROM auth_tenant_invitation WHERE target_email=?").bind("qa-web-invite@example.test").first(),
    { target_kind: "EMAIL", target_user_id: null, status: "PENDING" });
  assert.equal(await page.evaluate("document.querySelector('.tm-heading h2')?.textContent"), 'QA 自助团队');
  await db.prepare("UPDATE auth_tenant SET name=? WHERE id=?").bind('QA 刷新后的团队', testTenant.id).run();
  await click("待处理");
  await page.wait("document.querySelectorAll('.pending-item.is-info').length === 1");
  assert.equal(await page.evaluate("document.querySelector('.console-tabs [aria-current=page]')?.textContent"), "待处理");
  await clickRow("账号邀请", "接受");
  await page.wait("document.querySelector('.pending-empty')?.textContent.trim() === '暂无待处理事项'");
  await click("团队");
  await page.wait("document.querySelector('.tm-heading h2')?.textContent === 'QA 刷新后的团队' && document.querySelector('[aria-current=true] .tenant-choice-name')?.textContent === 'QA 刷新后的团队'");
  await page.wait("document.querySelector('.tm-table-wrap .tm-self')?.textContent === '（我）'");
  const tenantDetailPath = '/tenants/' + testTenant.id;
  assert.deepEqual((await db.prepare("SELECT status,accepted_membership_id FROM auth_tenant_invitation WHERE id IN ('qa-current-invitation','qa-other-invitation') ORDER BY id").all()).results, [
    { status: 'ACCEPTED', accepted_membership_id: tenantOwner.id },
    { status: 'PENDING', accepted_membership_id: null },
  ]);
  await page.evaluate(`{
    document.querySelectorAll('[data-qa-click]').forEach(button => button.removeAttribute('data-qa-click'));
    const row = [...document.querySelectorAll('.tm-table-wrap tbody tr')].find(row => row.querySelector('strong')?.textContent === 'QA 成员 1');
    const button = [...row.querySelectorAll('button')].find(button => button.textContent.trim() === '修改角色');
    button.dataset.qaClick = '';
  }`);
  await page.click('[data-qa-click]');
  await page.evaluate(`{
    const select = document.querySelector('.tm-dialog[open] select');
    select.value = 'ADMIN';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  }`);
  const memberPath = tenantDetailPath + '/members';
  const memberWriteStart = await page.evaluate("window.__authPerformance.requests.length");
  await page.evaluate(`window.__authPerformance.holdNext.push(${JSON.stringify(memberPath)})`);
  await click('确认');
  await page.wait(`Boolean(window.__authPerformance.gates[${JSON.stringify(memberPath)}])`);
  assert.ok(await page.evaluate(`window.__authPerformance.requests.slice(${memberWriteStart}).every(request => request.path !== '/ownership-transfers')`));
  await page.evaluate(`window.__authPerformance.gates[${JSON.stringify(memberPath)}]()`);
  await page.wait("[...document.querySelectorAll('.tm-table-wrap tbody tr')].some(row => row.querySelector('strong')?.textContent === 'QA 成员 1' && row.cells[2].textContent === '管理员')");
  const transferId = "qa-team-name-transfer";
  await db.prepare("INSERT INTO auth_ownership_transfer(id,tenant_id,from_membership_id,to_membership_id,status,created_at,expires_at) VALUES (?,?,?,?,'PENDING',?,?)")
    .bind(transferId, testTenant.id, tenantOwner.id, "qa-page-member-1", invitedAt, invitedAt + 600_000).run();
  await click("待处理");
  await page.wait("document.querySelector('.pending-item.is-warn .pending-item-text')?.textContent.trim() === '「QA 刷新后的团队」的所有权交接'");
  for (const width of [1440, 390]) {
    await page.viewport(width, 900);
    assert.ok(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'));
    await page.screenshot(join(evidence, 'pending-' + width + '.png'));
  }
  await page.viewport(1440, 900);
  await clickRow("「QA 刷新后的团队」的所有权交接", "取消交接");
  await page.wait("document.querySelector('.pending-empty')?.textContent.trim() === '暂无待处理事项'");
  assert.equal((await db.prepare("SELECT status FROM auth_ownership_transfer WHERE id=?").bind(transferId).first()).status, "CANCELLED");
  await db.batch([
    db.prepare("DELETE FROM auth_ownership_transfer WHERE id=?").bind(transferId),
    db.prepare("DELETE FROM auth_tenant_invitation WHERE id IN ('qa-current-invitation','qa-other-invitation')"),
    db.prepare("DELETE FROM auth_tenant_membership WHERE id LIKE 'qa-page-member-%'"),
    db.prepare("DELETE FROM auth_user WHERE id LIKE 'qa-page-user-%'"),
  ]);
  await click("个人资料");
  await click("团队");
  console.log(`PASS browser member first page started ${(memberStart - tenantFinished).toFixed(2)} ms after the team directory, without fetching pending items`);
  console.log("PASS standalone pending page loads both queues, handles invitations and transfers, and returns to refreshed team details");

  // CONSOLE-01: original sidebar and list/detail composition at desktop and phone widths.
  await page.wait("Boolean(document.querySelector('.tm-heading'))");
  for (const width of [1440, 1024, 390]) {
    await page.command('Emulation.setDeviceMetricsOverride', {width, height:900, deviceScaleFactor:1, mobile:false});
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    await page.screenshot(join(evidence, 'tenants-'+width+'.png'));
  }
  await page.command('Emulation.setDeviceMetricsOverride', {width:1440, height:900, deviceScaleFactor:1, mobile:false});

  await click("个人资料");
  const openReportsBeforeProfileSave = await page.evaluate("window.__authPerformance.requests.filter(item => item.path === '/activity').length");
  await page.click('.profile-inline-name [role="button"]');
  await page.fill('input[maxlength="80"]', "QA 昵称");
  await page.evaluate("document.querySelector('input[aria-label=修改昵称]').blur()");
  await page.wait(
    "document.querySelector('.account-menu-name')?.textContent === 'QA 昵称' && document.querySelector('.profile-inline-name [role=button]')?.textContent === 'QA 昵称' && !document.querySelector('input[aria-label=修改昵称]')",
  );
  console.log("PASS browser profile update");
  const {profileEditorChecks}=await import('./profile-editor-checks.mjs');
  await profileEditorChecks({page,click,db,evidence,root});
  assert.equal(await page.evaluate("window.__authPerformance.requests.filter(item => item.path === '/activity').length"), openReportsBeforeProfileSave, "profile saves do not report another OPEN");

  await click("账号安全");
  await page.wait(
    "document.querySelector('main')?.textContent.includes('手机号')",
  );
  for (const width of [1440, 1024, 390]) {
    await page.viewport(width, 900);
    await page.evaluate("scrollTo(0,0)");
    assert.ok(
      await page.evaluate("document.documentElement.scrollWidth<=innerWidth"),
    );
    assert.ok(
      await page.evaluate(
        "(() => {const nav=document.querySelector('.workspace-sidebar').getBoundingClientRect(), main=document.querySelector('main').getBoundingClientRect();return innerWidth>820 ? nav.right<=main.left : nav.bottom<=main.top})()",
      ),
      "CONSOLE-01 navigation stays beside desktop content and above mobile content without overlap",
    );
    await page.screenshot(join(evidence, "security-" + width + ".png"));
  }
  await click("登录会话");
  const methodsRailTitle = ".security-rail-item:first-child .security-rail-btn";
  const methodsTitlePoint = await page.evaluate(`(() => {
    const title = document.querySelector(${JSON.stringify(methodsRailTitle)});
    const {left, top, height} = title.getBoundingClientRect();
    return {x: left + 12, y: top + height / 2};
  })()`);
  await page.command("Input.dispatchMouseEvent", {type: "mouseMoved", ...methodsTitlePoint});
  await page.wait(`(() => {
    const title = document.querySelector(${JSON.stringify(methodsRailTitle)});
    const card = title.closest(".security-rail-item");
    return !card.classList.contains("is-active") && title.matches(":hover") && getComputedStyle(card).backgroundColor !== "rgba(0, 0, 0, 0)";
  })()`);
  assert.deepEqual(await page.evaluate(`(() => {
    const title = getComputedStyle(document.querySelector(${JSON.stringify(methodsRailTitle)}));
    return [title.backgroundColor, title.backgroundImage, title.filter];
  })()`), ["rgba(0, 0, 0, 0)", "none", "none"], "hover highlights the card without styling its title");
  await page.wait("document.querySelector('.login-session-table tbody .is-bound')?.textContent === '当前会话'");
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.login-session-table th')].map(cell => cell.textContent)"),
    ["产品", "设备与客户端", "位置", "状态"]);
  assert.equal(await page.evaluate("document.querySelector('.login-session-table .login-session-location').textContent"), "未知");
  assert.ok(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "session table fits the mobile page");
  await click("退出所有产品和设备");
  assert.equal(await page.evaluate(`(() => {
    const dialog = document.querySelector('.logout-confirm[open]');
    return document.getElementById(dialog.getAttribute('aria-labelledby')).textContent.trim()
      + '/' + document.activeElement.textContent.trim();
  })()`), "退出所有产品和设备？/取消");
  assert.equal(await page.evaluate("document.querySelector('.logout-confirm-submit').textContent"), "确认退出全部");
  for (const width of [390, 1440]) {
    await page.viewport(width, 900);
    assert.equal(await page.evaluate("document.querySelector('.logout-confirm').getBoundingClientRect().width"), Math.min(465, width - 32));
    await page.screenshot(join(evidence, "logout-confirm-" + width + ".png"));
  }
  await page.viewport(390, 900);
  await page.click(".logout-confirm-close");
  await page.wait("!document.querySelector('.logout-confirm[open]') && document.activeElement?.textContent.trim()==='退出所有产品和设备'");
  await click("退出所有产品和设备");
  await page.click(".logout-confirm[open] button[autofocus]");
  await page.wait("!document.querySelector('.logout-confirm[open]') && document.activeElement?.textContent.trim()==='退出所有产品和设备'");
  console.log("PASS browser logout confirmation label, close button, cancel and restored focus");
  await click("登录方式");

  const verifyCurrentPhone = async () => {
    await db.prepare("UPDATE auth_rate_bucket SET expires_at=0").run();
    if(await page.evaluate("Boolean(document.querySelector('.auth-entry'))")) await click('手机验证');
    else {
      await page.wait("Boolean(document.querySelector('.account-form select'))");
      await page.evaluate("{const s=document.querySelector('.account-form select');s.value='PHONE_OTP';s.dispatchEvent(new Event('change',{bubbles:true}));}");
    }
    await page.fill("input[type=tel]", "13800000999");
    await click("继续");
    await page.wait(
      "Boolean(document.querySelector('input[autocomplete=one-time-code]'))",
    );
    const code = await db
      .prepare(
        "SELECT credential FROM auth_mock_delivery ORDER BY created_at DESC LIMIT 1",
      )
      .first();
    await page.fill("input[autocomplete=one-time-code]", code.credential);
    await click("验证");
  };
  assert.equal(await page.evaluate("[...document.querySelectorAll('.security-method:first-of-type button:not(.security-info-trigger)')].length"),0);
  assert.ok(await page.evaluate("document.querySelector('main').textContent.includes('邮箱由管理员维护')"));
  const infoStyle=await page.evaluate("(()=>{const e=document.querySelector('.security-info-trigger'),s=getComputedStyle(e);return {height:e.getBoundingClientRect().height,border:s.borderTopWidth,background:s.backgroundColor};})()");
  assert.deepEqual(infoStyle,{height:20,border:'0px',background:'rgba(0, 0, 0, 0)'});
  await page.click('.security-info-trigger');
  await page.screenshot(join(evidence,'email-tooltip.png'));
  console.log('PASS admin-managed email is read-only for account owner');
  // Bound methods expose unlink; replacement was removed from the current UI.
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.security-method')].find(e=>e.querySelector('h3')?.textContent==='手机号').querySelector('.security-method-actions').textContent.trim()"),'解绑');
  const verifiedBefore = (await db.prepare('SELECT MAX(identity_verified_at) t FROM auth_login_session').first()).t;
  assert.ok([...scripts].every(path => !path.includes("/AccountPassword-")));
  await click("登录密码");
  await page.wait("document.querySelectorAll('.password-form input[autocomplete=new-password]').length === 2");
  assert.ok([...scripts].some(path => path.includes("/AccountPassword-")));
  assert.equal(await page.evaluate("Boolean(document.querySelector('.password-form input[autocomplete=current-password]'))"), false);
  await click("登录方式");
  assert.equal((await db.prepare('SELECT MAX(identity_verified_at) t FROM auth_login_session').first()).t, verifiedBefore, 'opening the form must not request authorization');
  await db.prepare('UPDATE auth_login_session SET identity_verified_at=?').bind(Date.now()-300001).run();
  await click("登录密码");
  await page.wait("Boolean(document.querySelector('.password-form input[autocomplete=new-password]'))");
  assert.equal(await page.evaluate("Boolean(document.querySelector('.password-form input[autocomplete=current-password]'))"), false, 'first-time password setup uses the current session');
  const newPassword = '.password-form label:has(input[autocomplete=new-password])';
  await page.fill('.password-form input[autocomplete=new-password]', "Synthetic-Browser-Jupiter-94");
  await page.fill(newPassword + ':last-of-type input', "Synthetic-Browser-Jupiter-94");
  await click("保存新密码");
  await page.wait("document.querySelector('.password-panel .is-bound')?.textContent.trim() === '已设置密码'");
  await page.fill('.password-form input[autocomplete=current-password]', "Synthetic-Wrong-Password-94");
  await page.fill('.password-form input[autocomplete=new-password]', "Synthetic-Browser-Jupiter-95");
  await page.fill(newPassword + ':last-of-type input', "Synthetic-Browser-Jupiter-95");
  await click("保存新密码");
  await page.wait("document.querySelector('.password-error')?.textContent === '当前密码不正确。'");
  await page.fill('.password-form input[autocomplete=current-password]', "Synthetic-Browser-Jupiter-94");
  await click("保存新密码");
  await page.wait("document.querySelector('.account-toast')?.textContent.includes('密码已更新') && document.querySelector('.password-form input[autocomplete=current-password]')?.value === ''");
  for (const width of [1440, 390]) {
    await page.viewport(width, 900);
    await page.evaluate('scrollTo(0,0)');
    assert.ok(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'));
    await page.screenshot(join(evidence, 'password-form-' + width + '.png'));
  }
  console.log("PASS browser inline password setup, incorrect current password and verified password change");
  assert.ok(
    await page.evaluate(
      "!document.querySelector('.console-tabs').textContent.includes('应用管理')",
    ),
    "ordinary users do not see platform management",
  );
  const operator = await db
    .prepare("SELECT id FROM auth_user WHERE display_name='QA 昵称'")
    .first();
  await bootstrapPlatform(db, operator.id);
  const fixtureTime = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO auth_user(id,display_name,status,avatar_data,created_at,updated_at) VALUES ('qa-v2-target','QA 目标用户','ACTIVE',NULL,?,?)",
      )
      .bind(fixtureTime, fixtureTime),
  ]);
  await page.command("Page.reload");
  await page.wait(
    "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='应用管理'&&!b.disabled)",
  );
  await click("应用管理");
  await page.wait(
    "document.querySelector('main h1')?.textContent==='应用管理'",
  );
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.sidebar-nav-group .nav-caption')].map(label => label.textContent)"), ["工作台", "平台管理"]);
  assert.equal(await page.evaluate("document.querySelector('.sidebar-nav-group:last-child button[aria-current=page]')?.textContent"), "应用管理");
  assert.equal(await page.evaluate("document.querySelector('.app-create-dialog').open"), false);
  await click("＋ 创建应用");
  await fillLabel("应用名称", "QA 应用", ".app-create-dialog[open]");
  await click("创建");
  await page.wait("document.querySelector('.app-page-head h2')?.textContent === 'QA 应用' && !document.querySelector('.app-create-dialog[open]')");
  await fillLabel("应用名称", "QA 应用改名", ".app-edit-card");
  await click("保存应用");
  await page.wait(
    "document.querySelector('main h2')?.textContent==='QA 应用改名'",
  );
  const application = await db
    .prepare("SELECT id,status FROM auth_application WHERE name='QA 应用改名'")
    .first();
  assert.ok(application);
  for (const status of ["DISABLED", "ACTIVE"]) {
    await page.evaluate(
      `{const select=document.querySelector('select[aria-label="应用状态"]');select.value=${JSON.stringify(status)};select.dispatchEvent(new Event('change',{bubbles:true}));}`,
    );
    await click("保存应用");
    await page.wait(
      `document.querySelector('.app-page-head .app-status-pill')?.textContent.trim() === ${JSON.stringify(status)}`,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT status FROM auth_application WHERE id=?")
          .bind(application.id)
          .first()
      ).status,
      status,
    );
  }
  console.log("PASS browser application creation, rename and status changes");
  await page.wait("document.querySelector('.app-head-meta')?.textContent.includes('0 个已登记客户端')");
  assert.equal(await page.evaluate("Boolean(document.querySelector('.client-create-dialog[open]'))"), false);
  await click("＋ 登记登录客户端");
  await page.wait("Boolean(document.querySelector('.client-create-dialog[open]'))");
  assert.ok([...scripts].some(path => path.includes("/PlatformClients-")));
  assert.ok([...scripts].every(path => !path.includes("/PlatformUsers-")));
  await page.viewport(390, 900);
  assert.equal(await page.evaluate("document.querySelector('.client-create-dialog[open]').getBoundingClientRect().width <= innerWidth - 32"), true);
  await page.screenshot(join(evidence, "platform-client-create-390.png"));
  await page.viewport(1440, 900);
  await fillLabel("客户端 ID", "qa-v2-client", ".client-create-dialog[open]");
  await fillLabel("环境 ID", "unified-local", ".client-create-dialog[open]");
  await fillLabel("允许来源", "http://127.0.0.1:43999", ".client-create-dialog[open]");
  await fillLabel(
    "精确回调地址",
    "http://127.0.0.1:43999/account/callback",
    ".client-create-dialog[open]",
  );
  await click("登记");
  await page.wait("!document.querySelector('.client-create-dialog[open]') && document.querySelector('.app-rail-item[aria-current] .app-rail-sub')?.textContent.trim() === '1 个客户端'");
  await page.wait("document.querySelector('.app-head-meta')?.textContent.includes('1 个已登记客户端')");
  await click("配置白名单");
  await fillLabel(
    "允许来源（每行一个）",
    "http://127.0.0.1:44999",
    ".client-edit-dialog[open]",
  );
  await fillLabel(
    "精确回调地址（每行一个）",
    "http://127.0.0.1:44999/account/callback",
    ".client-edit-dialog[open]",
  );
  await click("保存客户端");
  await page.wait("!document.querySelector('.client-edit-dialog[open]') && document.querySelector('.pc-item')?.textContent.includes('44999')");
  const registered = await db
    .prepare(
      "SELECT c.redirects,c.allowed_origins FROM auth_client c WHERE c.client_id='qa-v2-client'",
    )
    .first();
  assert.deepEqual(JSON.parse(registered.redirects), [
    "http://127.0.0.1:44999/account/callback",
  ]);
  assert.deepEqual(JSON.parse(registered.allowed_origins), [
    "http://127.0.0.1:44999",
  ]);
  for (const status of ["DISABLED", "ACTIVE"]) {
    await click("配置白名单");
    await page.wait("Boolean(document.querySelector('.client-edit-dialog[open]'))");
    await page.evaluate(
      `{const select=document.querySelector('select[aria-label="客户端状态"]');select.value=${JSON.stringify(status)};select.dispatchEvent(new Event('change',{bubbles:true}));}`,
    );
    await click("保存客户端");
    await page.wait(
      `!document.querySelector('.client-edit-dialog[open]') && document.querySelector('.pc-item .pc-pill:last-child')?.textContent.trim() === ${JSON.stringify(status)}`,
    );
    assert.equal(
      (
        await db
          .prepare(
            "SELECT status FROM auth_client WHERE client_id='qa-v2-client'",
          )
          .first()
      ).status,
      status,
    );
  }
  console.log(
    "PASS browser client registration, exact callback editing and status changes",
  );
  for (const width of [1440, 390]) {
    await page.viewport(width, 900);
    await page.evaluate("scrollTo(0,0)");
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    await page.screenshot(join(evidence, "platform-applications-" + width + ".png"));
  }
  await page.viewport(1440, 900);
  assert.ok(
    await page.evaluate(
      "!document.body.textContent.includes('服务凭据')&&!document.body.textContent.includes('创建服务凭据')",
    ),
  );
  console.log("PASS V2C-01 retired service credential controls are absent");
  await click("用户与权限");
  await page.wait("Boolean(document.querySelector('.pu-search'))");
  await page.fill(".pu-search", "QA 目标用户");
  await page.wait(
    "document.querySelectorAll('.pu-user-item').length === 1 && !document.querySelector('.pu-user-item').disabled",
  );
  assert.equal(await page.evaluate("document.querySelector('.pu-user-name').textContent"), "QA 目标用户");
  await page.click(".pu-user-item");
  await page.wait("document.querySelector('.pu-selected-meta')?.textContent.includes('qa-v2-target')");
  assert.equal(await page.evaluate("document.querySelector('.pu-user-item').textContent.includes('qa-v2-target')"), false);
  assert.equal(await page.evaluate("Boolean(document.querySelector('.platform-users-page input[maxlength=\"500\"]'))"), false);
  await page.fill(".pu-search", "");
  assert.ok([...scripts].some(path => path.includes("/PlatformUsers-")));

  const auditModal = ".pu-dialog[open]";
  await click("停用账号");
  await page.wait(`Boolean(document.querySelector('${auditModal} button[type=submit]:disabled'))`);
  await click("取消");
  await page.wait(`!document.querySelector('${auditModal}')`);
  assert.equal((await db.prepare("SELECT status FROM auth_user WHERE id='qa-v2-target'").first()).status, "ACTIVE");
  for (const [button, status] of [
    ["停用账号", "DISABLED"],
    ["恢复账号", "ACTIVE"],
  ]) {
    await click(button);
    await fillLabel("审计原因（必填）", "浏览器验收账号状态", auditModal);
    await click("确认");
    await page.wait(`!document.querySelector('${auditModal}')`);
    await page.wait(
      `document.querySelector('.pu-selected-head .pu-pill')?.textContent.trim() === ${JSON.stringify(status === "ACTIVE" ? "正常启用" : "已停用")}`,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT status FROM auth_user WHERE id='qa-v2-target'")
          .first()
      ).status,
      status,
    );
  }
  assert.equal(await page.evaluate("document.querySelector('.pu-cap-section h3').textContent"), "平台级权限矩阵");
  const expectedPlatformCapabilities = [...new Set(policy.permissions
    .map(({ authority }) => authority)
    .filter(authority => authority.startsWith("platform:"))
    .map(authority => authority.slice("platform:".length)))];
  assert.deepEqual(
    await page.evaluate("[...document.querySelectorAll('.pu-cap-card strong')].map(code => code.textContent.trim())"),
    expectedPlatformCapabilities,
  );
  const userReadCard = ".pu-cap-card:nth-child(" + (expectedPlatformCapabilities.indexOf("USER_READ") + 1) + ")";
  for (const [button, status] of [
    ["授予", "ACTIVE"],
    ["撤销", "REVOKED"],
  ]) {
    assert.equal(await page.evaluate(`document.querySelector('${userReadCard} button').textContent.trim()`), button);
    await page.click(userReadCard + " button");
    await fillLabel("审计原因（必填）", "浏览器验收平台权限", auditModal);
    await click("确认");
    await page.wait(`!document.querySelector('${auditModal}')`);
    assert.equal(await page.evaluate(`document.querySelector('${userReadCard}').classList.contains('is-granted')`), status === "ACTIVE");
    assert.equal(
      (
        await db
          .prepare(
            "SELECT status FROM auth_platform_permission WHERE user_id='qa-v2-target' AND permission='USER_READ'",
          )
          .first()
      ).status,
      status,
    );
  }
  await fillLabel('邮箱地址','qa-admin-maintained@example.test');
  await click('保存邮箱并撤销登录');
  await page.wait(`document.querySelector('${auditModal} .pu-email-warning')?.textContent.includes('qa-admin-maintained@example.test')`);
  await fillLabel("审计原因（必填）", "核实归属后维护测试邮箱", auditModal);
  await page.screenshot(join(evidence, "platform-email-audit.png"));
  await click("确认保存");
  await page.wait(`!document.querySelector('${auditModal}') && document.querySelector('.pu-selected-meta')?.textContent.includes('qa-admin-maintained@example.test')`);
  assert.equal((await db.prepare("SELECT canonical_email FROM auth_user_email WHERE user_id='qa-v2-target'").first()).canonical_email,'qa-admin-maintained@example.test');
  console.log('PASS browser administrator maintains email');
  for (const width of [1440, 1024, 390]) {
    await page.viewport(width, 900);
    await page.evaluate("scrollTo(0,0)");
    assert.ok(
      await page.evaluate("document.documentElement.scrollWidth<=innerWidth"),
    );
    assert.ok(
      await page.evaluate(
        "(() => {const nav=document.querySelector('.workspace-sidebar').getBoundingClientRect(), main=document.querySelector('main').getBoundingClientRect();return innerWidth>820 ? nav.right<=main.left : nav.bottom<=main.top})()",
      ),
      "the platform header stays above the current page at every width",
    );
    await page.screenshot(join(evidence, "platform-" + width + ".png"));
  }
  console.log("PASS browser user status and explicit platform grant/revoke");
  const teamListStart = await page.evaluate("window.__authPerformance.requests.length");
  await click("团队管理");
  await click("平台创建团队");
  await page.fill("#pt-create-name", "QA 平台治理团队");
  await page.fill("dialog[open] input[aria-label='搜索活跃用户']", "qa-admin-maintained@example.test");
  const chooseOwner = async (label, userId) => {
    const selector = `dialog[open] select[aria-label="${label}"]`;
    await page.wait(`[...document.querySelector(${JSON.stringify(selector)})?.options ?? []].some(o => o.value === ${JSON.stringify(userId)})`);
    await page.evaluate(`{ const select = document.querySelector(${JSON.stringify(selector)}); select.value = ${JSON.stringify(userId)}; select.dispatchEvent(new Event('change', { bubbles: true })); }`);
  };
  await chooseOwner("初始所有者", "qa-v2-target");
  await page.fill("#pt-create-reason", "浏览器验收平台建团");
  const creationStart = await page.evaluate("window.__authPerformance.requests.length");
  await click("确认创建团队");
  await page.wait("document.querySelector('.pt-hero-head h2')?.textContent === 'QA 平台治理团队' && document.querySelector('[aria-labelledby=pt-member-heading]')?.textContent.includes('qa-admin-maintained@example.test')");
  const governanceReads = start => page.evaluate(`window.__authPerformance.requests.slice(${start}).filter(entry => entry.method === 'GET')`);
  const hasDetailRead = reads => reads.some(entry => /^\/platform\/tenants\/[^/]+$/.test(entry.path));
  const teamFirstPage = (await governanceReads(teamListStart)).find(entry => entry.path === "/platform/tenants");
  assert.equal(new URLSearchParams(teamFirstPage.query).get("limit"), "30");
  assert.equal(hasDetailRead(await governanceReads(creationStart)), false, "create uses the returned team detail");
  for (const [button, submit, reason, status] of [
    ["停用团队", "确认停用团队", "浏览器验收停用团队", "DISABLED"],
    ["恢复启用团队", "确认恢复启用", "浏览器验收恢复团队", "ACTIVE"],
  ]) {
    await click(button);
    await page.fill("#pt-status-reason", reason);
    const statusStart = await page.evaluate("window.__authPerformance.requests.length");
    await click(submit);
    await page.wait(`document.querySelector('.pt-mini-audit-row .pt-op-title')?.textContent === ${JSON.stringify(button)}`);
    const statusReads = await governanceReads(statusStart);
    assert.equal(hasDetailRead(statusReads), false, button + " uses the returned team detail");
    assert.equal(statusReads.some(entry => entry.path === "/platform/tenants"), false);
    assert.match(await page.evaluate("document.querySelector('.pt-hero-sub').textContent"), /QA 目标用户/);
    assert.match(await page.evaluate("document.querySelector('#pt-member-heading').textContent"), /1 人/);
    assert.ok(await page.evaluate("[...document.querySelectorAll('.pt-kv-key')].some(element => element.textContent === '更新时间')"));
    await page.click(".pt-mini-audit-row");
    await page.wait(`document.querySelector('.ad-drawer')?.textContent.includes(${JSON.stringify(reason)})`);
    assert.ok(await page.evaluate(`[...document.querySelectorAll('.ad-diff-table tbody tr')].some(row => row.children[0].textContent === 'status' && row.children[2].textContent.includes(${JSON.stringify(status)}))`));
    assert.ok(await page.evaluate("document.querySelector('.ad-drawer').textContent.includes('请求追踪 ID')"));
    await page.click("button[aria-label='关闭审计详情']");
  }
  const auditStart = await page.evaluate("window.__authPerformance.requests.length");
  await click("在审计日志中查看全部 →");
  await page.wait("document.querySelector('.pa-context-banner')?.textContent.includes('QA 平台治理团队') && document.querySelector('.pa-table tbody tr .pa-op-title')?.textContent === '恢复启用团队'");
  assert.equal(await page.evaluate("document.querySelector('.pa-table tbody tr .pa-actor-name').textContent"), "QA 昵称");
  assert.match(await page.evaluate("document.querySelector('.pa-table tbody tr .pa-tenant-hint').textContent"), /QA 平台治理团队/);
  await page.evaluate("document.querySelector('.pa-table tbody tr').focus()");
  await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.wait("document.querySelector('.ad-drawer .ad-actor-primary')?.textContent === 'QA 昵称'");
  assert.match(await page.evaluate("document.querySelector('.ad-drawer').textContent"), /QA 平台治理团队/);
  await page.click("button[aria-label='关闭审计详情']");
  const auditFirstReads = await governanceReads(auditStart);
  assert.equal(auditFirstReads.some(entry => ["/platform/users", "/platform/tenants"].includes(entry.path)), false);
  assert.equal(hasDetailRead(auditFirstReads), false, "a scoped audit with rows gets the team name from those rows");

  const auditSearch = "input[aria-label='搜索审计日志']";
  await page.evaluate("window.__authPerformance.holdNext.push('/platform/audit-events')");
  await page.fill(auditSearch, "过时搜索");
  await page.wait("Boolean(window.__authPerformance.gates['/platform/audit-events'])");
  await page.fill(auditSearch, "浏览器验收");
  await page.fill(auditSearch, "浏览器验收停用团队");
  await page.wait("document.querySelectorAll('.pa-table tbody tr').length === 1 && document.querySelector('.pa-op-title')?.textContent === '停用团队'");
  const searches = (await governanceReads(auditStart)).filter(entry =>
    entry.path === "/platform/audit-events" && new URLSearchParams(entry.query).has("q"));
  assert.deepEqual(searches.map(entry => new URLSearchParams(entry.query).get("q")), ["过时搜索", "浏览器验收停用团队"]);
  assert.ok(searches[0].aborted, "the older search must abort through the FETCH signal");
  await click("返回该团队");
  await click("强制移交所有权");
  await page.fill("dialog[open] input[aria-label='搜索活跃用户']", operator.id);
  await chooseOwner("新所有者", operator.id);
  await page.fill("#pt-transfer-reason", "浏览器验收应急移交");
  const transferStart = await page.evaluate("window.__authPerformance.requests.length");
  await click("确认移交");
  await page.wait("document.querySelector('.pt-hero-sub')?.textContent.includes('QA 昵称') && document.querySelector('.pt-mini-audit-row .pt-op-title')?.textContent === '强制移交所有权'");
  const transferReads = await governanceReads(transferStart);
  assert.equal(hasDetailRead(transferReads), false, "transfer uses the returned team detail");
  assert.equal(transferReads.some(entry => entry.path === "/platform/tenants"), false);
  assert.match(await page.evaluate("document.querySelector('#pt-member-heading').textContent"), /2 人/);
  const governedTeam = await db.prepare("SELECT id FROM auth_tenant WHERE name='QA 平台治理团队'").first();
  const governanceRoles = await db.prepare("SELECT user_id,role FROM auth_tenant_membership WHERE tenant_id=? ORDER BY role").bind(governedTeam.id).all();
  assert.deepEqual(governanceRoles.results, [
    { user_id: "qa-v2-target", role: "ADMIN" },
    { user_id: operator.id, role: "OWNER" },
  ]);
  for (const width of [1440, 390]) {
    await page.viewport(width, 900);
    await page.evaluate("document.querySelector('.pt-hero-head').scrollIntoView({block:'start'})");
    assert.ok(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"));
    await page.screenshot(join(evidence, "platform-team-governance-" + width + ".png"));
  }
  const globalAuditStart = await page.evaluate("window.__authPerformance.requests.length");
  await click("审计日志");
  await page.wait("document.querySelector('.pa-table tbody tr .pa-op-title')?.textContent === '强制移交所有权'");
  assert.equal((await governanceReads(globalAuditStart)).some(entry => entry.path === "/platform/users" || entry.path.startsWith("/platform/tenants")), false);
  console.log("PASS platform writes reuse their team projection, audit avoids directory reads, and obsolete searches abort");
  assert.deepEqual(
    await page.evaluate(
      "({local:Object.keys(localStorage),session:sessionStorage.length})",
    ),
    { local: ['molis.auth.locale'], session: 0 },
  );
  await db.prepare("UPDATE auth_login_session SET revoked_at=1").run();
  await click("团队");
  await page.wait(
    "!document.querySelector('.console-tabs')&&document.body.textContent.includes('登录已过期')",
  );
  await page.wait("Boolean(document.querySelector('.auth-entry input'))");
  await verifyCurrentPhone();
  await page.wait("Boolean(document.querySelector('.console-tabs'))");
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM auth_user").first()).n,
    2,
  );
  console.log("PASS browser central revocation and immediate new login");
  await click("个人资料");
  await page.wait(
    "document.querySelector('main h1')?.textContent==='个人资料'",
  );
  await click("退出登录");
  await page.wait("!document.querySelector('.console-tabs')");
  await page.wait("document.querySelector('.account-toast > span')?.textContent==='已退出登录'");
  assert.equal(await page.evaluate("[...document.querySelectorAll('.auth-entry .notice')].some(e=>e.textContent.includes('已退出登录'))"),false,'logout feedback must not occupy the form');
  await page.screenshot(join(evidence,'logout-toast.png'));
  await page.wait("!document.querySelector('.account-toast')");
  console.log("PASS browser logout and no token storage");
  // ENTRY-02: email registration, remember-email opt-in, reset and logout cleanup use the same V2 client.
  await page.wait("Boolean(document.querySelector('.auth-entry input[autocomplete=username]'))");
  await click('邮箱验证');
  await page.fill('input[type=email]', 'entry-union@example.test');
  await click('继续');
  await page.wait("Boolean(document.querySelector('input[autocomplete=one-time-code]'))");
  const entryCode=await db.prepare('SELECT credential FROM auth_mock_delivery WHERE destination=? ORDER BY created_at DESC LIMIT 1').bind('entry-union@example.test').first();
  await page.fill('input[autocomplete=one-time-code]',entryCode.credential);await click('验证');
  await page.wait("Boolean(document.querySelector('.console-tabs'))");
  await click('账号安全');await click('登录密码');
  await page.wait("Boolean(document.querySelector('input[autocomplete=new-password]'))");
  await page.fill('input[autocomplete=new-password]','Synthetic-Entry-Password-49');
  await page.fill('form label:nth-of-type(2) input','Synthetic-Entry-Password-49');await click('保存新密码');
  await page.wait("document.querySelector('.password-panel .is-bound')?.textContent.trim() === '已设置密码'");
  await click('退出登录');await page.wait("Boolean(document.querySelector('.auth-entry input[autocomplete=username]')) && !document.querySelector('.entry-primary').disabled");
  await page.fill('input[autocomplete=username]','entry-union@example.test');await page.fill('input[autocomplete=current-password]','Synthetic-Entry-Password-49');
  const passwordStart = await page.evaluate("window.__authPerformance.requests.length");
  await page.click('input[type=checkbox]');await click('登录');await page.wait("Boolean(document.querySelector('.console-tabs'))");
  await page.wait("Boolean(document.querySelector('.profile-email'))");
  assert.equal(await page.evaluate("localStorage.getItem('molis.auth.remembered-email')"),'entry-union@example.test');
  assert.equal(await page.evaluate("document.querySelector('.profile-email')?.textContent"),'entry-union@example.test');
  assert.equal(await page.evaluate("document.querySelector('.account-menu-email')?.textContent"),'entry-union@example.test');
  await page.screenshot(join(evidence,'sidebar-email.png'));
  await page.wait(`['/login-methods', '/activity'].every(path => window.__authPerformance.requests.slice(${passwordStart}).some(item => item.path === path && item.finished))`);
  const password = await page.evaluate(`window.__authPerformance.requests.slice(${passwordStart}).map(item => item.path)`);
  assert.equal(password.filter(path => path === '/auth/login/password').length, 1);
  assert.equal(password.filter(path => path === '/session').length, 0);
  assert.equal(password.filter(path => path === '/activity').length, 1);

  // Open the console from its existing cookie and hold background responses after the real Worker has answered.
  const previousEntryLanguage = await page.evaluate("localStorage.getItem('molis.auth.locale')");
  await page.evaluate("localStorage.setItem('molis.auth.locale', 'en')");
  await page.command('Page.navigate', {url: origin + '/?check=authenticated-startup'});
  await page.wait("Boolean(window.__authPerformance?.gates['/login-methods']) && Boolean(document.querySelector('.profile-inline-name [role=button]'))");
  assert.equal(await page.evaluate("window.__authPerformance.requests.some(item => item.path === '/activity')"), false);
  assert.equal(await page.evaluate('document.documentElement.lang'), 'zh-CN');
  assert.ok(await page.evaluate("[...document.querySelectorAll('.console-tabs button')].every(button => !button.disabled)"));
  await page.click('.profile-inline-name [role=button]');
  await page.wait("Boolean(document.querySelector('.profile-inline-name input'))");
  const profileInteractiveAt = await page.evaluate("performance.now()");
  await page.evaluate("document.querySelector('.profile-inline-name input').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
  await click('团队');
  await page.wait("document.querySelector('.console-tabs [aria-current=page]')?.textContent === '团队'");
  const navigationInteractiveAt = await page.evaluate("performance.now()");
  await page.evaluate("window.__authPerformance.gates['/login-methods']()");
  await page.wait("Boolean(window.__authPerformance.gates['/activity'])");
  await page.evaluate("window.__authPerformance.gates['/activity']()");
  await page.wait("document.querySelector('main')?.textContent.includes('创建团队')");
  await click('个人资料');
  await page.wait("Boolean(document.querySelector('.profile-inline-name [role=button]'))");
  await page.evaluate("window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))");
  const authenticatedStartup = await page.evaluate(`({
    requests: window.__authPerformance.requests,
    assets: performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname.startsWith('/auth-ui/assets/')).map(entry => ({
      path: new URL(entry.name).pathname,
      transferSize: entry.transferSize,
      decodedBodySize: entry.decodedBodySize,
    })),
  })`);
  const startupPaths = authenticatedStartup.requests.map(item => item.path);
  assert.equal(startupPaths.filter(path => path === '/session').length, 1);
  assert.equal(startupPaths.filter(path => path === '/auth/capabilities').length, 0);
  assert.equal(startupPaths.filter(path => path === '/activity').length, 1);
  assert.equal(startupPaths.filter(path => path === '/login-methods').length, 1);
  const methodsToActivity = authenticatedStartup.requests.find(item => item.path === '/activity').started -
    authenticatedStartup.requests.find(item => item.path === '/login-methods').finished;
  assert.ok(methodsToActivity >= 0);
  assert.ok(profileInteractiveAt < authenticatedStartup.requests.find(item => item.path === '/activity').finished);
  assert.ok(navigationInteractiveAt < authenticatedStartup.requests.find(item => item.path === '/login-methods').finished);
  assert.ok(authenticatedStartup.assets.every(asset => !asset.path.startsWith('/auth-ui/assets/molis-logo-')), 'the console uses its inline brand mark');
  for (const extension of ['.js', '.css']) {
    assert.ok(authenticatedStartup.assets.some(asset => asset.path.endsWith(extension) &&
      asset.transferSize === 0 && asset.decodedBodySize > 0), extension + ' is cached by Chrome');
  }
  writeFileSync(join(evidence, 'p0-performance.json'), JSON.stringify({
    password, authenticatedStartup, profileInteractiveAt, navigationInteractiveAt,
  }, null, 2) + '\n');
  console.log(`PASS password and cookie request counts, activity started ${methodsToActivity.toFixed(2)} ms after first-screen login-methods, live interactions and Chrome cache`);
  await authenticatedLoginEntryCheck({ page, origin, fixtures: entryFixtures });
  assert.equal(await page.evaluate("localStorage.getItem('molis.auth.locale')"), 'en');
  await page.evaluate(previousEntryLanguage === null
    ? "localStorage.removeItem('molis.auth.locale')"
    : `localStorage.setItem('molis.auth.locale', ${JSON.stringify(previousEntryLanguage)})`);
  console.log('PASS authenticated root and login entry use the console language despite the English entry preference');
  await click('账号安全'); await click('绑定手机');
  await page.wait("Boolean(document.querySelector('.security-editor input[type=tel]'))");
  assert.equal(await page.evaluate("Boolean(document.querySelector('.security-editor input[type=password]'))"),false);
  assert.equal(await page.evaluate("Boolean(document.querySelector('.security-editor input[autocomplete=one-time-code]'))"),false,'OTP stays hidden until sent');
  await page.fill('.security-editor input[type=tel]','13800000889'); await click('获取验证码');
  await page.wait("Boolean(document.querySelector('.phone-code input'))");
  assert.equal(await page.evaluate("Boolean(document.querySelector('.phone-number input'))"),false,'phone input collapses after delivery');
  assert.ok(await page.evaluate("document.querySelector('.phone-delivery').textContent.includes('138****0889')"));
  await click('更换号码');
  await page.wait("Boolean(document.querySelector('.phone-number input')) && !document.querySelector('.phone-code input')");
  await page.fill('.security-editor input[type=tel]','13800000888'); await click('获取验证码');
  await page.wait("Boolean(document.querySelector('.security-editor input[autocomplete=one-time-code]'))");
  const bindCode=await db.prepare('SELECT credential FROM auth_mock_delivery WHERE destination=? ORDER BY created_at DESC LIMIT 1').bind('+8613800000888').first();
  for(const width of [1440,390]) {
    await page.viewport(width,900);
    const edges=await page.evaluate("[document.querySelector('.phone-code input'),...document.querySelectorAll('.phone-binding-line > button')].map(e=>{const r=e.getBoundingClientRect();return {top:r.top,height:r.height};})");
    for(const r of edges) { assert.equal(r.height,40); if(width===1440)assert.ok(Math.abs(r.top-edges[0].top)<0.5); }
    assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'mobile phone controls wrap without horizontal overflow');
    if(width===1440) assert.ok(await page.evaluate("(()=>{const a=document.querySelector('.nav-caption'),b=document.querySelector('.security-nav h1');return getComputedStyle(b).textAlign==='left' && Math.abs(a.getBoundingClientRect().left-document.querySelector('.workspace-sidebar').getBoundingClientRect().left-(b.getBoundingClientRect().left+parseFloat(getComputedStyle(b).paddingLeft)-document.querySelector('.security-nav').getBoundingClientRect().left))<1;})()"));
    await page.screenshot(join(evidence,'phone-verification-'+width+'.png'));
  }
  await page.screenshot(join(evidence,'phone-binding-code.png'));
  await page.fill('.security-editor input[autocomplete=one-time-code]',bindCode.credential); await click('绑定');
  await page.wait("!document.querySelector('.security-editor') && document.querySelector('main').textContent.includes('0888')");
  assert.equal((await db.prepare('SELECT e.canonical_email email FROM auth_user_phone p JOIN auth_user_email e ON e.user_id=p.user_id WHERE p.canonical_phone=?').bind('+8613800000888').first()).email,'entry-union@example.test');
  console.log('PASS inline phone binding verifies new phone and collapses after save');

  await page.command('Page.navigate', {url: origin + '/?check=logout-activity'});
  await page.wait("Boolean(window.__authPerformance?.gates['/activity'])");
  await click('退出登录');
  await page.wait("Boolean(document.querySelector('.auth-entry input[autocomplete=username]')) && !document.querySelector('.entry-primary').disabled");
  const logoutTrace = await page.evaluate("window.__authPerformance.requests.filter(item => ['/activity', '/logout'].includes(item.path))");
  assert.deepEqual(logoutTrace.map(item => item.path), ['/activity', '/logout']);
  assert.ok(logoutTrace[0].aborted && logoutTrace[0].aborted <= logoutTrace[1].started);
  assert.equal(logoutTrace[0].finished, undefined);
  console.log(`PASS logout aborted the held activity response ${(logoutTrace[1].started - logoutTrace[0].aborted).toFixed(2)} ms before dispatch`);
  assert.equal(await page.evaluate("localStorage.getItem('molis.auth.remembered-email')"),null,'explicit logout clears remembered account data');
  await db.prepare('UPDATE auth_rate_bucket SET expires_at=0').run();
  await click('找回密码');await page.fill('input[type=email]','entry-union@example.test');await click('发送验证码');
  await page.wait("Boolean(document.querySelector('input[autocomplete=one-time-code]'))");
  const resetCode=await db.prepare('SELECT credential FROM auth_mock_delivery WHERE destination=? ORDER BY created_at DESC LIMIT 1').bind('entry-union@example.test').first();
  await page.fill('input[autocomplete=one-time-code]',resetCode.credential);await click('验证');
  await page.wait("Boolean(document.querySelector('.reset-form'))");
  await fillLabel('新密码','Synthetic-Entry-Password-50');await fillLabel('确认新密码','Synthetic-Entry-Password-50');await click('重设密码');
  await page.wait("Boolean(document.querySelector('input[autocomplete=current-password]'))");
  assert.ok(await page.evaluate("[...document.querySelectorAll('.entry-footer button')].every(b=>!b.disabled)"),'reset completion releases the entry navigation');
  await page.fill('input[autocomplete=username]','entry-union@example.test');await page.fill('input[autocomplete=current-password]','Synthetic-Entry-Password-50');
  const switchStart = await page.evaluate("window.__authPerformance.requests.length");
  await page.evaluate("window.__authPerformance.holdNext.push('/login-methods')");
  await click('登录');
  await page.wait("Boolean(document.querySelector('.console-tabs') && window.__authPerformance.gates['/login-methods'])");
  await click('切换账号');
  await page.wait("Boolean(document.querySelector('.auth-entry input[autocomplete=username]')) && !document.querySelector('.entry-primary').disabled");
  const switchTrace = await page.evaluate(`window.__authPerformance.requests.slice(${switchStart}).filter(item => ['/login-methods', '/activity', '/logout'].includes(item.path))`);
  assert.deepEqual(switchTrace.map(item => item.path), ['/login-methods', '/logout']);
  assert.ok(switchTrace[0].aborted && switchTrace[0].aborted <= switchTrace[1].started);
  console.log(`PASS account switch aborted the old login-methods read ${(switchTrace[1].started - switchTrace[0].aborted).toFixed(2)} ms before logout dispatch and sent 0 queued activity requests`);
  console.log('PASS ENTRY-01/02 original visual entry, locale, password visibility, email signup/login/reset and account preference cleanup');
  // ENTRY-03: both supported external buttons finish through real mock-provider callbacks.
  for(const sql of readFileSync(root+'/worker/mock-provider-local-seed.sql','utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
  for(const provider of ['Google','GitHub']) {
    const known=new Set((await browser.command('Target.getTargets')).targetInfos.map(t=>t.targetId));
    const loginNavigations=requests.filter(r=>r.path==='/login').length;
    await click('使用 '+provider+' 登录');
    let target;
    for(let i=0;i<100;i++) {
      target=(await browser.command('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&!known.has(t.targetId)&&t.url.includes('/auth/mock/'));
      if(target)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(target,provider+' authorization popup opens');
    const popup=await browser.page(target.targetId);await popup.viewport(800,700);await popup.command('Page.bringToFront');
    await popup.wait("Boolean(document.querySelector('button[value=SUCCESS]'))");await popup.click('button[value=SUCCESS]');
    await page.wait("Boolean(document.querySelector('.console-tabs'))");await page.command('Page.bringToFront');
    assert.equal(requests.filter(r=>r.path==='/login').length,loginNavigations,'provider callback preserves the initiating page');
    await click('退出登录');await page.wait("Boolean(document.querySelector('.auth-entry input[autocomplete=username]')) && !document.querySelector('.entry-primary').disabled");
  }
  console.log('PASS ENTRY-03 Google/GitHub callbacks through the restored entry');


  if(process.env.AUTH_ACCOUNT_CYCLES === '1') {
    const {accountCycles}=await import('./account-cycles.mjs');
    await accountCycles({page,browser,db,origin});
  }
  console.log("Evidence: " + evidence);
} catch (e) {
  console.error(JSON.stringify(requests));
  if (page) {
    try {
      console.error(
        await page.evaluate(
          "(()=>{document.querySelectorAll('aside code').forEach(e=>e.textContent='[one-time credential hidden]');return document.body.innerText})()",
        ),
      );
      await page.screenshot(join(evidence, "failure.png"));
    } catch {
      /* Preserve the original failure when Chrome has disconnected. */
    }
  }
  throw e;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await proxy?.dispose();
  rmSync(profile, { recursive: true, force: true });
}
