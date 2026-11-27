import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("AUTH-U-03 browser presentation uses the shared BFF client and keeps secrets outside browser persistence", () => {
  const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
  const preferencesPath = join(sourceDirectory, "features", "auth-entry", "entry-preferences.ts");
  const source = readdirSync(sourceDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(vue|ts)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => file !== preferencesPath)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(
    source,
    /localStorage|sessionStorage|accessToken|refreshToken|\/api\/v1|\/oauth2|Bearer /,
  );
  for (const label of [
    "邮箱注册",
    "找回密码",
    "账号安全",
    "团队",
    "应用管理",
    "用户与权限",
    "团队管理",
    "审计日志",
    "退出所有产品和设备",
  ])
    assert.ok(source.includes(label), label);
  assert.match(source, /onBeforeUnmount/);
  assert.match(source, /role="alert"/);
  assert.doesNotMatch(
    source,
    /PlatformServices|SERVICE_READ|SERVICE_WRITE|创建服务凭据/,
  );
});


test("entry preferences store only an explicitly remembered email and locale", async () => {
  const {rememberEmail, rememberedEmail} = await import('../src/features/auth-entry/entry-preferences.ts');
  const values = new Map<string,string>();
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {configurable:true, value:{getItem:(key:string)=>values.get(key)??null, setItem:(key:string,value:string)=>values.set(key,value), removeItem:(key:string)=>values.delete(key)}});
  try {
    assert.equal(rememberedEmail(), '');
    rememberEmail('qa@example.test');
    assert.deepEqual([...values], [['molis.auth.remembered-email','qa@example.test']]);
    assert.equal(rememberedEmail(), 'qa@example.test');
    rememberEmail(''); assert.equal(values.size,0);
    const source = readFileSync(new URL('../src/features/auth-entry/entry-preferences.ts', import.meta.url),'utf8');
    assert.doesNotMatch(source, /accessToken|refreshToken|Bearer |password\s*[:=]/);
  } finally { if(old)Object.defineProperty(globalThis,'localStorage',old);else Reflect.deleteProperty(globalThis,'localStorage'); }
});
