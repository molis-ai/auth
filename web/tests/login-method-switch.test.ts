import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {mayChooseAuthMethod} from '../src/features/auth-entry/auth-flow.ts';

test('switching after a throttled challenge cancels the transaction before changing method', async()=>{
  const source=readFileSync(new URL('../src/features/auth-entry/AuthenticationPanel.vue',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function chooseMethod('),source.indexOf('\nlet active ='));
  const js=ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const ref=(value:unknown)=>({value});
  const busy=ref(false),method=ref('PHONE_OTP'),retryAt=ref(123),address=ref('13800000000'),failure=ref('RATE_LIMITED');
  const password=ref(''),confirm=ref(''),showPassword=ref(false);
  let release:()=>void=()=>{},cancelled=0;
  const cancel=()=>{cancelled++;return new Promise<void>(resolve=>{release=resolve})};
  const choose= new Function('mayChooseAuthMethod','busy','props','providerPending','method','cancel','active','retryAt','address','rememberedEmail','failure','password','confirm','showPassword','nextTick','submit',js+';return chooseMethod;')(mayChooseAuthMethod,busy,{blocked:false},ref(false),method,cancel,true,retryAt,address,()=> 'saved@example.test',failure,password,confirm,showPassword,async()=>{},()=>{});
  const switching=choose('EMAIL_PASSWORD');
  assert.equal(cancelled,1);assert.equal(busy.value,true);assert.equal(method.value,'PHONE_OTP');
  await choose('GOOGLE');assert.equal(cancelled,1); // no competing switch during cancellation
  release();await switching;
  assert.equal(method.value,'EMAIL_PASSWORD');assert.equal(address.value,'saved@example.test');
  assert.equal(failure.value,'');assert.equal(retryAt.value,0);assert.equal(busy.value,false);
  const buttons=source.split('\n').filter(line=>line.includes('@click="chooseMethod'));
  assert.equal(buttons.length,2); // three account tabs and two social buttons, each rendered by its own loop
  assert.match(buttons[0], /v-for="\[value,label\] in loginAccountMethods"/);
  assert.match(buttons[1], /v-for="\[provider,label\] in loginProviders"/);
  assert.match(source, /const accountChoices = .*EMAIL_PASSWORD.*EMAIL_CODE.*PHONE_OTP/);
  assert.match(source, /const providerChoices = .*GOOGLE.*GITHUB/);
  for(const line of buttons)assert.doesNotMatch(line,/!!transaction/);
});
