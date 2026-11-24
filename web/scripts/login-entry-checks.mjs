import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sessionPath = '/api/account/session';
const capabilitiesPath = '/api/account/auth/capabilities';
const sessionLoading = '.session-startup [role=status]';
const capabilitiesLoading = '.entry-capabilities-loading[role=status]';
const authControls = '.entry-auth-form input, .entry-auth-form button[type=submit], .account-methods button, .entry-social';
const passwordReady = `Boolean(document.querySelector('.entry-auth-form input[autocomplete=username]:enabled') &&
  document.querySelector('.entry-auth-form input[autocomplete=current-password]:enabled') &&
  document.querySelector('.entry-auth-form button[type=submit]:enabled'))`;
const visibleProviders = "[...document.querySelectorAll('.entry-social button:enabled')].filter(button => button.getClientRects().length)";
const painted = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))';

function holdResponse(path, response) {
  const { promise: arrived, resolve: markArrived } = Promise.withResolvers();
  const { promise: released, resolve: release } = Promise.withResolvers();
  return { path, response, arrived, markArrived, released, release };
}

export function loginEntryFixtures() {
  let active;
  return {
    async run(gates, scenario) {
      assert.equal(active, undefined);
      const requests = [];
      active = { gates, requests };
      try {
        return await scenario(requests);
      } finally {
        active = undefined;
        for (const gate of gates) gate.release();
      }
    },
    async fetch(method, path, passthrough) {
      if (!active || method !== 'GET' || ![sessionPath, capabilitiesPath].includes(path)) return passthrough();
      const { gates, requests } = active;
      const previous = requests.filter(request => request.path === path).length;
      const gate = gates.filter(item => item.path === path)[previous];
      const request = { path, arrivedAt: performance.now() };
      requests.push(request);
      if (gate) {
        gate.markArrived();
        await gate.released;
      }
      const response = gate?.response ? gate.response() : await passthrough();
      request.status = response.status;
      request.respondedAt = performance.now();
      return response;
    },
  };
}

async function waitForRequests(...gates) {
  const pending = new Set(gates);
  let timeout;
  try {
    await Promise.race([
      Promise.all(gates.map(async (gate) => {
        await gate.arrived;
        pending.delete(gate);
      })),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const paths = [...pending].map(gate => gate.path).join(' and ');
          reject(Error(`Timed out awaiting held HTTP requests for ${paths}`));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function assertPending(page, selector) {
  await page.wait(`Boolean(document.querySelector(${JSON.stringify(selector)})?.textContent.trim())`);
  await page.evaluate(painted);
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(authControls)}) === null`), true,
    `${selector} appears before any login controls`);
}

function assertRequestCounts(requests, sessionCount, capabilitiesCount) {
  assert.equal(requests.filter(request => request.path === sessionPath).length, sessionCount, sessionPath);
  assert.equal(requests.filter(request => request.path === capabilitiesPath).length, capabilitiesCount, capabilitiesPath);
}

function traceLayout() {
  const rect = (selector) => {
    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
    return { x, y, width, height };
  };
  const shell = () => ({
    panel: rect('.auth-entry .login-panel'),
    welcome: rect('.auth-entry .login-welcome'),
  });
  const form = () => ({
    username: rect('.entry-auth-form input[autocomplete=username]'),
    password: rect('.entry-auth-form input[autocomplete=current-password]'),
    submit: rect('.entry-auth-form button[type=submit]'),
  });
  if (!PerformanceObserver.supportedEntryTypes.includes('layout-shift')) throw Error('Chrome LayoutShift API unavailable');
  const shifts = [];
  const recordShifts = (entries) => {
    for (const { value, hadRecentInput, startTime, sources } of entries) {
      shifts.push({
        value, hadRecentInput, startTime,
        sources: sources.map(({ node }) => node?.getAttribute?.('class') ?? node?.nodeName ?? ''),
      });
    }
  };
  const observer = new PerformanceObserver(list => recordShifts(list.getEntries()));
  observer.observe({ type: 'layout-shift', buffered: true });

  let frame, firstForm, disabledSubmit = false;
  const sampleForm = () => {
    const password = document.querySelector('.entry-auth-form input[autocomplete=current-password]');
    const submit = password?.form?.querySelector('button[type=submit]');
    if (password?.getClientRects().length && submit?.getClientRects().length) {
      firstForm ??= form();
      disabledSubmit ||= submit.disabled;
    }
    frame = requestAnimationFrame(sampleForm);
  };
  frame = requestAnimationFrame(sampleForm);
  window.__loginLayout = {
    shell,
    finish() {
      recordShifts(observer.takeRecords());
      observer.disconnect();
      cancelAnimationFrame(frame);
      return { ready: shell(), firstForm, readyForm: form(), disabledSubmit, shifts };
    },
  };
}

async function checkLayout({ page, origin, fixtures }) {
  const { identifier } = await page.command('Page.addScriptToEvaluateOnNewDocument', { source: `(${traceLayout})()` });
  const observations = [];
  try {
    for (const [width, first] of [[1440, capabilitiesPath], [390, sessionPath]]) {
      await page.viewport(width, 900);
      const session = holdResponse(sessionPath);
      const capabilities = holdResponse(capabilitiesPath);
      await fixtures.run([session, capabilities], async (requests) => {
        if (width === 1440) await page.command('Page.navigate', { url: origin + '/login' });
        else await page.command('Page.reload', { ignoreCache: true });
        await waitForRequests(session, capabilities);
        assertRequestCounts(requests, 1, 1);
        assert.ok(requests.every(request => request.status === undefined), 'both HTTP requests arrive before either response');
        await assertPending(page, sessionLoading);
        const loading = await page.evaluate('window.__loginLayout.shell()');

        if (first === capabilitiesPath) {
          capabilities.release();
          await page.wait(`performance.getEntriesByName(location.origin + '${capabilitiesPath}').length === 1`);
          await assertPending(page, sessionLoading);
        } else {
          session.release();
          await assertPending(page, capabilitiesLoading);
        }
        const afterFirst = await page.evaluate('window.__loginLayout.shell()');
        (first === capabilitiesPath ? session : capabilities).release();
        await page.wait(passwordReady);
        await page.wait(`${visibleProviders}.length === 2`);
        await page.evaluate(painted);
        const trace = await page.evaluate('window.__loginLayout.finish()');
        assertRequestCounts(requests, 1, 1);
        assert.deepEqual(requests.map(request => request.status), [200, 200]);
        assert.deepEqual(afterFirst, loading, `width ${width}, first response ${first}`);
        assert.deepEqual(trace.ready, loading, `width ${width}, ready shell geometry`);
        assert.deepEqual(trace.firstForm, trace.readyForm, `width ${width}, first and ready form geometry`);
        assert.equal(trace.disabledSubmit, false, `width ${width}, password submit starts enabled`);
        assert.deepEqual(trace.shifts.filter(shift => shift.value > 0), [], `width ${width}, no Chrome layout shifts`);
        const assets = await page.evaluate(`performance.getEntriesByType('resource')
          .filter(entry => new URL(entry.name).pathname.startsWith('/auth-ui/assets/'))
          .map(entry => ({ path: new URL(entry.name).pathname, bytes: entry.decodedBodySize }))`);
        assert.equal(assets.filter(asset => asset.path.endsWith('.css')).length, 1);
        assert.ok(assets.every(asset => !/\/(ConsoleShell|AccountProfile|TenantPage|AccountSecurityEditor|AvatarCropper)-/.test(asset.path)));
        observations.push({ width, first, loading, afterFirst, ...trace, requests, assets });
      });
    }
  } finally {
    await page.command('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    await page.viewport(1440, 900);
  }
  return observations;
}

const failure = (status) => () => Response.json({ error: { code: status === 403 ? 'FORBIDDEN' : 'AUTH_UNAVAILABLE' } }, { status });

async function checkSessionRetry({ page, origin, fixtures }) {
  const session = holdResponse(sessionPath, failure(503));
  const capabilities = holdResponse(capabilitiesPath);
  const nextSession = holdResponse(sessionPath);
  const nextCapabilities = holdResponse(capabilitiesPath);
  await fixtures.run([session, capabilities, nextSession, nextCapabilities], async (requests) => {
    await page.command('Page.navigate', { url: origin + '/login' });
    await waitForRequests(session, capabilities);
    await assertPending(page, sessionLoading);
    capabilities.release();
    await page.wait(`performance.getEntriesByName(location.origin + '${capabilitiesPath}').length === 1`);
    session.release();
    await assertPending(page, '.session-startup [role=alert]');
    assertRequestCounts(requests, 1, 1);
    await page.click('.session-startup button');
    await waitForRequests(nextSession, nextCapabilities);
    await assertPending(page, sessionLoading);
    nextSession.release();
    await assertPending(page, capabilitiesLoading);
    nextCapabilities.release();
    await page.wait(passwordReady);
    assertRequestCounts(requests, 2, 2);
  });
}

async function checkCapabilitiesRetry({ page, origin, fixtures }, status, method) {
  const session = holdResponse(sessionPath);
  const capabilities = holdResponse(capabilitiesPath, failure(status));
  const nextCapabilities = holdResponse(capabilitiesPath, () => Response.json({ data: { methods: [method] } }));
  await fixtures.run([session, capabilities, nextCapabilities], async (requests) => {
    await page.command('Page.navigate', { url: origin + '/login' });
    await waitForRequests(session, capabilities);
    session.release();
    await assertPending(page, capabilitiesLoading);
    capabilities.release();
    await assertPending(page, '.entry-capabilities-error [role=alert]');
    assertRequestCounts(requests, 1, 1);
    await page.click('.entry-capabilities-error button');
    await waitForRequests(nextCapabilities);
    await assertPending(page, capabilitiesLoading);
    nextCapabilities.release();
    if (method === 'EMAIL_CODE') {
      await page.wait("Boolean(document.querySelector('.entry-auth-form input[type=email]:enabled') && document.querySelector('.entry-auth-form button[type=submit]:enabled'))");
      assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.account-methods button')].filter(button => button.getClientRects().length).map(button => button.textContent.trim())"), ['邮箱验证']);
      assert.equal(await page.evaluate("Boolean(document.querySelector('.entry-social, .entry-auth-form input[type=password]'))"), false);
    } else {
      await page.wait(`${visibleProviders}.length === 1`);
      assert.match(await page.evaluate(`${visibleProviders}[0].textContent`), /Google/);
      assert.equal(await page.evaluate("Boolean(document.querySelector('.entry-auth-form input, .entry-auth-form button[type=submit]'))"), false);
    }
    assertRequestCounts(requests, 1, 2);
  });
}

function traceCountdown() {
  const intervals = new Map();
  const trace = { active: 0, started: 0, runs: [] };
  window.__countdown = trace;
  const start = window.setInterval.bind(window);
  const stop = window.clearInterval.bind(window);
  window.setInterval = (...args) => {
    const id = start(...args);
    intervals.set(id, performance.now());
    trace.started++;
    trace.active = intervals.size;
    return id;
  };
  window.clearInterval = (id) => {
    if (intervals.has(id)) {
      trace.runs.push(performance.now() - intervals.get(id));
      intervals.delete(id);
      trace.active = intervals.size;
    }
    return stop(id);
  };

  const fetch = window.fetch.bind(window);
  const retries = [2, 7];
  window.fetch = (url, options) => {
    if (options?.method !== 'POST' || new URL(url).pathname !== '/api/account/auth/verification-codes') {
      return fetch(url, options);
    }
    return Promise.resolve(Response.json({
      data: { verificationId: 'local-browser-countdown', retryAfterSeconds: retries.shift() },
    }));
  };
}

async function checkResendCountdown({ page, origin }) {
  const { identifier } = await page.command('Page.addScriptToEvaluateOnNewDocument', { source: `(${traceCountdown})()` });
  const tab = '.account-methods button';
  const resend = '.entry-actions button.text-button';
  try {
    await page.command('Page.navigate', { url: origin + '/login' });
    await page.wait(passwordReady);
    assert.equal(await page.evaluate('window.__countdown.started'), 0);
    await page.click(`${tab}:nth-child(2)`);
    await page.fill('.entry-auth-form input[type=email]', 'countdown@example.test');
    await page.click('.entry-actions button[type=submit]');
    await page.wait(`document.querySelector('${resend}:disabled')?.textContent.endsWith('(2s)')`);
    assert.equal(await page.evaluate('window.__countdown.active'), 1);
    await page.wait(`Boolean(document.querySelector('${resend}:enabled')) && window.__countdown.active === 0`);
    const firstRun = await page.evaluate('window.__countdown.runs[0]');
    assert.ok(firstRun >= 1900, `two-second retry ran for ${firstRun} ms`);
    await page.click(resend);
    await page.wait(`document.querySelector('${resend}:disabled')?.textContent.endsWith('(7s)')`);
    await page.click(`${tab}:first-child`);
    await page.wait(passwordReady);
    const { active, started, runs } = await page.evaluate('window.__countdown');
    assert.equal(active, 0);
    assert.equal(started, 2);
    assert.ok(runs[1] < 7000, `switching to password stopped the retry after ${runs[1]} ms`);
    console.log(`PASS login resend uses the returned 2 s and 7 s delays, clears on expiry and method switch (active for ${runs.map(Math.round).join(' and ')} ms)`);
  } finally {
    await page.command('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
}

export async function loginEntryChecks({ page, origin, fixtures, evidence }) {
  const context = { page, origin, fixtures };
  const observations = await checkLayout(context);
  writeFileSync(join(evidence, 'login-entry-stability.json'), JSON.stringify(observations, null, 2) + '\n');
  console.log('PASS login entry uses one overlapping request per endpoint, keeps its desktop/mobile geometry and records zero layout shifts');
  await checkSessionRetry(context);
  await checkCapabilitiesRetry(context, 403, 'EMAIL_CODE');
  await checkCapabilitiesRetry(context, 503, 'GOOGLE');
  console.log('PASS login entry handles session failure and capabilities 403/503 with retry and only enables returned methods');
  await checkResendCountdown(context);
}

export async function authenticatedLoginEntryCheck({ page, origin, fixtures }) {
  const session = holdResponse(sessionPath);
  const capabilities = holdResponse(capabilitiesPath);
  await fixtures.run([session, capabilities], async (requests) => {
    await page.command('Page.navigate', { url: origin + '/login' });
    await waitForRequests(session, capabilities);
    await assertPending(page, sessionLoading);
    assert.equal(await page.evaluate('document.documentElement.lang'), 'en');
    session.release();
    await page.wait("Boolean(document.querySelector('.console-tabs'))");
    assert.equal(await page.evaluate('document.documentElement.lang'), 'zh-CN');
    assert.equal(await page.evaluate("Boolean(document.querySelector('.auth-entry'))"), false);
    assert.equal(requests.find(request => request.path === capabilitiesPath).status, undefined,
      'an authenticated visit enters the console before capabilities return');
    capabilities.release();
    await page.wait(`performance.getEntriesByName(location.origin + '${capabilitiesPath}').length === 1`);
    await page.evaluate(painted);
    assertRequestCounts(requests, 1, 1);
    assert.equal(await page.evaluate('document.documentElement.lang'), 'zh-CN');
  });
}
