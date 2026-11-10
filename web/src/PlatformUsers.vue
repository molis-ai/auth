<script setup lang="ts">
import { accountErrorMessage } from "./errors.ts";
import { onMounted, onBeforeUnmount, ref } from "vue";
import { AccountClient } from "../../sdk/browser/src/index.ts";
import policy from "../../contracts/unified-account/policy.json";
const props = defineProps<{ client: AccountClient; capabilities: string[] }>();
interface User {
  userId: string;
  displayName: string;
  email: string | null;
  status: string;
  version: number;
}
interface Grant {
  capability: string;
  status: string;
  version: number;
}
const emailDraft = ref('');
const users = ref<User[]>([]),
  selected = ref<User>(),
  grants = ref<Grant[]>([]),
  reason = ref(""),
  busy = ref(false),
  message = ref("");
const capabilities = [
  ...new Set(
    policy.permissions
      .map((p) => p.authority)
      .filter((p) => p.startsWith("platform:"))
      .map((p) => p.slice(9)),
  ),
];
let active = true;
onBeforeUnmount(() => {
  active = false;
});
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    await fn();
  } catch (e) {
    if (active) message.value = accountErrorMessage(e);
  } finally {
    if (active) busy.value = false;
  }
}
async function list<T>(path: string) {
  const values: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const p: { items: T[]; nextCursor: string | null } =
      await props.client.request(
        path +
          "?limit=100" +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
    values.push(...p.items);
    cursor = p.nextCursor;
    if (cursor && seen.has(cursor)) throw Error("分页状态已变化");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return values;
}
async function load() {
  const data = await list<User>("/platform/users");
  if (active) users.value = data;
}
async function select(u: User) {
  const data = props.capabilities.includes('PLATFORM_PERMISSION_WRITE') ? await list<Grant>(
    "/platform/users/" + u.userId + "/permissions",
  ) : [];
  if (active) {
    selected.value = u; emailDraft.value = u.email ?? '';
    grants.value = data;
  }
}
async function changeEmail() {
  const u = selected.value!;
  await props.client.request('/platform/users/'+u.userId+'/email',{email:emailDraft.value.trim(),expectedVersion:u.version,reason:reason.value},'PATCH',crypto.randomUUID());
  await load(); selected.value=undefined; emailDraft.value=''; reason.value='';
}
async function status(u: User) {
  if (!reason.value.trim()) throw Error("请填写操作原因");
  await props.client.request(
    "/platform/users/" + u.userId + "/status",
    {
      status: u.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
      expectedVersion: u.version,
      reason: reason.value,
    },
    "PATCH",
    crypto.randomUUID(),
  );
  await load();
  selected.value = undefined;
  reason.value = "";
}
async function permission(capability: string) {
  const u = selected.value!,
    g = grants.value.find((g) => g.capability === capability);
  if (!reason.value.trim()) throw Error("请填写操作原因");
  await props.client.request(
    "/platform/users/" + u.userId + "/permissions/" + capability,
    {
      enabled: g?.status !== "ACTIVE",
      expectedVersion: g?.version ?? null,
      reason: reason.value,
    },
    "PATCH",
    crypto.randomUUID(),
  );
  await select(u);
  reason.value = "";
}
onMounted(() => void run(load));
</script>
<template>
  <section class="console-card">
    <h1>用户与平台权限</h1>
    <p v-if="message" role="alert">{{ message }}</p>
    <button :disabled="busy" @click="run(load)">刷新用户</button
    ><label>操作原因<input v-model="reason" maxlength="500" /></label>
    <div v-for="u in users" :key="u.userId" class="v2-row">
      <button :disabled="busy" @click="run(() => select(u))">
        {{ u.displayName }}</button
      ><span>{{ u.userId }} · {{ u.status }}</span
      ><button
        v-if="
          capabilities.includes('USER_STATUS') &&
          props.capabilities.includes('USER_STATUS')
        "
        :disabled="busy || !reason.trim()"
        @click="run(() => status(u))"
      >
        {{ u.status === "ACTIVE" ? "停用账号" : "恢复账号" }}
      </button>
    </div>
    <template v-if="selected"
      ><form v-if="props.capabilities.includes('USER_EMAIL_WRITE')" @submit.prevent="run(changeEmail)"><h2>维护邮箱</h2><p>修改后，该用户在所有产品和设备上的登录都会失效。请先核实邮箱归属。</p><label>邮箱<input v-model="emailDraft" type="email" required maxlength="254" /></label><button :disabled="busy || !reason.trim() || !emailDraft.trim()">保存邮箱并撤销登录</button></form><h2>{{ selected.displayName }} 的平台权限</h2>
      <div v-for="capability in capabilities" :key="capability" class="v2-row">
        <span
          >{{ capability }} ·
          {{
            grants.find((g) => g.capability === capability)?.status ?? "未授予"
          }}</span
        ><button
          v-if="props.capabilities.includes('PLATFORM_PERMISSION_WRITE')"
          :disabled="busy || !reason.trim()"
          @click="run(() => permission(capability))"
        >
          {{
            grants.find((g) => g.capability === capability)?.status === "ACTIVE"
              ? "撤销"
              : "授予"
          }}
        </button>
      </div></template
    >
  </section>
</template>
