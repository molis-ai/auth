<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { AuthError, type AccountClient } from "../lib/account-client.ts";
import { cursorCollection } from "../lib/cursor-collection.ts";
import { accountErrorMessage } from "../lib/errors.ts";
import type { WriteOptions } from "../lib/idempotent-submit.ts";
import TenantMembers from "./TenantMembers.vue";
import { syncCreatedTenant } from "../lib/tenant-selection.ts";

type Tenant = {
  tenantId: string;
  name: string;
  status: string;
  myRole: string;
  membershipId: string;
  version: number;
};
type Member = {
  displayName: string;
  email: string | null;
  membershipId: string;
  userId: string;
  role: string;
  status: string;
  version: number;
};
type Invitation = { invitationId: string; targetSummary: string; status: string; version: number };
type Transfer = {
  transferId: string;
  tenantId: string;
  fromMembershipId: string;
  toMembershipId: string;
  status: string;
  version: number;
};

type Write = <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;
const props = defineProps<{
  client: AccountClient;
  busy: boolean;
  mutate: Write;
  submitWrite: Write;
  discard: (action: string) => void;
  refreshPending: (action: string) => boolean;
}>();
const emit = defineEmits<{ expired: [error: unknown]; dispose: []; clearToast: [] }>();
const invitationChannels = document.querySelector<HTMLMetaElement>(
  'meta[name="molis-tenant-invite-channels"]',
)?.content.split(" ") ?? ["USER"];
const roleLabels: Record<string, string> = { OWNER: "所有者", ADMIN: "管理员", MEMBER: "成员" };

const directory = cursorCollection<Tenant>(props.client);
const memberDirectory = cursorCollection<Member>(props.client);
const received = cursorCollection<Invitation>(props.client);
const ownership = cursorCollection<Transfer>(props.client);
const { loading: tenantsLoading, nextCursor: moreTenants } = directory;
const { loading: membersLoading } = memberDirectory;
const { loading: invitationsLoading, nextCursor: moreInvitations } = received;
const { nextCursor: moreTransfers } = ownership;
const transfersLoading = ref(false);
let transferRead = 0;
let directoryRead = 0;
const selectedTenant = ref<Tenant>();
const tenantSearch = ref("");
const tenants = computed(() => {
  const loaded = directory.items.value;
  const selected = selectedTenant.value;
  const choices = selected && !loaded.some(tenant => tenant.tenantId === selected.tenantId)
    ? [...loaded, selected] : loaded;
  const query = tenantSearch.value.trim().toLowerCase();
  return choices.filter(tenant => tenant.name.toLowerCase().includes(query));
});
const memberPage = ref(1);
const memberSize = ref(10);
const members = computed(() => memberDirectory.pages.value[memberPage.value - 1]?.items ?? []);
const moreMembers = computed(() =>
  memberPage.value < memberDirectory.pages.value.length || Boolean(memberDirectory.nextCursor.value),
);
const invitations = computed(() => received.items.value.filter(item => item.status === "PENDING"));
const transfers = computed(() => ownership.items.value.filter(item => item.status === "PENDING"));
const transferMembers = ref<Record<string, string>>({});
const creationMode = ref("");
const tenantName = ref("");
const tenantCreateDialog = ref<HTMLDialogElement>();
let disposed = false;

type Section = "policy" | "directory" | "members" | "invitations" | "transfers";
const errors = reactive<Partial<Record<Section, { message: string; retry: () => Promise<void> }>>>({});
async function read(section: Section, task: () => Promise<unknown>, restart = task) {
  if (disposed) return;
  delete errors[section];
  try {
    await task();
  } catch (error) {
    if (disposed || (error instanceof AuthError && error.code === "CANCELLED")) return;
    emit("expired", error);
    const retry = error instanceof AuthError && error.code === "INVALID_REQUEST" ? restart : task;
    errors[section] = { message: accountErrorMessage(error), retry: () => read(section, retry, restart) };
  }
}

const tenantPath = (id: string) => "/tenants/" + encodeURIComponent(id);
async function refreshDirectory(reconcileSelection = true) {
  if (disposed) return;
  const request = ++directoryRead;
  if (!(await directory.first("/tenants")) || request !== directoryRead) return;
  const selected = selectedTenant.value;
  if (!reconcileSelection || !selected) return;
  let latest: Tenant | undefined;
  try {
    latest = await lookupTenant(selected.tenantId);
  } catch (error) {
    if (disposed || request !== directoryRead || selectedTenant.value !== selected) return;
    if (!(error instanceof AuthError && error.code === "TENANT_DISABLED")) throw error;
  }
  if (disposed || request !== directoryRead || selectedTenant.value !== selected) return;
  selectedTenant.value = latest;
  if (latest?.status !== "ACTIVE") clearMembers();
  else if (latest.membershipId !== selected.membershipId || selected.status !== "ACTIVE") {
    clearMembers();
    await read("members", () => reloadMembers(latest));
  }
}
const refreshInvitations = async () => {
  if (!disposed) await received.first("/invitations");
};

function clearMembers() {
  delete errors.members;
  memberPage.value = 1;
  memberDirectory.clear();
}
async function reloadMembers(tenant: Tenant) {
  if (disposed || selectedTenant.value?.tenantId !== tenant.tenantId || tenant.status !== "ACTIVE") return;
  if (await memberDirectory.first(tenantPath(tenant.tenantId) + "/members", memberSize.value)) {
    memberPage.value = 1;
  }
}
function selectTenant(tenant: Tenant) {
  selectedTenant.value = tenant;
  memberSize.value = 10;
  clearMembers();
  return read("members", () => reloadMembers(tenant));
}
function changeMemberSize(size: number) {
  memberSize.value = size;
  clearMembers();
  const tenant = selectedTenant.value;
  if (tenant) void read("members", () => reloadMembers(tenant));
}
async function nextMemberPage() {
  if (membersLoading.value) return;
  if (memberPage.value < memberDirectory.pages.value.length) {
    memberPage.value++;
  } else {
    await read("members", async () => {
      if (await memberDirectory.more()) memberPage.value++;
    }, async () => {
      if (selectedTenant.value) await reloadMembers(selectedTenant.value);
    });
  }
}
async function ownMembership(tenant: Tenant) {
  const match = () => memberDirectory.items.value.find(member => member.membershipId === tenant.membershipId);
  let own = match();
  // The API supplies membership versions only in the member directory.
  // Read further pages only when a member explicitly requests to leave.
  while (!own && !disposed && selectedTenant.value?.tenantId === tenant.tenantId
      && await memberDirectory.more()) own = match();
  return own;
}

async function lookupTenant(id: string) {
  const loaded = directory.items.value.find(tenant => tenant.tenantId === id);
  if (loaded) return loaded;
  try {
    return await props.client.request<Tenant>(tenantPath(id));
  } catch (error) {
    if (error instanceof AuthError && error.status === 404) return undefined;
    throw error;
  }
}

async function readTransfers(append = false, refreshedDirectory?: Promise<void>) {
  if (disposed || (append && transfersLoading.value)) return;
  const request = ++transferRead;
  transfersLoading.value = true;
  try {
    // Load the transfer page in parallel, then resolve its participant IDs from the refreshed directory.
    await Promise.all([append ? ownership.more() : ownership.first("/ownership-transfers"), refreshedDirectory]);
    if (disposed || request !== transferRead) return;
    const known = append ? transferMembers.value : {};
    const ids = [...new Set(transfers.value.map(transfer => transfer.tenantId))]
      .filter(id => !Object.hasOwn(known, id));
    const memberships = await Promise.all(ids.map(async id => {
      const tenant = await lookupTenant(id);
      return [id, tenant?.membershipId ?? ""] as const;
    }));
    if (!disposed && request === transferRead) transferMembers.value = { ...known, ...Object.fromEntries(memberships) };
  } catch (error) {
    if (!disposed && request === transferRead) throw error;
  } finally {
    if (request === transferRead) transfersLoading.value = false;
  }
}
function transferOperation(transfer: Transfer): "accept" | "cancel" | undefined {
  const member = transferMembers.value[transfer.tenantId];
  if (member === transfer.toMembershipId) return "accept";
  if (member === transfer.fromMembershipId) return "cancel";
}
function updateTransfer(transfer: Transfer) {
  const operation = transferOperation(transfer);
  if (!operation) return;
  return props.mutate(
    "/ownership-transfers/" + encodeURIComponent(transfer.transferId) + "/" + operation,
    { expectedVersion: transfer.version },
    {
      committed: () => {
        ownership.remove(item => item.transferId === transfer.transferId);
        selectedTenant.value = undefined;
        clearMembers();
      },
      after: refreshDirectoryAndTransfers,
      refreshMessage: "所有权交接已更新，但交接或租户列表暂未刷新。",
    },
  );
}
function updateInvitation(invitation: Invitation, operation: "accept" | "decline") {
  return props.mutate(
    "/invitations/" + encodeURIComponent(invitation.invitationId) + "/" + operation,
    { expectedVersion: invitation.version },
    {
      committed: () => received.remove(item => item.invitationId === invitation.invitationId),
      after: async () => {
        if (operation === "accept") await Promise.all([refreshDirectory(), refreshInvitations()]);
        else await refreshInvitations();
      },
      refreshMessage: operation === "accept" ? "已接受邀请，但租户或邀请列表暂未刷新。" : "已拒绝邀请，但邀请列表暂未刷新。",
    },
  );
}
function left(id: string) {
  if (selectedTenant.value?.tenantId === id) {
    selectedTenant.value = undefined;
    clearMembers();
  }
  directory.remove(tenant => tenant.tenantId === id);
}
function refreshDirectoryAndTransfers() {
  return readTransfers(false, refreshDirectory());
}

watch(() => tenantName.value.trim(), () => props.discard("create-tenant"), { flush: "sync" });
function openTenantCreate() {
  tenantName.value = "";
  emit("clearToast");
  tenantCreateDialog.value?.showModal();
}
function closeTenantCreate() {
  if (props.busy) return;
  tenantCreateDialog.value?.close();
  tenantName.value = "";
  emit("clearToast");
}
function createTenant() {
  const name = tenantName.value.trim();
  if (!name) return;
  return props.mutate<Tenant>("/tenants", { name }, {
    action: "create-tenant",
    success: "租户已创建",
    refreshMessage: "租户已创建，但租户列表或成员暂未刷新。",
    committed: created => {
      tenantCreateDialog.value?.close();
      tenantName.value = "";
      tenantSearch.value = "";
      selectedTenant.value = created;
      memberSize.value = 10;
      clearMembers();
    },
    after: async created => {
      await refreshDirectory(false);
      if (disposed || selectedTenant.value?.tenantId !== created.tenantId) return;
      const current = await lookupTenant(created.tenantId);
      await syncCreatedTenant(created.tenantId, current ? [current] : [], selectedTenant,
        clearMembers, reloadMembers);
    },
  });
}

onMounted(() => {
  void read("policy", async () => {
    creationMode.value = (await props.client.request<{ mode: string }>("/tenant-creation-policy")).mode;
  });
  void read("directory", async () => {
    await refreshDirectory();
    if (!disposed && !selectedTenant.value && directory.items.value[0]) {
      await selectTenant(directory.items.value[0]);
    }
  });
  void read("invitations", refreshInvitations);
  void read("transfers", () => readTransfers());
});
onBeforeUnmount(() => {
  disposed = true;
  for (const collection of [directory, memberDirectory, received, ownership]) collection.clear();
  props.discard("create-tenant");
  emit("dispose");
});
</script>

<template>
  <section class="console-card collection-page tenant-page">
    <h1>我的租户</h1>
    <div class="collection-layout">
      <aside class="collection-list" aria-label="租户列表" :aria-busy="tenantsLoading">
        <input v-model="tenantSearch" type="search" aria-label="搜索已加载的租户" placeholder="搜索租户" />
        <button v-if="creationMode === 'SELF_SERVICE'" class="tenant-create-trigger" :disabled="busy" @click="openTenantCreate">＋ 创建租户</button>
        <p v-else-if="creationMode">租户由平台创建并分配。</p>
        <div v-if="errors.policy" role="alert">{{ errors.policy.message }} <button @click="errors.policy.retry()">重试</button></div>
        <dialog ref="tenantCreateDialog" class="tenant-create-dialog" aria-labelledby="tenant-create-title" @cancel.prevent="closeTenantCreate">
          <form @submit.prevent="createTenant">
            <header><h2 id="tenant-create-title">创建租户</h2><button type="button" aria-label="关闭创建租户" :disabled="busy" @click="closeTenantCreate">×</button></header>
            <label for="tenant-create-name">租户名称</label>
            <input id="tenant-create-name" v-model="tenantName" maxlength="80" required autofocus autocomplete="off" :disabled="busy" placeholder="例如：产品研发团队" />
            <p>创建后，你将成为该租户的所有者，可以邀请成员加入。</p>
            <footer><button type="button" :disabled="busy" @click="closeTenantCreate">取消</button><button type="submit" :disabled="busy || !tenantName.trim()">{{ busy ? '正在创建…' : '创建' }}</button></footer>
          </form>
        </dialog>
        <nav class="tenant-directory" aria-label="选择租户">
          <button v-for="tenant in tenants" :key="tenant.tenantId" class="v2-row collection-item tenant-choice" :class="{ selected: selectedTenant?.tenantId === tenant.tenantId }" :aria-current="selectedTenant?.tenantId === tenant.tenantId ? 'true' : undefined" :disabled="busy" @click="selectTenant(tenant)">
            <span class="tenant-choice-name">{{ tenant.name }}</span>
            <span>{{ roleLabels[tenant.myRole] }} · {{ tenant.status === 'ACTIVE' ? '正常' : '已停用' }}</span>
          </button>
        </nav>
        <p v-if="tenantsLoading" class="console-muted" role="status">正在加载租户…</p>
        <div v-else-if="errors.directory" role="alert">{{ errors.directory.message }} <button @click="errors.directory.retry()">重试</button></div>
        <p v-else-if="!tenants.length" class="console-muted">{{ tenantSearch ? "已加载的租户中没有匹配项。" : "还没有租户，可在这里创建或接受邀请。" }}</p>
        <button v-if="moreTenants && !errors.directory" :disabled="busy || tenantsLoading" @click="read('directory', directory.more, refreshDirectory)">加载更多租户</button>
      </aside>
      <div class="collection-detail">
        <p v-if="!selectedTenant && !tenantsLoading" class="collection-empty">选择一个租户，查看成员与管理设置</p>
        <div v-if="errors.members" role="alert">{{ errors.members.message }} <button @click="errors.members.retry()">重试</button></div>
        <TenantMembers
          v-if="selectedTenant"
          :key="selectedTenant.tenantId"
          :tenant="selectedTenant"
          :members="members"
          :loading="membersLoading"
          :busy="busy"
          :page="memberPage"
          :size="memberSize"
          :has-next="moreMembers"
          :invitation-channels="invitationChannels"
          :refresh-pending="refreshPending('tenant-member:' + selectedTenant.tenantId)"
          :submit-write="submitWrite"
          :discard="discard"
          :reload="reloadMembers"
          :own-membership="ownMembership"
          :refresh-transfers="readTransfers"
          :leave="refreshDirectoryAndTransfers"
          @expired="emit('expired', $event)"
          @left="left"
          @previous="memberPage--"
          @next="nextMemberPage"
          @resize="changeMemberSize"
        />
        <div v-for="transfer in transfers" :key="transfer.transferId" class="v2-row">
          <span>租户 {{ transfer.tenantId }} 所有权交接</span>
          <button v-if="transferOperation(transfer)" :disabled="busy || transfersLoading" @click="updateTransfer(transfer)">
            {{ transferOperation(transfer) === 'accept' ? '接受交接' : '取消交接' }}
          </button>
        </div>
        <p v-if="transfersLoading" class="console-muted" role="status">正在加载所有权交接…</p>
        <div v-else-if="errors.transfers" role="alert">{{ errors.transfers.message }} <button @click="errors.transfers.retry()">重试</button></div>
        <button v-if="moreTransfers && !errors.transfers" :disabled="busy || transfersLoading" @click="read('transfers', () => readTransfers(true), () => readTransfers())">加载更多交接</button>

        <h2 v-if="invitations.length">收到的邀请</h2>
        <div v-for="invitation in invitations" :key="invitation.invitationId" class="v2-row">
          <span>{{ invitation.targetSummary }}</span>
          <button :disabled="busy" @click="updateInvitation(invitation, 'accept')">加入</button>
          <button :disabled="busy" @click="updateInvitation(invitation, 'decline')">拒绝</button>
        </div>
        <p v-if="invitationsLoading" class="console-muted" role="status">正在加载邀请…</p>
        <div v-else-if="errors.invitations" role="alert">{{ errors.invitations.message }} <button @click="errors.invitations.retry()">重试</button></div>
        <button v-if="moreInvitations && !errors.invitations" :disabled="busy || invitationsLoading" @click="read('invitations', received.more, refreshInvitations)">加载更多邀请</button>
      </div>
    </div>
  </section>
</template>
