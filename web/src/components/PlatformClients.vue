<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { AccountClient } from "../lib/account-client.ts";
import { accountErrorMessage } from "../lib/errors.ts";
const props = defineProps<{
  client: AccountClient;
  applicationId: string;
  capabilities: string[];
}>();
interface LoginClient {
  clientId: string;
  clientType: string;
  product?: string | null;
  status: string;
  version: number;
  policyVersion: number;
  allowedOrigins: string[];
  redirectAllowlist: string[];
  environmentId: string;
}
const clients = ref<LoginClient[]>([]),
  selected = ref<LoginClient>(),
  busy = ref(false),
  message = ref("");
const clientId = ref(""),
  kind = ref("WEB"),
  environment = ref(""),
  product = ref("");
const origin = ref(""),
  callback = ref(""),
  editStatus = ref("ACTIVE"),
  editOrigins = ref(""),
  editCallbacks = ref("");
let active = true;
onBeforeUnmount(() => {
  active = false;
});
const canWrite = () => props.capabilities.includes("CLIENT_WRITE");
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    await fn();
  } catch (error) {
    if (active) message.value = accountErrorMessage(error);
  } finally {
    if (active) busy.value = false;
  }
}
async function load() {
  if (!props.capabilities.includes("CLIENT_READ")) return;
  const items: LoginClient[] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: { items: LoginClient[]; nextCursor: string | null } =
      await props.client.request(
        "/platform/applications/" +
          props.applicationId +
          "/clients?limit=100" +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw Error("分页状态已变化，请刷新");
    if (cursor) seen.add(cursor);
  } while (cursor);
  if (active) clients.value = items;
}
function edit(client: LoginClient) {
  selected.value = client;
  editStatus.value = client.status;
  editOrigins.value = client.allowedOrigins.join("\n");
  editCallbacks.value = client.redirectAllowlist.join("\n");
}
async function create() {
  await run(async () => {
    await props.client.request(
      "/platform/applications/" + props.applicationId + "/clients",
      {
        clientId: clientId.value,
        clientType: kind.value,
        environmentId: environment.value,
        allowedOrigins: [origin.value],
        redirectAllowlist: [callback.value],
        ...(product.value ? { product: product.value } : {}),
      },
      "POST",
      crypto.randomUUID(),
    );
    if (active) {
      clientId.value = "";
      await load();
    }
  });
}
async function save() {
  const client = selected.value!;
  const lines = (value: string) =>
    value
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
  await run(async () => {
    await props.client.request(
      "/platform/clients/" + client.clientId,
      {
        status: editStatus.value,
        allowedOrigins: lines(editOrigins.value),
        redirectAllowlist: lines(editCallbacks.value),
        expectedVersion: client.version,
        expectedPolicyVersion: client.policyVersion,
      },
      "PATCH",
      crypto.randomUUID(),
    );
    if (active) {
      selected.value = undefined;
      await load();
    }
  });
}
onMounted(() => void run(load));
</script>
<template>
  <section class="pc-section">
    <div class="pc-card">
      <div class="pc-head">
        <div>
          <h3>登录客户端（{{ clients.length }}）</h3>
          <p class="pc-sub">严格校验允许来源（Allowed Origins）与精确回调地址</p>
        </div>
        <button
          v-if="capabilities.includes('CLIENT_READ')"
          type="button"
          class="pc-refresh"
          :disabled="busy"
          @click="run(load)"
        >
          刷新客户端
        </button>
      </div>

      <p v-if="message" class="pc-alert" role="alert">{{ message }}</p>

      <div v-if="clients.length" class="pc-list">
        <div v-for="c in clients" :key="c.clientId" class="v2-row pc-item">
          <div class="pc-item-head">
            <div class="pc-item-tags">
              <strong class="pc-mono">{{ c.clientId }}</strong>
              <span class="pc-pill is-accent">{{ c.clientType }}</span>
              <span class="pc-pill is-neutral">{{ c.environmentId }}</span>
              <span v-if="c.product" class="pc-pill is-dark">{{ c.product }}</span>
              <span class="pc-pill" :class="c.status === 'ACTIVE' ? 'is-success' : 'is-danger'">{{ c.status }}</span>
            </div>
            <button v-if="canWrite()" type="button" class="pc-edit-btn" :disabled="busy" @click="edit(c)">
              修改客户端
            </button>
          </div>
          <div class="pc-uris">
            <div>
              <span class="pc-uri-label">允许来源</span>
              <span class="pc-uri-chips"><code v-for="item in c.allowedOrigins" :key="item">{{ item }}</code></span>
            </div>
            <div>
              <span class="pc-uri-label">精确回调</span>
              <span class="pc-uri-chips"><code v-for="item in c.redirectAllowlist" :key="item">{{ item }}</code></span>
            </div>
          </div>
        </div>
      </div>
      <p v-else class="pc-empty">该应用下暂无已登记的登录客户端。</p>

      <form v-if="selected && canWrite()" class="v2-client-edit pc-form" @submit.prevent="save">
        <h4>修改 {{ selected.clientId }}</h4>
        <label>状态<select v-model="editStatus" aria-label="客户端状态">
          <option>ACTIVE</option>
          <option>DISABLED</option>
        </select></label>
        <label>允许来源（每行一个）<textarea v-model="editOrigins" required maxlength="4096" /></label>
        <label>精确回调地址（每行一个）<textarea v-model="editCallbacks" required maxlength="4096" /></label>
        <div class="pc-form-actions">
          <button class="pc-primary" :disabled="busy">保存客户端</button>
          <button type="button" class="pc-secondary" :disabled="busy" @click="selected = undefined">取消修改</button>
        </div>
      </form>
    </div>

    <form v-if="canWrite()" class="v2-client-create pc-card pc-form" @submit.prevent="create">
      <div class="pc-head pc-head-tight">
        <div>
          <h3>登记登录客户端</h3>
          <p class="pc-sub">为当前应用新增 Web、macOS 或 CLI 登录客户端白名单配置</p>
        </div>
      </div>
      <div class="pc-create-grid">
        <label>客户端 ID<input v-model="clientId" required placeholder="例如：molis-studio-web" /></label>
        <label>类型<select v-model="kind">
          <option>WEB</option>
          <option>MACOS</option>
          <option>CLI</option>
        </select></label>
        <label>环境 ID<input v-model="environment" required placeholder="例如：prod-cn" /></label>
        <label>产品<select v-model="product">
          <option value="">账号管理</option>
          <option>WORK</option>
          <option>CLUB</option>
        </select></label>
        <label>产品来源<input v-model="origin" type="url" required placeholder="https://studio.molis.ai" /></label>
        <label>精确回调地址<input v-model="callback" type="url" required placeholder="https://studio.molis.ai/account/callback" /></label>
      </div>
      <div class="pc-form-actions">
        <button class="pc-primary" :disabled="busy">登记客户端</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.pc-section { display: grid; gap: 16px; }
.pc-card {
  padding: 20px 22px; border: 1px solid var(--line); border-radius: 14px;
  background: var(--surface); box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.pc-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.pc-head-tight { margin-bottom: 4px; }
.pc-head h3, .pc-form h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); }
.pc-sub { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
.pc-section button.pc-refresh,
.pc-section button.pc-edit-btn {
  min-height: 30px; height: 30px; padding: 0 11px; border-radius: 7px;
  border: 1px solid #d5d5db; background: var(--surface); color: var(--ink); font-size: 12px; font-weight: 500;
}
.pc-section button.pc-refresh:enabled:hover,
.pc-section button.pc-edit-btn:enabled:hover { background: #fafafb; border-color: #c2c2cb; }
.pc-alert { margin: 0 0 12px; padding: 10px 12px; border-radius: 9px; background: #fdf1f2; border: 1px solid #f4d3d6; color: #a32921; font-size: 13px; }
.pc-list { display: grid; gap: 12px; }
.pc-item { padding: 16px 18px; border: 1px solid var(--line); border-radius: 11px; background: #fafafb; display: grid; gap: 10px; }
.pc-item-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.pc-item-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13.5px; color: var(--ink); }
.pc-pill {
  display: inline-flex; align-items: center; height: 22px; padding: 0 9px;
  border-radius: 999px; font-size: 11.5px; font-weight: 500; border: 1px solid transparent;
}
.pc-pill.is-accent { background: var(--accent-soft); color: var(--accent); border-color: #d5def5; }
.pc-pill.is-neutral { background: #efeff2; color: var(--muted); border-color: #e2e2e7; }
.pc-pill.is-dark { background: #222227; color: #f5f5f7; }
.pc-pill.is-success { background: #ecf7f0; color: #216b46; border-color: #cbe8d7; }
.pc-pill.is-danger { background: #fdf1f2; color: #a62b33; border-color: #f4d3d6; }
.pc-uris { display: grid; gap: 6px; font-size: 12px; }
.pc-uris > div { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pc-uri-label { color: var(--muted); min-width: 4.5em; }
.pc-uri-chips { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.pc-uris code {
  padding: 3px 8px; border-radius: 6px; background: var(--surface); border: 1px solid var(--line);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11.5px; color: #3f3f46; overflow-wrap: anywhere;
}
.pc-empty { margin: 0; font-size: 13px; color: var(--muted); }
.pc-form { max-width: none; margin: 0; display: grid; gap: 14px; }
.pc-form.v2-client-edit { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.pc-form h4 { margin: 0; font-size: 14px; font-weight: 600; color: var(--ink); }
.pc-create-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; }
.pc-form label { display: grid; gap: 5px; margin: 0; font-size: 12.5px; font-weight: 500; color: #3f3f46; }
.pc-form input, .pc-form select { margin: 0; height: 38px; min-height: 38px; }
.pc-form textarea { min-height: 82px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; padding: 9px 11px; margin: 0; }
.pc-form-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.pc-section button.pc-primary {
  height: 36px; min-height: 36px; padding: 0 16px; border-radius: 8px;
  background: var(--primary); border-color: var(--primary); color: #fff; font-size: 13px; font-weight: 500;
}
.pc-section button.pc-primary:enabled:hover { background: #343439; border-color: #343439; }
.pc-section button.pc-secondary {
  height: 36px; min-height: 36px; padding: 0 14px; border-radius: 8px;
  border: 1px solid #d5d5db; background: var(--surface); color: var(--ink); font-size: 13px; font-weight: 500;
}
@media (max-width: 720px) {
  .pc-create-grid { grid-template-columns: 1fr; }
}
</style>
