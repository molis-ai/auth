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
    await page.wait(
      `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`,
    );
    await page.evaluate(
      `{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled);if(!b)throw Error('Missing '+${JSON.stringify(text)});document.querySelectorAll('[data-qa-click]').forEach(b=>b.removeAttribute('data-qa-click'));b.dataset.qaClick='';}`,
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
      `Array.from((${match})?.querySelectorAll('button')??[]).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`,
    );
    await page.evaluate(
      `{const row=${match};const button=Array.from(row.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled);document.querySelectorAll('[data-qa-click]').forEach(e=>e.removeAttribute('data-qa-click'));button.dataset.qaClick='';}`,
    );
    await page.click("[data-qa-click]");
  };
  await click("登录");
  await page.wait("Boolean(document.querySelector('form select'))");
  await page.evaluate(
    "{const s=document.querySelector('form select');s.value='PHONE_OTP';s.dispatchEvent(new Event('change',{bubbles:true}));}",
  );
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
  await page.fill("form input", "QA 自助租户");
  await click("创建租户");
  await page.wait(
    "document.querySelector('main')?.textContent.includes('QA 自助租户')&&[...document.querySelectorAll('button')].some(b=>b.textContent==='QA 自助租户')",
  );
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM auth_managed_tenant").first()).n,
    1,
  );
  console.log("PASS browser self-service tenant");
  await click("个人资料");
  await page.fill('input[maxlength="80"]', "QA 昵称");
  await click("保存资料");
  await page.wait(
    "document.querySelector('header')?.textContent.includes('QA 昵称')",
  );
  console.log("PASS browser profile update");
  await click("账号安全");
  await page.wait(
    "document.querySelector('main')?.textContent.includes('PHONE')",
  );
  for (const width of [1440, 1024, 390]) {
    await page.viewport(width, 900);
    await page.evaluate("scrollTo(0,0)");
    assert.ok(
      await page.evaluate("document.documentElement.scrollWidth<=innerWidth"),
    );
    assert.ok(
      await page.evaluate(
        "document.querySelector('header').getBoundingClientRect().bottom<=document.querySelector('main').getBoundingClientRect().top",
      ),
      "the account header stays above the current page at every width",
    );
    await page.screenshot(join(evidence, "security-" + width + ".png"));
  }
  const verifyCurrentPhone = async () => {
    await db.prepare("UPDATE auth_rate_bucket SET expires_at=0").run();
    await page.wait("Boolean(document.querySelector('.v2-form select'))");
    await page.evaluate(
      "{const s=document.querySelector('.v2-form select');s.value='PHONE_OTP';s.dispatchEvent(new Event('change',{bubbles:true}));}",
    );
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
  await click("绑定邮箱");
  await verifyCurrentPhone();
  await page.wait(
    "Boolean(document.querySelector('.v2-form input[type=email]'))",
  );
  await page.fill("input[type=email]", "qa-browser@example.test");
  await click("继续");
  await page.wait(
    "Boolean(document.querySelector('input[autocomplete=one-time-code]'))",
  );
  const emailCode = await db
    .prepare(
      "SELECT credential FROM auth_mock_delivery WHERE destination=? ORDER BY created_at DESC LIMIT 1",
    )
    .bind("qa-browser@example.test")
    .first();
  await page.fill("input[autocomplete=one-time-code]", emailCode.credential);
  await click("验证");
  await page.wait(
    "!document.querySelector('.v2-form')&&document.querySelector('main')?.textContent.includes('EMAIL')",
  );
  console.log("PASS browser reauth and bind email");
  await click("设置或修改密码");
  await verifyCurrentPhone();
  await page.wait(
    "Boolean(document.querySelector('input[autocomplete=new-password]'))",
  );
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
    "document.querySelector('main h2')?.textContent.includes('QA 目标用户')",
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
  for (const width of [1440, 1024, 390]) {
    await page.viewport(width, 900);
    await page.evaluate("scrollTo(0,0)");
    assert.ok(
      await page.evaluate("document.documentElement.scrollWidth<=innerWidth"),
    );
    assert.ok(
      await page.evaluate(
        "document.querySelector('header').getBoundingClientRect().bottom<=document.querySelector('main').getBoundingClientRect().top",
      ),
      "the platform header stays above the current page at every width",
    );
    await page.screenshot(join(evidence, "platform-" + width + ".png"));
  }
  console.log("PASS browser user status and explicit platform grant/revoke");
  assert.deepEqual(
    await page.evaluate(
      "({local:localStorage.length,session:sessionStorage.length})",
    ),
    { local: 0, session: 0 },
  );
  await db.prepare("UPDATE auth_login_session SET revoked_at=1").run();
  await click("租户");
  await page.wait(
    "!document.querySelector('.console-tabs')&&document.body.textContent.includes('登录已过期')",
  );
  await click("登录");
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
  console.log("PASS browser logout and no token storage");
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
