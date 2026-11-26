<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { AuthError, type AccountClient } from "../lib/account-client.ts";
import { accountErrorMessage } from "../lib/errors.ts";
import type { WriteOptions } from "../lib/idempotent-submit.ts";

const props = defineProps<{
  client: AccountClient;
  applicationId: string;
  capabilities: string[];
  submitWrite: <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;
}>();
const emit = defineEmits<{ count: [applicationId: string, count: number]; expired: [error: unknown] }>();
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

const canRead = computed(() => props.capabilities.includes("CLIENT_READ"));
const canWrite = computed(() => props.capabilities.includes("CLIENT_WRITE"));
const clients = ref<LoginClient[]>([]);
const busy = ref(false);
const loaded = ref(false);
const message = ref("");
const dialog = ref<HTMLDialogElement>();
const mode = ref<"create" | "edit">();
const selected = ref<LoginClient>();
const dialogError = ref("");
const initialDraft = { clientId: "", kind: "WEB", environment: "", product: "", origin: "", callback: "" };
const draft = reactive({ ...initialDraft });
const editDraft = reactive({ status: "ACTIVE", origins: "", callbacks: "" });
const listPath = "/platform/applications/" + encodeURIComponent(props.applicationId) + "/clients";
let active = true;

async function run(task: () => Promise<void>, errorMessage = message) {
  if (busy.value) return;
  busy.value = true;
  errorMessage.value = "";
  try {
    await task();
  } catch (error) {
    if (!active || (error instanceof AuthError && error.code === "CANCELLED")) return;
    errorMessage.value = accountErrorMessage(error);
    emit("expired", error);
  } finally {
    if (active) busy.value = false;
  }
}

function replaceClients(items: LoginClient[]) {
  clients.value = items;
  emit("count", props.applicationId, items.length);
}

async function load() {
  if (!canRead.value || !active) return;
  const items: LoginClient[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const result: { items: LoginClient[]; nextCursor: string | null } = await props.client.request(
      listPath + "?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
    );
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor && seen.has(cursor)) throw Error("分页状态已变化，请刷新");
    if (cursor) seen.add(cursor);
  } while (cursor && active);
  if (!active) return;
  replaceClients(items);
  loaded.value = true;
}

async function showDialog(nextMode: "create" | "edit") {
  mode.value = nextMode;
  dialogError.value = "";
  await nextTick();
  if (active && mode.value === nextMode) dialog.value?.showModal();
}

function openCreate() {
  if (!canWrite.value || busy.value || mode.value) return;
  Object.assign(draft, initialDraft);
  void showDialog("create");
}

function openEdit(client: LoginClient) {
  if (!canWrite.value || busy.value || mode.value) return;
  selected.value = client;
  editDraft.status = client.status;
  editDraft.origins = client.allowedOrigins.join("\n");
  editDraft.callbacks = client.redirectAllowlist.join("\n");
  void showDialog("edit");
}

function closeDialog() {
  dialog.value?.close();
  mode.value = undefined;
  selected.value = undefined;
}

function cancel() {
  if (!busy.value) closeDialog();
}

function applyClient(saved: LoginClient) {
  if (!active) return;
  if (canRead.value && loaded.value) {
    const items = clients.value.some(client => client.clientId === saved.clientId)
      ? clients.value.map(client => client.clientId === saved.clientId ? saved : client)
      : [...clients.value, saved];
    replaceClients(items);
  }
  closeDialog();
}

function createClient() {
  return run(() => props.submitWrite<LoginClient>(listPath, {
    clientId: draft.clientId.trim(),
    clientType: draft.kind,
    environmentId: draft.environment.trim(),
    allowedOrigins: [draft.origin.trim()],
    redirectAllowlist: [draft.callback.trim()],
    ...(draft.product ? { product: draft.product } : {}),
  }, {
    committed: applyClient,
    after: load,
    success: "客户端已登记",
    refreshMessage: "客户端已登记，但客户端列表暂未刷新。",
  }), dialogError);
}

function saveClient() {
  const client = selected.value;
  if (!client) return;
  const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);
  return run(() => props.submitWrite<LoginClient>("/platform/clients/" + encodeURIComponent(client.clientId), {
    status: editDraft.status,
    allowedOrigins: lines(editDraft.origins),
    redirectAllowlist: lines(editDraft.callbacks),
    expectedVersion: client.version,
    expectedPolicyVersion: client.policyVersion,
  }, {
    method: "PATCH",
    committed: applyClient,
    after: load,
    success: "客户端配置已保存",
    refreshMessage: "客户端配置已保存，但客户端列表暂未刷新。",
  }), dialogError);
}

defineExpose({ openCreate, busy });
onMounted(() => void run(load));
onBeforeUnmount(() => {
  active = false;
  dialog.value?.close();
});
</script>

<template>
  <div class="pc-section">
    <section v-if="canRead" class="app-settings-card">
      <div class="app-card-head">
        <h3>登录客户端{{ loaded ? "（" + clients.length + "）" : "" }}</h3>
        <p>严格校验允许来源（Allowed Origins）与精确回调地址</p>
      </div>
      <div v-if="message" class="pc-alert" role="alert">
        <span>{{ message }}</span>
        <button type="button" class="app-button is-small" :disabled="busy" @click="run(load)">刷新客户端</button>
      </div>
      <div v-if="clients.length" class="pc-list">
        <div v-for="client in clients" :key="client.clientId" class="pc-item">
          <div class="pc-item-head">
            <div class="pc-item-tags">
              <strong class="pc-mono">{{ client.clientId }}</strong>
              <span class="pc-pill is-accent">{{ client.clientType }}</span>
              <span class="pc-pill is-neutral">{{ client.environmentId }}</span>
              <span v-if="client.product" class="pc-pill is-dark">{{ client.product }}</span>
              <span class="pc-pill" :class="client.status === 'ACTIVE' ? 'is-success' : 'is-danger'">{{ client.status }}</span>
            </div>
            <button v-if="canWrite" type="button" class="app-button is-small" :disabled="busy" @click="openEdit(client)">配置白名单</button>
          </div>
          <div class="pc-uris">
            <div>
              <span class="pc-uri-label">允许来源</span>
              <span class="pc-uri-chips"><code v-for="origin in client.allowedOrigins" :key="origin">{{ origin }}</code></span>
            </div>
            <div>
              <span class="pc-uri-label">精确回调</span>
              <span class="pc-uri-chips"><code v-for="callback in client.redirectAllowlist" :key="callback">{{ callback }}</code></span>
            </div>
          </div>
        </div>
      </div>
      <p v-else-if="!loaded && busy" class="pc-empty" role="status">正在读取客户端…</p>
      <p v-else-if="loaded" class="pc-empty">该应用下暂无已登记的登录客户端。</p>
    </section>

    <dialog
      v-if="canWrite"
      ref="dialog"
      class="app-operation-dialog"
      :class="mode === 'create' ? 'v2-client-create' : 'v2-client-edit'"
      aria-labelledby="pc-dialog-title"
      @cancel.prevent="cancel"
    >
      <form v-if="mode" @submit.prevent="mode === 'create' ? createClient() : saveClient()">
        <header class="app-dialog-head">
          <h3 id="pc-dialog-title">{{ mode === "create" ? "登记登录客户端" : "配置白名单" }}</h3>
          <button type="button" class="app-dialog-close" aria-label="关闭" :disabled="busy" @click="cancel">×</button>
        </header>
        <div class="app-dialog-body">
          <template v-if="mode === 'create'">
            <label class="app-field">
              客户端 ID
              <input v-model="draft.clientId" required autofocus :disabled="busy" placeholder="molis-studio-web" />
            </label>
            <div class="pc-fields-row">
              <label class="app-field">
                类型
                <select v-model="draft.kind" :disabled="busy"><option>WEB</option><option>MACOS</option><option>CLI</option></select>
              </label>
              <label class="app-field">
                环境 ID
                <input v-model="draft.environment" required :disabled="busy" placeholder="例如：prod-cn" />
              </label>
            </div>
            <label class="app-field">
              允许来源
              <input v-model="draft.origin" type="url" required :disabled="busy" placeholder="https://studio.molis.ai" />
            </label>
            <label class="app-field">
              精确回调地址
              <input v-model="draft.callback" type="url" required :disabled="busy" placeholder="https://studio.molis.ai/callback" />
            </label>
            <label class="app-field">
              产品
              <select v-model="draft.product" :disabled="busy">
                <option value="">账号管理</option><option>WORK</option><option>CLUB</option>
              </select>
            </label>
          </template>
          <template v-else>
            <p class="pc-mono pc-client-target">{{ selected?.clientId }}</p>
            <label class="app-field">
              状态
              <select v-model="editDraft.status" aria-label="客户端状态" :disabled="busy">
                <option>ACTIVE</option><option>DISABLED</option>
              </select>
            </label>
            <label class="app-field">
              允许来源（每行一个）
              <textarea v-model="editDraft.origins" autofocus required maxlength="4096" :disabled="busy" />
            </label>
            <label class="app-field">
              精确回调地址（每行一个）
              <textarea v-model="editDraft.callbacks" required maxlength="4096" :disabled="busy" />
            </label>
          </template>
          <p v-if="dialogError" class="app-dialog-error" role="alert">{{ dialogError }}</p>
        </div>
        <footer class="app-dialog-foot">
          <button type="button" class="app-button" :disabled="busy" @click="cancel">取消</button>
          <button type="submit" class="app-button is-primary" :disabled="busy">{{ mode === "create" ? "登记" : "保存客户端" }}</button>
        </footer>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.pc-section { min-width: 0; }
.pc-list { display: grid; gap: 12px; }
.pc-item { min-width: 0; padding: 16px 18px; border: 1px solid var(--line); border-radius: 11px; background: #fafafb; display: grid; gap: 10px; }
.pc-item-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.pc-item-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.pc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13.5px; color: var(--ink); overflow-wrap: anywhere; }
.pc-pill {
  display: inline-flex; align-items: center; min-height: 23px; padding: 0 9px;
  border-radius: 999px; font-size: 11.5px; font-weight: 500; border: 1px solid transparent; overflow-wrap: anywhere;
}
.pc-pill.is-accent { background: var(--accent-soft); color: var(--accent); border-color: #d5def5; }
.pc-pill.is-neutral { background: #efeff2; color: var(--muted); border-color: #e2e2e7; }
.pc-pill.is-dark { background: #222227; color: #f5f5f7; }
.pc-pill.is-success { background: #ecf7f0; color: #216b46; border-color: #cbe8d7; }
.pc-pill.is-danger { background: #fdf1f2; color: #a62b33; border-color: #f4d3d6; }
.pc-uris { display: grid; gap: 6px; font-size: 12px; }
.pc-uris > div { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pc-uri-label { color: var(--muted); min-width: 4.5em; }
.pc-uri-chips { display: inline-flex; flex-wrap: wrap; gap: 6px; min-width: 0; max-width: 100%; }
.pc-uris code {
  min-width: 0; max-width: 100%; padding: 3px 8px; border-radius: 6px; background: var(--surface); border: 1px solid var(--line);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11.5px; color: #3f3f46; overflow-wrap: anywhere;
}
.pc-empty, .pc-client-target { margin: 0; }
.pc-empty { font-size: 13px; color: var(--muted); }
.pc-alert {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; padding: 10px 12px;
  border-radius: 9px; background: #fdf1f2; border: 1px solid #f4d3d6; color: #a32921; font-size: 13px;
}
.pc-fields-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
</style>
