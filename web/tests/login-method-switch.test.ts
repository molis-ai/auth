import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

test('switching after a throttled challenge cancels the transaction before changing method', async()=>{
  const source=readFileSync(new URL('../src/AuthenticationPanel.vue',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function chooseMethod('),source.indexOf('\nlet active ='));
  const js=ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const ref=(value:unknown)=>({value});
  const busy=ref(false),method=ref('PHONE_OTP'),retryAt=ref(123),address=ref('13800000000'),failure=ref('RATE_LIMITED');
  const password=ref(''),confirm=ref(''),showPassword=ref(false);
  let release:()=>void=()=>{},cancelled=0;
  const cancel=()=>{cancelled++;return new Promise<void>(resolve=>{release=resolve})};
  const choose= new Function('busy','props','providerPending','method','cancel','active','retryAt','address','rememberedEmail','failure','password','confirm','showPassword','nextTick','submit',js+';return chooseMethod;')(busy,{blocked:false},ref(false),method,cancel,true,retryAt,address,()=> 'saved@example.test',failure,password,confirm,showPassword,async()=>{},()=>{});
  const switching=choose('EMAIL_PASSWORD');
  assert.equal(cancelled,1);assert.equal(busy.value,true);assert.equal(method.value,'PHONE_OTP');
  await choose('GOOGLE');assert.equal(cancelled,1); // no competing switch during cancellation
  release();await switching;
  assert.equal(method.value,'EMAIL_PASSWORD');assert.equal(address.value,'saved@example.test');
  assert.equal(failure.value,'');assert.equal(retryAt.value,0);assert.equal(busy.value,false);
  const buttons=source.split('\n').filter(line=>line.includes('@click="chooseMethod'));
  assert.ok(buttons.length>=3);
  for(const line of buttons)assert.doesNotMatch(line,/!!transaction/);
});
