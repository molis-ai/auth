<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { AuthError, type AccountClient } from "../lib/account-client.ts";
import { cursorCollection } from "../lib/cursor-collection.ts";
import { accountErrorMessage } from "../lib/errors.ts";
import type { WriteOptions } from "../lib/idempotent-submit.ts";

interface Invitation {
  invitationId: string;
  targetSummary: string;
  status: string;
  version: number;
}
interface Transfer {
  transferId: string;
  tenantId: string;
  fromMembershipId: string;
  toMembershipId: string;
  status: string;
  version: number;
}
interface Team {
  name: string;
  membershipId: string;
}

const props = defineProps<{
  client: AccountClient;
  busy: boolean;
  mutate: <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;
}>();
const emit = defineEmits<{ expired: [error: unknown]; dispose: [] }>();
const received = cursorCollection<Invitation>(props.client);
const ownership = cursorCollection<Transfer>(props.client);
const invitations = computed(() => received.items.value.filter(item => item.status === "PENDING"));
const transfers = computed(() => ownership.items.value.filter(item => item.status === "PENDING"));
const { loading: invitationsLoading, nextCursor: moreInvitations } = received;
const { nextCursor: moreTransfers } = ownership;
const transfersLoading = ref(false);
const teams = ref<Record<string, Team | null>>({});
const lifetime = new AbortController();

type Section = "invitations" | "transfers";
const errors = reactive<Partial<Record<Section, { message: string; retry: () => Promise<void> }>>>({});
const showInvitations = computed(() => invitationsLoading.value || invitations.value.length > 0 || moreInvitations.value || errors.invitations);
const showTransfers = computed(() => transfersLoading.value || transfers.value.length > 0 || moreTransfers.value || errors.transfers);

async function read(section: Section, task: () => Promise<unknown>, restart = task) {
  if (lifetime.signal.aborted) return;
  delete errors[section];
  try {
    await task();
  } catch (error) {
    if (lifetime.signal.aborted || (error instanceof AuthError && error.code === "CANCELLED")) return;
    emit("expired", error);
    const retry = error instanceof AuthError && error.code === "INVALID_REQUEST" ? restart : task;
    errors[section] = { message: accountErrorMessage(error), retry: () => read(section, retry, restart) };
  }
}

const refreshInvitations = () => received.first("/invitations");
async function loadTeam(id: string) {
  try {
    return await props.client.request<Team>("/tenants/" + encodeURIComponent(id), undefined, "GET", undefined, lifetime.signal);
  } catch (error) {
    if (error instanceof AuthError && (error.status === 404 || error.code === "TENANT_DISABLED")) return null;
    throw error;
  }
}
async function loadTransfers(append = false) {
  if (transfersLoading.value || lifetime.signal.aborted) return;
  transfersLoading.value = true;
  try {
    const loaded = await (append ? ownership.more() : ownership.first("/ownership-transfers"));
    if (!loaded || lifetime.signal.aborted) return;
    const known = append ? teams.value : {};
    const ids = [...new Set(transfers.value.map(transfer => transfer.tenantId))]
      .filter(id => !Object.hasOwn(known, id));
    const details = await Promise.all(ids.map(async id => [id, await loadTeam(id)] as const));
    if (!lifetime.signal.aborted) teams.value = { ...known, ...Object.fromEntries(details) };
  } finally {
    transfersLoading.value = false;
  }
}

function transferOperation(transfer: Transfer): "accept" | "cancel" | undefined {
  const member = teams.value[transfer.tenantId]?.membershipId;
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
      committed: () => ownership.remove(item => item.transferId === transfer.transferId),
      after: () => loadTransfers(),
      success: operation === "accept" ? "已接受所有权交接" : "已取消所有权交接",
      refreshMessage: "交接已更新，但待处理列表暂未刷新。",
    },
  );
}
function updateInvitation(invitation: Invitation, operation: "accept" | "decline") {
  return props.mutate(
    "/invitations/" + encodeURIComponent(invitation.invitationId) + "/" + operation,
    { expectedVersion: invitation.version },
    {
      committed: () => received.remove(item => item.invitationId === invitation.invitationId),
      after: async () => { await refreshInvitations(); },
      success: operation === "accept" ? "已接受团队邀请" : "已拒绝团队邀请",
      refreshMessage: "邀请已处理，但待处理列表暂未刷新。",
    },
  );
}

onMounted(() => {
  void read("invitations", refreshInvitations);
  void read("transfers", loadTransfers);
});
onBeforeUnmount(() => {
  lifetime.abort();
  received.clear();
  ownership.clear();
  emit("dispose");
});
</script>

<template>
  <section class="console-card pending-page">
    <header class="security-page-head">
      <h1>待处理</h1>
    </header>

    <section v-if="showInvitations" class="pending-group" aria-labelledby="pending-invitations-title" :aria-busy="invitationsLoading">
      <h2 id="pending-invitations-title">团队邀请</h2>
      <div v-for="invitation in invitations" :key="invitation.invitationId" class="v2-row pending-item is-info">
        <span class="pending-item-text">{{ invitation.targetSummary }}</span>
        <div class="pending-item-actions">
          <button type="button" class="pending-primary" :disabled="busy" @click="updateInvitation(invitation, 'accept')">接受</button>
          <button type="button" :disabled="busy" @click="updateInvitation(invitation, 'decline')">拒绝</button>
        </div>
      </div>
      <p v-if="invitationsLoading" class="console-muted" role="status">正在加载邀请…</p>
      <div v-else-if="errors.invitations" role="alert">{{ errors.invitations.message }} <button type="button" @click="errors.invitations.retry()">重试</button></div>
      <button v-if="moreInvitations && !errors.invitations" class="pending-more" type="button" :disabled="busy || invitationsLoading" @click="read('invitations', received.more, refreshInvitations)">加载更多邀请</button>
    </section>

    <section v-if="showTransfers" class="pending-group" aria-labelledby="pending-transfers-title" :aria-busy="transfersLoading">
      <h2 id="pending-transfers-title">所有权交接</h2>
      <div v-for="transfer in transfers" :key="transfer.transferId" class="v2-row pending-item is-warn">
        <span class="pending-item-text">
          {{ teams[transfer.tenantId]?.name ? `「${teams[transfer.tenantId]?.name}」的所有权交接` : "团队所有权交接" }}
        </span>
        <button v-if="transferOperation(transfer)" type="button" :disabled="busy || transfersLoading" @click="updateTransfer(transfer)">
          {{ transferOperation(transfer) === "accept" ? "接受交接" : "取消交接" }}
        </button>
      </div>
      <p v-if="transfersLoading" class="console-muted" role="status">正在加载所有权交接…</p>
      <div v-else-if="errors.transfers" role="alert">{{ errors.transfers.message }} <button type="button" @click="errors.transfers.retry()">重试</button></div>
      <button v-if="moreTransfers && !errors.transfers" class="pending-more" type="button" :disabled="busy || transfersLoading" @click="read('transfers', () => loadTransfers(true), loadTransfers)">加载更多交接</button>
    </section>

    <section v-if="!showInvitations && !showTransfers" class="security-panel-card pending-empty">
      <p>暂无待处理事项</p>
    </section>
  </section>
</template>

<style scoped>
.v2-console .pending-page {
  max-width: 960px;
  margin: 0 auto;
  display: grid;
  gap: 18px;
}
.v2-console .pending-page h1 {
  margin: 0;
  color: var(--ink);
  font-size: 22px;
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: -0.02em;
}
.pending-group { display: grid; gap: 10px; min-width: 0; }
.v2-console .pending-group h2 { margin: 0; font-size: 15px; font-weight: 600; }
.pending-item {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 10px 14px;
  padding: 12px 16px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
}
.pending-item.is-info { background: #f5f6fa; border: 1px solid #dfe3f0; color: #414d75; }
.pending-item.is-warn { background: #fff8e6; border: 1px solid #f2dfb3; color: #8a5a10; }
.pending-item-text { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.pending-item-actions { display: flex; gap: 8px; }
.v2-console .pending-item button {
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid #d5d5db;
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink);
  font-size: 12px;
  font-weight: 500;
}
.v2-console .pending-item button.pending-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.pending-more { justify-self: start; }
.pending-empty { padding-block: 36px; text-align: center; }
.pending-empty p { margin: 0; }
.pending-group p { margin: 0; }

@media (max-width: 760px) {
  .v2-console .pending-item button { min-height: 40px; }
}
</style>
