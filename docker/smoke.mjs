// Local-only API acceptance. Creates one test account; never touches existing accounts.
import {randomBytes, createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const origin='http://localhost:8080';
const mailOrigin=process.env.SMOKE_MAIL_ORIGIN || 'http://localhost:8025';
assert.ok(['http://localhost:8025','http://mailpit:8025'].includes(mailOrigin));
const admin=process.env.SMOKE_ADMIN === 'true';
const email=admin ? 'admin@example.com' : `docker-smoke-${Date.now()}@example.test`;
const password=admin ? 'woyidingfacai' : process.env.SMOKE_PASSWORD || randomBytes(24).toString('base64url');
const verifier=randomBytes(32).toString('base64url');
const state=randomBytes(24).toString('base64url');
let tx;
async function post(path,body,cookie) {
  const response=await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(tx?{'X-Auth-Transaction':tx}:{}),...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  assert.equal(response.status,200,`${path}: ${response.status} ${result.error?.code || ''}`);
  return {data:result.data,cookie:response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
}
const begin=await post('/api/v1/auth/transactions',{clientId:'molis-auth-console',redirectUri:origin+'/console/callback',codeChallenge:createHash('sha256').update(verifier).digest('base64url'),codeChallengeMethod:'S256',state,scopes:['account','profile'],forceLogin:true});
tx=begin.data.transaction;
if (admin) {
  await post('/api/v1/auth/transactions/password',{email,password});
} else {
const challenge=(await post('/api/v1/auth/transactions/mailbox',{email,purpose:'REGISTER',locale:'zh-CN'})).data.challenge;
let message;
for(let i=0;i<30;i++) {
  const inbox=await (await fetch(mailOrigin+'/api/v1/messages',{signal:AbortSignal.timeout(5000)})).json();
  const found=inbox.messages.find(m=>m.To?.some(to=>to.Address===email));
  if(found) {message=await (await fetch(mailOrigin+'/api/v1/message/'+found.ID)).json(); break;}
  await new Promise(resolve=>setTimeout(resolve,1000));
}
assert.ok(message,'SMTP verification mail must arrive within 30 seconds');
const link=message.Text.match(/http:\/\/localhost:8080\/verify-email#[^\s]+/)?.[0];
assert.ok(link,'Verification link missing');
const params=new URLSearchParams(new URL(link).hash.slice(1));
assert.equal(params.get('challenge'),challenge);
assert.equal((await post('/api/v1/auth/mailbox/verify',{challenge,secret:params.get('token'),confirmed:true})).data.verified,true);
const registered=await post('/api/v1/auth/transactions/register',{challenge,displayName:'Docker Smoke Test',password,locale:'zh-CN'});
assert.ok(registered.data.continueUrl.startsWith(origin+'/complete#'));
}
const preview=await post('/api/v1/auth/transactions/confirmation',{});
const completed=await post('/api/v1/auth/transactions/complete',{confirmation:preview.data.confirmation,confirmed:true},preview.cookie);
const callback=new URL(completed.data.redirectTo);
assert.equal(callback.searchParams.get('state'),state);
const tokenResponse=await fetch(origin+'/oauth2/token',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:'molis-auth-console',redirect_uri:origin+'/console/callback',code:callback.searchParams.get('code'),code_verifier:verifier})});
assert.equal(tokenResponse.status,200);
const tokens=await tokenResponse.json();
const me=await fetch(origin+'/api/v1/users/me',{headers:{Origin:origin,Authorization:'Bearer '+tokens.access_token}});
assert.equal(me.status,200);
assert.ok((await me.json()).data.emails.includes(email));
if (admin) {
  const platform=await fetch(origin+'/api/v1/platform/me',{headers:{Origin:origin,Authorization:'Bearer '+tokens.access_token}});
  assert.equal(platform.status,200,'Development admin must have platform access');
}
console.log(admin ? 'PASS: development admin login, explicit confirmation, PKCE token exchange, authenticated /me and platform admin access' : 'PASS: SMTP delivery, mailbox verification, registration, explicit confirmation, PKCE token exchange, authenticated /me');
console.log('Local test account: '+email);
// Revoke the API test grant. Passwords, tokens and mailbox proofs are never printed.
const logout=await fetch(origin+'/api/v1/sessions/current/logout',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json'},body:'{}'});
assert.equal(logout.status,200);
const after=await fetch(origin+'/api/v1/users/me',{headers:{Origin:origin,Authorization:'Bearer '+tokens.access_token}});
assert.equal(after.status,401);
console.log('PASS: logout invalidates the access token');
