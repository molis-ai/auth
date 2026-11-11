<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { AccountClient } from "../../sdk/browser/src/index.ts";
import { accountErrorMessage } from "./errors.ts";
const props = defineProps<{
  client: AccountClient;
  applicationId: string;
  capabilities: string[];
}>();
interface LoginClient {
  clientId: string;
  clientType: string;
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
      .map((line) => line.trim())
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
  <section>
    <h3>登录客户端</h3>
    <p v-if="message" role="alert">{{ message }}</p>
    <button
      v-if="capabilities.includes('CLIENT_READ')"
      :disabled="busy"
      @click="run(load)"
    >
      刷新客户端
    </button>
    <div v-for="c in clients" :key="c.clientId" class="v2-row">
      <span>{{ c.clientId }} · {{ c.clientType }} · {{ c.status }}</span>
      <button v-if="canWrite()" :disabled="busy" @click="edit(c)">
        修改客户端
      </button>
    </div>
    <form
      v-if="selected && canWrite()"
      class="v2-client-edit"
      @submit.prevent="save"
    >
      <h3>修改 {{ selected.clientId }}</h3>
      <label
        >状态<select v-model="editStatus" aria-label="客户端状态">
          <option>ACTIVE</option>
          <option>DISABLED</option>
        </select></label
      >
      <label
        >允许来源（每行一个）<textarea
          v-model="editOrigins"
          required
          maxlength="4096"
        />
      </label>
      <label
        >精确回调地址（每行一个）<textarea
          v-model="editCallbacks"
          required
          maxlength="4096"
        />
      </label>
      <button :disabled="busy">保存客户端</button
      ><button type="button" :disabled="busy" @click="selected = undefined">
        取消修改
      </button>
    </form>
    <form v-if="canWrite()" class="v2-client-create" @submit.prevent="create">
      <h3>登记登录客户端</h3>
      <div class="console-grid">
        <label>客户端 ID<input v-model="clientId" required /></label>
        <label
          >类型<select v-model="kind">
            <option>WEB</option>
            <option>MACOS</option>
            <option>CLI</option>
          </select></label
        >
        <label>环境 ID<input v-model="environment" required /></label>
        <label
          >产品<select v-model="product">
            <option value="">账号管理</option>
            <option>WORK</option>
            <option>CLUB</option>
          </select></label
        >
        <label>产品来源<input v-model="origin" type="url" required /></label>
        <label
          >精确回调地址<input v-model="callback" type="url" required
        /></label>
      </div>
      <button :disabled="busy">登记客户端</button>
    </form>
  </section>
</template>
