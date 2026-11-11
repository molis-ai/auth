// V2U-03/05/07: real Auth WASM/D1 and Chrome; temporary data, explicit mock delivery only.
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { bootstrapPlatform } from "../../worker/scripts/platform-bootstrap.mjs";
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
const server = http.createServer(async (req, res) => {
  try {
    const parts = [];
    for await (const p of req) parts.push(p);
    const r = await proxy.fetch(
      new Request(origin + req.url, {
        method: req.method,
        headers: req.headers,
        ...(["GET", "HEAD"].includes(req.method)
          ? {}
          : { body: Buffer.concat(parts) }),
      }),
    );
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
    (req) => {
      const path = new URL(req.url).pathname;
      const type = path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".png")
            ? "image/png"
            : "text/html";
      return new Response(readFileSync(root + "/web/dist" + path), {
        headers: { "Content-Type": type },
      });
    },
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
    .prepare("UPDATE auth_client_policy SET allowed_origins=?")
    .bind(JSON.stringify([origin]))
    .run();
  browser = await ChromeHarness.start(profile);
  assert.ok(browser);
  page = await browser.page();
  await page.command("Page.enable");
  await page.viewport(1440, 900);
  await page.command("Page.navigate", { url: origin });
  await page.wait(
    "document.querySelector('main')?.textContent.includes('登录')",
  );
  const click = async (text) => {
    if(text==='设置或修改密码') await click('登录密码');
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
    await page.evaluate(
      `{const label=Array.from(document.querySelectorAll(${JSON.stringify(scope)}+' label')).find(l=>l.textContent.trim()===${JSON.stringify(text)});const input=label?.querySelector('input,textarea');if(!input)throw Error('Missing input '+${JSON.stringify(text)});document.querySelectorAll('[data-qa-input]').forEach(e=>e.removeAttribute('data-qa-input'));input.dataset.qaInput='';}`,
    );
    await page.fill("[data-qa-input]", value);
  };
  const clickRow = async (marker, text) => {
    const match = `Array.from(document.querySelectorAll('.v2-row')).find(r=>r.textContent.includes(${JSON.stringify(marker)}))`;
    await page.wait(
      `Array.from((${match})?.querySelectorAll('button')??[]).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled&&b.getClientRects().length)`,
    );
    await page.evaluate(
      `{const row=${match};const button=Array.from(row.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled&&b.getClientRects().length);document.querySelectorAll('[data-qa-click]').forEach(e=>e.removeAttribute('data-qa-click'));button.dataset.qaClick='';}`,
    );
    await page.click("[data-qa-click]");
  };
  // ENTRY-01: the original visual composition opens directly on the V2 form.
  await page.wait("Boolean(document.querySelector('.auth-entry input[type=email]')) && !document.querySelector('button[type=submit]').disabled");
  for (const width of [1440,1024,390]) {
    await page.viewport(width,900);
    assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'));
    await page.screenshot(join(evidence,'entry-zh-'+width+'.png'));
  }
  await page.viewport(1440,900);
  await click('English');
  await page.wait("document.documentElement.lang==='en' && document.body.textContent.includes('One account.') && document.body.textContent.includes('All your work.')");
  await page.screenshot(join(evidence,'entry-en-1440.png'));
  await click('简体中文');
  await page.fill('input[autocomplete=current-password]', 'synthetic-visibility-check');
  await page.click('[aria-label="显示密码"]');
  assert.equal(await page.evaluate("document.querySelector('input[autocomplete=current-password]').type"),'text');
  await page.click('[aria-label="隐藏密码"]');
  assert.equal(await page.evaluate("document.querySelector('input[autocomplete=current-password]').type"),'password');
  await click('手机验证码');
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
  console.log("PASS browser phone registration/login");
  await click("租户");
  await page.wait(
    "document.querySelector('main')?.textContent.includes('创建租户')",
  );
  await click("＋ 创建租户");
  await page.fill("#tenant-create-name", "QA 自助租户");
  await click("创建");
  await page.wait(
    "document.querySelector('.tm-heading h2')?.textContent==='QA 自助租户'",
  );
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM auth_managed_tenant").first()).n,
    1,
  );
  console.log("PASS browser self-service tenant");
  // CONSOLE-01: original sidebar and list/detail composition at desktop and phone widths.
  await page.wait("Boolean(document.querySelector('.tm-heading'))");
  for (const width of [1440, 1024, 390]) {
    await page.command('Emulation.setDeviceMetricsOverride', {width, height:900, deviceScaleFactor:1, mobile:false});
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    await page.screenshot(join(evidence, 'tenants-'+width+'.png'));
  }
  await page.command('Emulation.setDeviceMetricsOverride', {width:1440, height:900, deviceScaleFactor:1, mobile:false});

  await click("个人资料");
  await page.click('.profile-inline-name [role="button"]');
  await page.fill('input[maxlength="80"]', "QA 昵称");
  await page.evaluate("document.querySelector('input[aria-label=修改昵称]').blur()");
  await page.wait(
    "document.querySelector('header')?.textContent.includes('QA 昵称')",
  );
  console.log("PASS browser profile update");
  const {profileEditorChecks}=await import('./profile-editor-checks.mjs');
  await profileEditorChecks({page,click,db,evidence,root});

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
        "(() => {const nav=document.querySelector('.workspace-sidebar').getBoundingClientRect(), main=document.querySelector('main').getBoundingClientRect();return innerWidth>760 ? nav.right<=main.left : nav.bottom<=main.top})()",
      ),
      "CONSOLE-01 navigation stays beside desktop content and above mobile content without overlap",
    );
    await page.screenshot(join(evidence, "security-" + width + ".png"));
  }
  const verifyCurrentPhone = async () => {
    await db.prepare("UPDATE auth_rate_bucket SET expires_at=0").run();
    if(await page.evaluate("Boolean(document.querySelector('.auth-entry'))")) await click('手机验证码');
    else {
      await page.wait("Boolean(document.querySelector('.v2-form select'))");
      await page.evaluate("{const s=document.querySelector('.v2-form select');s.value='PHONE_OTP';s.dispatchEvent(new Event('change',{bubbles:true}));}");
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
  // AUTH-RECENT: a fresh login skips old-identity prompts; all phone UI stays in its row.
  await page.evaluate("[...document.querySelectorAll('.security-method')].find(e=>e.querySelector('h3')?.textContent==='手机号').querySelector('button').click()");
  await page.wait("Boolean(document.querySelector('.security-editor input[type=tel]')) && !document.querySelector('.security-editor input[type=password]')");
  assert.equal(await page.evaluate("document.querySelector('.security-editor').closest('.security-method').querySelector('h3').textContent"),'手机号');
  for (const width of [1440,390]) {
    await page.viewport(width,900);
    const edges = await page.evaluate("[document.querySelector('.phone-number input'), ...document.querySelectorAll('.phone-binding-line > button')].map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};})");
    assert.equal(edges.length,3);
    for(const edge of edges) {
      assert.equal(edge.height,40,'phone input and buttons are 40px high');
      assert.ok(Math.abs(edge.top-edges[0].top)<0.5 && Math.abs(edge.bottom-edges[0].bottom)<0.5,'phone controls share top and bottom edges');
    }
    await page.screenshot(join(evidence,'phone-controls-'+width+'.png'));
  }
  await page.screenshot(join(evidence,'phone-inline-recent.png'));
  const verifiedBefore=(await db.prepare('SELECT MAX(identity_verified_at) t FROM auth_login_session').first()).t;
  await click('取消');
  await page.wait("!document.querySelector('.security-editor')");
  assert.equal((await db.prepare('SELECT MAX(identity_verified_at) t FROM auth_login_session').first()).t,verifiedBefore,'reuse must not renew recent-auth time');
  await click("设置或修改密码");
  await page.wait("Boolean(document.querySelector('input[autocomplete=new-password]'))");
  assert.equal(await page.evaluate("Boolean(document.querySelector('input[autocomplete=current-password]'))"),false);
  await click('取消');
  await page.wait("!document.querySelector('.security-editor')");
  await db.prepare('UPDATE auth_login_session SET identity_verified_at=?').bind(Date.now()-300001).run();
  await click("设置或修改密码");
  await page.wait("Boolean(document.querySelector('input[autocomplete=new-password]'))");
  assert.equal(await page.evaluate("Boolean(document.querySelector('input[autocomplete=current-password]'))"),false,'old verification timestamp must not trigger a second login');
  console.log('PASS active session skips second login, inline phone form and cancellation');
  await page.fill(
    "input[autocomplete=new-password]",
    "Synthetic-Browser-Jupiter-94",
  );
  await page.fill(
    "form label:nth-of-type(2) input",
    "Synthetic-Browser-Jupiter-94",
  );
  await click("确认修改密码");
  await page.wait(
    "!document.querySelector('input[autocomplete=new-password]')&&!document.querySelector('.v2-form')",
  );
  console.log("PASS browser reauth and password change");
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
        "INSERT INTO auth_user VALUES ('qa-v2-target','QA 目标用户','ACTIVE',NULL,?,?)",
      )
      .bind(fixtureTime, fixtureTime),
    db
      .prepare(
        "INSERT INTO auth_user_security(user_id,updated_at) VALUES ('qa-v2-target',?)",
      )
      .bind(fixtureTime),
  ]);
  await page.command("Page.reload");
  await page.wait(
    "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='应用管理'&&!b.disabled)",
  );
  await click("应用管理");
  await page.wait(
    "document.querySelector('main h1')?.textContent==='应用管理'",
  );
  await fillLabel("应用名称", "QA 应用");
  await click("创建应用");
  await click("QA 应用");
  await fillLabel("名称", "QA 应用改名");
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
      `Array.from(document.querySelectorAll('.v2-row')).some(r=>r.textContent.includes('QA 应用改名')&&r.textContent.includes(${JSON.stringify(status)}))`,
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
  await fillLabel("客户端 ID", "qa-v2-client", ".v2-client-create");
  await fillLabel("环境 ID", "unified-local", ".v2-client-create");
  await fillLabel("产品来源", "http://127.0.0.1:43999", ".v2-client-create");
  await fillLabel(
    "精确回调地址",
    "http://127.0.0.1:43999/account/callback",
    ".v2-client-create",
  );
  await click("登记客户端");
  await click("修改客户端");
  await fillLabel(
    "允许来源（每行一个）",
    "http://127.0.0.1:44999",
    ".v2-client-edit",
  );
  await fillLabel(
    "精确回调地址（每行一个）",
    "http://127.0.0.1:44999/account/callback",
    ".v2-client-edit",
  );
  await click("保存客户端");
  await page.wait("!document.querySelector('.v2-client-edit')");
  const registered = await db
    .prepare(
      "SELECT c.redirects,p.allowed_origins FROM auth_client c JOIN auth_client_policy p ON p.client_id=c.client_id WHERE c.client_id='qa-v2-client'",
    )
    .first();
  assert.deepEqual(JSON.parse(registered.redirects), [
    "http://127.0.0.1:44999/account/callback",
  ]);
  assert.deepEqual(JSON.parse(registered.allowed_origins), [
    "http://127.0.0.1:44999",
  ]);
  for (const status of ["DISABLED", "ACTIVE"]) {
    await click("修改客户端");
    await page.evaluate(
      `{const select=document.querySelector('select[aria-label="客户端状态"]');select.value=${JSON.stringify(status)};select.dispatchEvent(new Event('change',{bubbles:true}));}`,
    );
    await click("保存客户端");
    await page.wait(
      `!document.querySelector('.v2-client-edit')&&Array.from(document.querySelectorAll('.v2-row')).some(r=>r.textContent.includes('qa-v2-client')&&r.textContent.includes(${JSON.stringify(status)}))`,
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
  assert.ok(
    await page.evaluate(
      "!document.body.textContent.includes('服务凭据')&&!document.body.textContent.includes('创建服务凭据')",
    ),
  );
  console.log("PASS V2C-01 retired service credential controls are absent");
  await click("用户与权限");
  await page.wait(
    "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='QA 目标用户'&&!b.disabled)",
  );
  for (const [button, status] of [
    ["停用账号", "DISABLED"],
    ["恢复账号", "ACTIVE"],
  ]) {
    await fillLabel("操作原因", "浏览器验收账号状态");
    await clickRow("qa-v2-target", button);
    await page.wait(
      `Array.from(document.querySelectorAll('.v2-row')).some(r=>r.textContent.includes('qa-v2-target')&&r.textContent.includes(${JSON.stringify(status)}))`,
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
  await click("QA 目标用户");
  await page.wait(
    "document.querySelector('main')?.textContent.includes('QA 目标用户 的平台权限')",
  );
  for (const [button, status] of [
    ["授予", "ACTIVE"],
    ["撤销", "REVOKED"],
  ]) {
    await fillLabel("操作原因", "浏览器验收平台权限");
    await clickRow("USER_READ", button);
    await page.wait(
      `Array.from(document.querySelectorAll('.v2-row')).some(r=>r.textContent.includes('USER_READ')&&r.textContent.includes(${JSON.stringify(status)}))`,
    );
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
  await fillLabel('操作原因','核实归属后维护测试邮箱');
  await fillLabel('邮箱','qa-admin-maintained@example.test');
  await click('保存邮箱并撤销登录');
  await page.wait("!document.querySelector('main input[type=email]')");
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
        "(() => {const nav=document.querySelector('.workspace-sidebar').getBoundingClientRect(), main=document.querySelector('main').getBoundingClientRect();return innerWidth>760 ? nav.right<=main.left : nav.bottom<=main.top})()",
      ),
      "the platform header stays above the current page at every width",
    );
    await page.screenshot(join(evidence, "platform-" + width + ".png"));
  }
  console.log("PASS browser user status and explicit platform grant/revoke");
  assert.deepEqual(
    await page.evaluate(
      "({local:Object.keys(localStorage),session:sessionStorage.length})",
    ),
    { local: ['molis.auth.locale'], session: 0 },
  );
  await db.prepare("UPDATE auth_login_session SET revoked_at=1").run();
  await click("租户");
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
  await page.wait("document.querySelector('.account-toast')?.textContent==='已退出登录'");
  assert.equal(await page.evaluate("[...document.querySelectorAll('.auth-entry .notice')].some(e=>e.textContent.includes('已退出登录'))"),false,'logout feedback must not occupy the form');
  await page.screenshot(join(evidence,'logout-toast.png'));
  await page.wait("!document.querySelector('.account-toast')");
  console.log("PASS browser logout and no token storage");
  // ENTRY-02: email registration, remember-email opt-in, reset and logout cleanup use the same V2 client.
  await page.wait("Boolean(document.querySelector('.auth-entry input[type=email]'))");
  await click('邮箱注册');
  await page.fill('input[type=email]', 'entry-union@example.test');
  await click('继续');
  await page.wait("Boolean(document.querySelector('input[autocomplete=one-time-code]'))");
  const entryCode=await db.prepare('SELECT credential FROM auth_mock_delivery WHERE destination=? ORDER BY created_at DESC LIMIT 1').bind('entry-union@example.test').first();
  await page.fill('input[autocomplete=one-time-code]',entryCode.credential);await click('验证');
  await page.wait("document.querySelectorAll('input[autocomplete=new-password]').length===2");
  await fillLabel('密码','Synthetic-Entry-Password-49');await fillLabel('确认密码','Synthetic-Entry-Password-49');await click('完成注册');
  await page.wait("Boolean(document.querySelector('.console-tabs'))");
  await click('退出登录');await page.wait("Boolean(document.querySelector('.auth-entry input[type=email]'))");
  await page.fill('input[type=email]','entry-union@example.test');await page.fill('input[autocomplete=current-password]','Synthetic-Entry-Password-49');
  await page.click('input[type=checkbox]');await click('登录');await page.wait("Boolean(document.querySelector('.console-tabs'))");
  assert.equal(await page.evaluate("localStorage.getItem('molis.auth.remembered-email')"),'entry-union@example.test');
  assert.equal(await page.evaluate("document.querySelector('.profile-email')?.textContent"),'entry-union@example.test');
  assert.equal(await page.evaluate("document.querySelector('.account-menu-email')?.textContent"),'entry-union@example.test');
  await page.screenshot(join(evidence,'sidebar-email.png'));
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
    for(const r of edges) { assert.equal(r.height,40); assert.ok(Math.abs(r.top-edges[0].top)<0.5); }
    if(width===1440) assert.ok(await page.evaluate("(()=>{const a=document.querySelector('.nav-caption'),b=document.querySelector('.security-nav h1');return getComputedStyle(b).textAlign==='left' && Math.abs(a.getBoundingClientRect().left-document.querySelector('.workspace-sidebar').getBoundingClientRect().left-(b.getBoundingClientRect().left+parseFloat(getComputedStyle(b).paddingLeft)-document.querySelector('.security-nav').getBoundingClientRect().left))<1;})()"));
    await page.screenshot(join(evidence,'phone-verification-'+width+'.png'));
  }
  await page.screenshot(join(evidence,'phone-binding-code.png'));
  await page.fill('.security-editor input[autocomplete=one-time-code]',bindCode.credential); await click('绑定');
  await page.wait("!document.querySelector('.security-editor') && document.querySelector('main').textContent.includes('0888')");
  assert.equal((await db.prepare('SELECT e.canonical_email email FROM auth_user_phone p JOIN auth_user_email e ON e.user_id=p.user_id WHERE p.canonical_phone=?').bind('+8613800000888').first()).email,'entry-union@example.test');
  console.log('PASS inline phone binding verifies new phone and collapses after save');

  await click('退出登录');await page.wait("Boolean(document.querySelector('.auth-entry input[type=email]'))");
  assert.equal(await page.evaluate("localStorage.getItem('molis.auth.remembered-email')"),null,'explicit logout clears remembered account data');
  await db.prepare('UPDATE auth_rate_bucket SET expires_at=0').run();
  await click('找回密码');await page.fill('input[type=email]','entry-union@example.test');await click('继续');
  await page.wait("Boolean(document.querySelector('input[autocomplete=one-time-code]'))");
  const resetCode=await db.prepare('SELECT credential FROM auth_mock_delivery WHERE destination=? ORDER BY created_at DESC LIMIT 1').bind('entry-union@example.test').first();
  await page.fill('input[autocomplete=one-time-code]',resetCode.credential);await click('验证');
  await page.wait("Boolean(document.querySelector('.reset-form'))");
  await fillLabel('新密码','Synthetic-Entry-Password-50');await fillLabel('确认新密码','Synthetic-Entry-Password-50');await click('重设密码');
  await page.wait("Boolean(document.querySelector('input[autocomplete=current-password]'))");
  assert.ok(await page.evaluate("[...document.querySelectorAll('.entry-footer button')].every(b=>!b.disabled)"),'reset completion releases the entry navigation');
  await page.fill('input[type=email]','entry-union@example.test');await page.fill('input[autocomplete=current-password]','Synthetic-Entry-Password-50');await click('登录');
  await page.wait("Boolean(document.querySelector('.console-tabs'))");
  await click('退出登录');await page.wait("Boolean(document.querySelector('.auth-entry input[type=email]'))");
  console.log('PASS ENTRY-01/02 original visual entry, locale, password visibility, email signup/login/reset and account preference cleanup');
  // ENTRY-03: both supported external buttons finish through real mock-provider callbacks.
  for(const sql of readFileSync(root+'/worker/mock-provider-local-seed.sql','utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
  for(const provider of ['Google','GitHub']) {
    const known=new Set((await browser.command('Target.getTargets')).targetInfos.map(t=>t.targetId));
    await click(provider);
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
    await click('退出登录');await page.wait("Boolean(document.querySelector('.auth-entry input[type=email]'))");
  }
  console.log('PASS ENTRY-03 Google/GitHub callbacks through the restored entry');


  if(process.env.AUTH_ACCOUNT_CYCLES === '1') {
    const {accountCycles}=await import('./account-cycles.mjs');
    await accountCycles({page,browser,db,origin});
  }
  console.log("Evidence: " + evidence);
} catch (e) {
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
