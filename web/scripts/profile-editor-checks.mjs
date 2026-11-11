import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
// PROFILE-01/02: profile display with inline editing; drawer removed by user request.
export async function profileEditorChecks({page,click,db,evidence,root}) {
  const drawer="Boolean(document.querySelector('.profile-drawer'))";
  await page.wait('!'+drawer);
  assert.equal(await page.evaluate("document.querySelector('.profile-identity h2').textContent"),'QA 昵称');
  const emailRow=await db.prepare("SELECT canonical_email FROM auth_user_email WHERE user_id=(SELECT id FROM auth_user WHERE display_name='QA 昵称') AND verified_at IS NOT NULL ORDER BY id LIMIT 1").first();
  assert.equal(await page.evaluate("document.querySelector('.profile-email')?.textContent"),emailRow?.canonical_email);
  // PROFILE-05: inline nickname edit, cancellation, empty validation, blur save.
  const inline='input[aria-label="修改昵称"]';
  async function beginName() {
    await page.click('.profile-inline-name [role="button"]');
    await page.wait('Boolean(document.querySelector('+JSON.stringify(inline)+'))');
  }
  const nicknamePoint=await page.evaluate("(()=>{const r=document.querySelector('.profile-inline-name').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  await page.command('Input.dispatchMouseEvent',{type:'mouseMoved',...nicknamePoint});
  await page.screenshot(join(evidence,'profile-name-hover.png'));
  await beginName();await page.fill(inline,'不保存');
  const nameBox=await page.evaluate("(()=>{const h=document.querySelector('.profile-inline-name'),text=document.querySelector('.profile-name-field > span');return {width:h.getBoundingClientRect().width,text:text.getBoundingClientRect().width,height:h.getBoundingClientRect().height};})()");
  assert.ok(nameBox.width-nameBox.text<=18,'inline nickname hugs text instead of input default width');
  assert.ok(nameBox.height<36,'inline nickname has compact vertical padding');
  await page.screenshot(join(evidence,'profile-name-editing.png'));
  await page.evaluate("document.querySelector('input[aria-label=修改昵称]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await page.evaluate("document.querySelector('.profile-identity h2').textContent"),'QA 昵称');
  await beginName();await page.fill(inline,'   ');
  await page.evaluate("document.querySelector('input[aria-label=修改昵称]').blur()");
  await page.wait("document.querySelector('.profile-name-error')?.textContent==='请输入昵称'");
  await page.command('Network.emulateNetworkConditions',{offline:false,latency:700,downloadThroughput:-1,uploadThroughput:-1});
  await page.fill(inline,'行内昵称');
  await page.evaluate("document.querySelector('input[aria-label=修改昵称]').blur()");
  await page.wait("document.querySelector('.profile-name-status')?.textContent==='正在保存...'");
  assert.equal(await page.evaluate("document.querySelector('input[aria-label=修改昵称]').readOnly"),true);
  await page.screenshot(join(evidence,'profile-name-saving.png'));
  await page.command('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await page.wait("!document.querySelector('input[aria-label=修改昵称]') && document.querySelector('.profile-identity h2').textContent==='行内昵称'");
  assert.equal((await db.prepare("SELECT display_name FROM auth_user WHERE display_name='行内昵称'").first()).display_name,'行内昵称');
  await beginName();await page.fill(inline,'QA 昵称');
  await page.evaluate("document.querySelector('input[aria-label=修改昵称]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await page.wait("!document.querySelector('input[aria-label=修改昵称]') && document.querySelector('.profile-identity h2').textContent==='QA 昵称'");
  console.log('PASS PROFILE-05 inline nickname cancel, empty validation, blur/Enter save');
  for(const width of [1440,390]) {
    await page.viewport(width,900);await page.screenshot(join(evidence,'profile-'+width+'.png'));
    assert.ok(await page.evaluate("document.documentElement.scrollWidth<=innerWidth"));
    assert.equal(await page.evaluate(drawer),false);

  }
  await page.viewport(1440,900);
  await page.click('[aria-label="账号菜单"]');
  const menuPlacement=await page.evaluate("(()=>{const a=document.querySelector('.account-menu-trigger').getBoundingClientRect(),m=document.querySelector('#account-menu').getBoundingClientRect();return {gap:a.top-m.bottom,width:m.width-a.width,left:m.left-a.left};})()");
  assert.ok(Math.abs(menuPlacement.gap-6)<1 && Math.abs(menuPlacement.width)<1 && Math.abs(menuPlacement.left)<1,'account menu is anchored to its trigger');
  await page.screenshot(join(evidence,'account-menu-anchored.png'));
  await page.click('[aria-label="账号菜单"]');
  // PROFILE-03: public avatar opens the native chooser directly, not the editor/menu.
  await page.command('Page.setInterceptFileChooserDialog',{enabled:true});
  await page.click('[aria-label="编辑头像"]');
  assert.equal(await page.evaluate(drawer),false);
  assert.equal(await page.evaluate("document.querySelector('.profile-avatar-trigger').classList.contains('selected')"),true);
  assert.equal(await page.evaluate("getComputedStyle(document.querySelector('.profile-avatar-trigger')).outlineColor"),'rgb(57, 129, 255)');
  await page.screenshot(join(evidence,'profile-avatar-selected.png'));
  const {root:directDom}=await page.command('DOM.getDocument');
  const {nodeId:directInput}=await page.command('DOM.querySelector',{nodeId:directDom.nodeId,selector:'.profile-direct-file'});
  await page.command('DOM.setFileInputFiles',{nodeId:directInput,files:[join(root,'web/src/assets/molis-logo.png')]});
  await page.wait("Boolean(document.querySelector('.avatar-crop-dialog[open] .avatar-crop-stage'))");
  assert.equal(await page.evaluate("Boolean(document.querySelector('.profile-identity img'))"),false);
  assert.equal(await page.evaluate(drawer),false);
  const proportions=await page.evaluate("(()=>{const modal=document.querySelector('.avatar-crop-dialog').getBoundingClientRect(),stage=document.querySelector('.avatar-crop-stage').getBoundingClientRect();return {modal:modal.height/modal.width,stage:stage.width/stage.height};})()");
  assert.ok(proportions.modal>1.1,'crop dialog is portrait rather than square');assert.ok(proportions.stage>1.45,'crop image stage is landscape');
  await page.screenshot(join(evidence,'avatar-crop-desktop.png'));
  await page.viewport(390,900);await page.screenshot(join(evidence,'avatar-crop-mobile.png'));await page.viewport(1440,900);
  await page.click('.avatar-crop-dialog footer button:first-child');
  await page.command('Page.setInterceptFileChooserDialog',{enabled:false});

  // Supply a file to the native file input; the application still validates and reads it.
  async function file(path) {
    const {root:dom}=await page.command('DOM.getDocument');
    const {nodeId}=await page.command('DOM.querySelector',{nodeId:dom.nodeId,selector:'.profile-direct-file'});
    await page.command('DOM.setFileInputFiles',{nodeId,files:[path]});
  }
  const invalid=join(evidence,'invalid-avatar.png');writeFileSync(invalid,Buffer.alloc(10*1024*1024+1));
  await file(invalid);await page.wait("document.querySelector('.profile-page [role=alert]')?.textContent.includes('10 MB')");
  await file(join(root,'web/src/assets/molis-logo.png'));await page.wait("Boolean(document.querySelector('.avatar-crop-stage'))");
  await page.evaluate(`{const input=document.querySelector('[aria-label="缩放图片"]');input.value='1.5';input.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await page.evaluate(`{const stage=document.querySelector('.avatar-crop-stage');stage.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));}`);
  const cropBox=await page.evaluate("(()=>{const r=document.querySelector('.avatar-crop-stage').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  const beforeDrag=await page.evaluate("document.querySelector('.avatar-crop-stage image').getAttribute('x')");
  await page.command('Input.dispatchMouseEvent',{type:'mousePressed',x:cropBox.x,y:cropBox.y,button:'left',clickCount:1});
  await page.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:cropBox.x+20,y:cropBox.y+10,buttons:1});
  await page.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:cropBox.x+20,y:cropBox.y+10,button:'left',clickCount:1});
  assert.notEqual(await page.evaluate("document.querySelector('.avatar-crop-stage image').getAttribute('x')"),beforeDrag);

  await page.click('.avatar-crop-dialog footer button:first-child');
  assert.equal((await db.prepare("SELECT avatar_data FROM auth_user WHERE display_name='QA 昵称'").first()).avatar_data,null,'cancelled crop does not update avatar');
  // PROFILE-04: saving from the public avatar crop commits directly without opening the drawer.
  const {root:finalDom}=await page.command('DOM.getDocument');
  const {nodeId:finalInput}=await page.command('DOM.querySelector',{nodeId:finalDom.nodeId,selector:'.profile-direct-file'});
  const jpeg=await page.evaluate("(()=>{const c=document.createElement('canvas');c.width=800;c.height=400;const ctx=c.getContext('2d');ctx.fillStyle='#b96543';ctx.fillRect(0,0,400,400);ctx.fillStyle='#234e5b';ctx.fillRect(400,0,400,400);return c.toDataURL('image/jpeg').split(',')[1];})()");
  const photo=join(evidence,'synthetic-photo.jpg');writeFileSync(photo,Buffer.from(jpeg,'base64'));
  await page.command('DOM.setFileInputFiles',{nodeId:finalInput,files:[photo]});
  await page.wait("Boolean(document.querySelector('.avatar-crop-stage'))");
  await page.screenshot(join(evidence,'avatar-crop-landscape.png'));
  await page.click('.avatar-crop-save');await page.wait("!document.querySelector('.avatar-crop-dialog') && Boolean(document.querySelector('.profile-identity img'))");
  assert.equal(await page.evaluate(drawer),false);
  assert.equal(await page.evaluate("document.querySelector('.profile-identity h2').textContent"),'QA 昵称');
  const saved=(await db.prepare("SELECT avatar_data FROM auth_user WHERE display_name='QA 昵称'").first()).avatar_data;
  const png=Buffer.from(saved.split(',')[1],'base64');assert.ok(png.length<=100000);assert.ok(png.readUInt32BE(16)<=256);assert.equal(png.readUInt32BE(16),png.readUInt32BE(20));
  console.log('PASS PROFILE-04 crop preview/cancel, zoom/position, square PNG export, direct avatar save');
  console.log('PASS PROFILE-01/02 display at 1440/390, no redundant drawer, avatar validation and crop cancellation');
}
