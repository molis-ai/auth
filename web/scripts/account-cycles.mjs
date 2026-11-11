import assert from 'node:assert/strict';

// AUTH-CYCLE-01/02: real cookies and BFF; no token injection into browser state.
export async function accountCycles({page,browser,db,origin}) {
  const anonymous="Boolean(document.querySelector('.auth-entry input[type=email]')) && !document.querySelector('.console-tabs')";
  const authenticated="Boolean(document.querySelector('.console-tabs'))";
  async function wait(p,expression,options) {
    for(let attempt=0;attempt<5;attempt++) {
      try { return await p.wait(expression,options); }
      catch(error) {
        if(attempt===4 || !/navigated or closed|Execution context was destroyed|Cannot find context/.test(String(error))) throw error;
      }
    }
  }

  async function click(p,label,repeat=1) {
    await p.command('Page.bringToFront');
    if(label==='退出所有产品和设备') { await click(p,'账号安全'); await click(p,'登录会话'); }
    await wait(p,`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`);
    await p.evaluate(`{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled);for(let i=0;i<${repeat};i++)b.click();}`);
    if(label==='退出所有产品和设备') await click(p,'确认退出');
  }
  const state= p=>p.evaluate(`(async()=>{for(let attempt=0;attempt<10;attempt++){const response=await fetch('/api/account/session',{cache:'no-store'});const reply=await response.json();if(response.ok)return reply.data;if(reply.error?.code!=='VERSION_CONFLICT')throw Error(reply.error?.code);await new Promise(resolve=>setTimeout(resolve,30));}throw Error('session read contention did not settle');})()`);
  async function login(p,email,password) {
    await p.command('Page.bringToFront');
    await wait(p,anonymous);
    // Functional stress, not a rate-limit bypass in product: isolate buckets between test accounts.
    await db.prepare('UPDATE auth_rate_bucket SET expires_at=0').run();
    await p.fill('input[type=email]',email);await p.fill('input[autocomplete=current-password]',password);
    await click(p,'登录',4);await wait(p,authenticated);
    const current=await state(p);
    assert.equal(await p.evaluate("document.querySelector('.profile-identity h2').textContent"),current.user.displayName,'old unsaved profile must not survive account replacement');
    return current;
  }
  async function logout(p,action='退出登录') {
    const prior=await state(p);
    const current=await db.prepare('SELECT id FROM auth_login_session WHERE user_id=? AND revoked_at IS NULL ORDER BY authenticated_at DESC LIMIT 1').bind(prior.user.userId).first();
    await click(p,'个人资料');await click(p,action,4);try { await wait(p,anonymous); } catch(error) { console.log('Logout diagnostic',await p.evaluate("document.querySelector('.console-feedback')?.textContent"));throw error; }
    assert.notEqual((await state(p)).state,'AUTHENTICATED');
    assert.ok((await db.prepare('SELECT revoked_at FROM auth_login_session WHERE id=?').bind(current.id).first()).revoked_at,'central current login must be revoked, not only BFF hidden');
  }
  await page.command('Page.addScriptToEvaluateOnNewDocument',{source:`{
    const original=window.fetch;
    window.fetch=async(...args)=>{
      const path=String(args[0]);
      if(window.__failLogout && path.endsWith('/api/account/logout')) throw new TypeError('synthetic transport outage');
      const r=await original(...args);
      if(window.__holdSession && path.endsWith('/api/account/session')) {window.__heldSession=true;await new Promise(resolve=>setTimeout(resolve,1200));}
      return r;
    };
  }`});
  const A={email:'entry-union@example.test',password:'Synthetic-Entry-Password-50'};
  await page.command('Page.navigate',{url:origin+'/console'});await wait(page,anonymous);
  assert.notEqual((await state(page)).state,'AUTHENTICATED','direct anonymous /console must not authenticate');
  const a=await login(page,A.email,A.password);assert.equal(a.state,'AUTHENTICATED');
  await page.command('Page.reload');await wait(page,authenticated);assert.equal((await state(page)).user.userId,a.user.userId,'valid cookie intentionally restores same user');
  const target=await browser.command('Target.createTarget',{url:origin});
  const sibling=await browser.page(target.targetId);await sibling.command('Page.enable');await wait(sibling,authenticated);
  await logout(page);
  await wait(sibling,anonymous,{timeoutMs:5000});
  console.log('PASS AUTH-CYCLE-01 clean entry, valid-cookie restore, repeated logout, second-tab invalidation');
  // Register B through the actual UI, then alternate distinct identities.
  await click(page,'邮箱注册');await page.fill('input[type=email]','cycle-b@example.test');await click(page,'继续');
  await wait(page,"Boolean(document.querySelector('input[autocomplete=one-time-code]'))");
  const code=await db.prepare('SELECT credential FROM auth_mock_delivery WHERE destination=? ORDER BY created_at DESC LIMIT 1').bind('cycle-b@example.test').first();
  await page.fill('input[autocomplete=one-time-code]',code.credential);await click(page,'验证');
  await wait(page,"document.querySelectorAll('input[autocomplete=new-password]').length===2");
  await page.fill('input[autocomplete=new-password]','Synthetic-Cycle-B-Password-61');
  await page.fill('label:has(input[autocomplete=new-password]):last-of-type input','Synthetic-Cycle-B-Password-61');
  await click(page,'完成注册');await wait(page,authenticated);const b=await state(page);assert.notEqual(a.user.userId,b.user.userId);
  await logout(page);
  const B={email:'cycle-b@example.test',password:'Synthetic-Cycle-B-Password-61'};
  for(let i=0;i<20;i++) {
    const actor=i%2?B:A, expected=i%2?b:a;
    const actual=await login(page,actor.email,actor.password);assert.equal(actual.user.userId,expected.user.userId);
    await sibling.command('Page.bringToFront');await wait(sibling,authenticated);
    assert.equal((await state(sibling)).user.userId,expected.user.userId);
    await page.command('Page.bringToFront');await page.click('.profile-inline-name [role=button]');await page.fill('input[maxlength="80"]','unsaved-'+i);
    await logout(sibling,i%2?'切换账号':'退出登录');await wait(page,anonymous);await wait(sibling,anonymous);
    await page.command('Page.reload');await wait(page,anonymous);
    assert.equal(await page.evaluate("Boolean(document.querySelector('.console-tabs'))"),false);
    assert.equal(await page.evaluate("localStorage.getItem('molis.auth.remembered-email')"),null);
  }
  console.log('PASS AUTH-CYCLE-02 20 alternating A/B logins and logouts, repeated clicks, reload, cross-tab identity and draft isolation');
  // AUTH-CYCLE-04: BFCache/history cannot restore a logged-out management page.
  await login(page,A.email,A.password);await wait(sibling,authenticated);
  const history=await page.command('Page.getNavigationHistory');
  const entry=history.entries[history.currentIndex].id;
  await page.command('Page.navigate',{url:'about:blank'});
  await logout(sibling);
  await page.command('Page.navigateToHistoryEntry',{entryId:entry});
  await wait(page,anonymous);assert.notEqual((await state(page)).state,'AUTHENTICATED');
  // A delayed session response from before logout must not restore the old identity.
  await login(page,B.email,B.password);await wait(sibling,authenticated);
  await page.evaluate("window.__holdSession=true;window.dispatchEvent(new Event('focus'))");
  await wait(page,'window.__heldSession===true');await logout(sibling);await wait(page,anonymous);
  await new Promise(resolve=>setTimeout(resolve,1500));assert.notEqual((await state(page)).state,'AUTHENTICATED');
  // A failed logout request must not claim success; retry must revoke the real session.
  await login(page,A.email,A.password);await wait(sibling,authenticated);
  await page.evaluate('window.__failLogout=true');
  await click(page,'退出登录');await wait(page,"document.querySelector('[role=status]')?.textContent.includes('结果')");
  assert.equal((await state(page)).state,'AUTHENTICATED','failed transport cannot claim central revocation');
  await page.evaluate('window.__failLogout=false');await logout(page);await wait(sibling,anonymous);
  console.log('PASS AUTH-CYCLE-04 history restoration, late session response, failed logout and successful retry');
  await login(page,A.email,A.password);await wait(sibling,authenticated);
  await logout(page,'退出所有产品和设备');await wait(sibling,anonymous);
  assert.equal((await db.prepare('SELECT count(*) n FROM auth_login_session WHERE user_id=? AND revoked_at IS NULL').bind(a.user.userId).first()).n,0);
  const context=await browser.command('Target.createBrowserContext');
  const cleanTarget=await browser.command('Target.createTarget',{url:origin+'/console',browserContextId:context.browserContextId});
  const clean=await browser.page(cleanTarget.targetId);await wait(clean,anonymous);
  assert.notEqual((await state(clean)).state,'AUTHENTICATED','new browser context has no authentication');
  await browser.command('Target.disposeBrowserContext',{browserContextId:context.browserContextId});
  await browser.command('Target.closeTarget',{targetId:target.targetId});
  console.log('PASS AUTH-CYCLE-05 all-device logout and cookie-free direct entry');

}
