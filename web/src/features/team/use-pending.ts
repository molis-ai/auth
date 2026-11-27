import { dateFormatter as sharedDateFormatter } from "../../shared/format/date.ts";
import { toRefs } from "vue";
import { useAccountContext } from "../../shared/api/account-context.ts";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { AuthError } from "../../shared/api/account-client.ts";
import { cursorCollection } from "../../shared/api/cursor-collection.ts";
import { accountErrorMessage } from "../../shared/api/errors.ts";

interface Invitation {
  invitationId: string;
  tenantId?: string;
  targetSummary: string;
  status: string;
  expiresAt?: string;
  version: number;
}
interface Transfer {
  transferId: string;
  tenantId: string;
  tenantName: string;
  myMembershipId: string;
  fromMembershipId: string;
  toMembershipId: string;
  status: string;
  expiresAt?: string;
  version: number;
}

import { createRequiredContext, type EmitFor } from "../../shared/composables/create-required-context.ts";

export type Props = {
  busy: boolean;
};
export type Events = { expired: [error: unknown]; dispose: []; navigate: [page: string] };
type Emit = EmitFor<Events>;

export function usePending(props: Props, emit: Emit) {
  const { client, mutate } = useAccountContext();

  type Category = "all" | "invitations" | "transfers";
  type Section = "invitations" | "transfers";

  const received = cursorCollection<Invitation>(client);
  const ownership = cursorCollection<Transfer>(client);
  const invitations = computed(() => received.items.value.filter(item => item.status === "PENDING"));
  const transfers = computed(() => ownership.items.value.filter(item => item.status === "PENDING"));
  const { loading: invitationsLoading, nextCursor: moreInvitations } = received;
  const { loading: transfersLoading, nextCursor: moreTransfers } = ownership;
  const initialLoading = ref(true);
  const refreshing = ref(false);
  const loading = computed(() => initialLoading.value || refreshing.value || invitationsLoading.value || transfersLoading.value);
  const category = ref<Category>("all");
  const lastHandled = ref<{ message: string; jumpToTeams: boolean } | null>(null);
  const confirmingTransfer = ref<Transfer | null>(null);
  const confirmDialog = ref<HTMLDialogElement>();
  const lifetime = new AbortController();

  const errors = reactive<Partial<Record<Section, { message: string; retry: () => Promise<void> }>>>({});
  const showInvitations = computed(() =>
    !initialLoading.value && category.value !== "transfers" &&
    Boolean(invitations.value.length || moreInvitations.value || errors.invitations),
  );
  const showTransfers = computed(() =>
    !initialLoading.value && category.value !== "invitations" &&
    Boolean(transfers.value.length || moreTransfers.value || errors.transfers),
  );

  const totalCount = computed(() => invitations.value.length + transfers.value.length);
  const needMeCount = computed(() =>
    invitations.value.length + transfers.value.filter(item => transferOperation(item) === "accept").length,
  );
  const waitingOthersCount = computed(() =>
    transfers.value.filter(item => transferOperation(item) === "cancel").length,
  );
  const urgentCount = computed(() =>
    invitations.value.filter(item => isExpiringSoon(item.expiresAt)).length +
    transfers.value.filter(item => transferOperation(item) === "accept" && isExpiringSoon(item.expiresAt)).length,
  );

  const dateFormatter = sharedDateFormatter("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  function isExpiringSoon(expiresAt?: string): boolean {
    if (!expiresAt) return false;
    const ms = Date.parse(expiresAt) - Date.now();
    return Number.isFinite(ms) && ms > 0 && ms <= 24 * 3_600_000;
  }

  function expiryMeta(expiresAt?: string): { remaining: string; formatted: string; urgent: boolean } | null {
    if (!expiresAt) return null;
    const target = Date.parse(expiresAt);
    if (!Number.isFinite(target)) return null;
    const ms = target - Date.now();
    const formatted = dateFormatter.format(new Date(target));
    if (ms <= 0) return { remaining: "即将失效", formatted, urgent: true };
    const hours = Math.ceil(ms / 3_600_000);
    if (hours <= 1) return { remaining: "不足 1 小时过期", formatted, urgent: true };
    if (hours < 24) return { remaining: `剩余 ${hours} 小时过期`, formatted, urgent: true };
    const days = Math.ceil(ms / 86_400_000);
    return { remaining: `剩余 ${days} 天过期`, formatted, urgent: false };
  }

  const headingCopy = computed(() => {
    if (category.value === "invitations") {
      return { title: "团队邀请", sub: "查看发给你的团队加入邀请，接受后将立即加入对应团队" };
    }
    if (category.value === "transfers") {
      return { title: "所有权交接", sub: "接收他人转交的团队所有权，或撤回你发起且尚未确认的交接" };
    }
    return { title: "全部待处理", sub: "集中处理团队加入邀请与所有权交接请求，及时响应避免过期失效" };
  });

  const emptyCopy = computed(() => {
    if (category.value === "invitations") {
      return {
        title: "暂无团队邀请",
        desc: "目前没有待确认的团队加入邀请，你也可以前往「团队」主动创建新的团队空间。",
      };
    }
    if (category.value === "transfers") {
      return {
        title: "暂无所有权交接",
        desc: "当前没有待你接收或等待对方确认的团队所有权交接记录。",
      };
    }
    return {
      title: "暂无待处理事项",
      desc: "当前没有待确认的团队邀请或所有权交接。收到新的协作邀请或交接请求时，会在这里集中展示。",
    };
  });

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
  function loadTransfers(append = false) {
    return append ? ownership.more() : ownership.first("/ownership-transfers");
  }

  async function loadPending() {
    await Promise.all([
      read("invitations", refreshInvitations),
      read("transfers", () => loadTransfers(false)),
    ]);
  }

  async function refreshAll() {
    if (loading.value || props.busy) return;
    refreshing.value = true;
    try {
      await loadPending();
    } finally {
      if (!lifetime.signal.aborted) refreshing.value = false;
    }
  }

  function transferOperation(transfer: Transfer): "accept" | "cancel" | undefined {
    const member = transfer.myMembershipId;
    if (member === transfer.toMembershipId) return "accept";
    if (member === transfer.fromMembershipId) return "cancel";
  }

  function transferTitle(transfer: Transfer): string {
    return `「${transfer.tenantName}」的所有权交接`;
  }

  function handleTransferClick(transfer: Transfer) {
    const operation = transferOperation(transfer);
    if (operation === "accept") {
      confirmingTransfer.value = transfer;
      confirmDialog.value?.showModal();
    } else if (operation === "cancel") {
      void updateTransfer(transfer);
    }
  }

  function closeConfirmDialog() {
    if (props.busy) return;
    confirmDialog.value?.close();
    confirmingTransfer.value = null;
  }

  async function confirmAcceptTransfer() {
    const transfer = confirmingTransfer.value;
    if (!transfer) return;
    confirmDialog.value?.close();
    confirmingTransfer.value = null;
    await updateTransfer(transfer);
  }

  function updateTransfer(transfer: Transfer) {
    const operation = transferOperation(transfer);
    if (!operation) return;
    const label = transfer.tenantName;
    return mutate(
      "/ownership-transfers/" + encodeURIComponent(transfer.transferId) + "/" + operation,
      { expectedVersion: transfer.version },
      {
        committed: () => {
          ownership.remove(item => item.transferId === transfer.transferId);
          lastHandled.value = {
            message: operation === "accept"
              ? `已接受「${label}」的所有权交接，你现在是该团队所有者。`
              : `已取消「${label}」的所有权交接，团队所有权保持不变。`,
            jumpToTeams: operation === "accept",
          };
        },
        after: async () => { await loadTransfers(); },
        success: operation === "accept" ? "已接受所有权交接" : "已取消所有权交接",
        refreshMessage: "交接已更新，但待处理列表暂未刷新。",
      },
    );
  }

  function updateInvitation(invitation: Invitation, operation: "accept" | "decline") {
    return mutate(
      "/invitations/" + encodeURIComponent(invitation.invitationId) + "/" + operation,
      { expectedVersion: invitation.version },
      {
        committed: () => {
          received.remove(item => item.invitationId === invitation.invitationId);
          lastHandled.value = {
            message: operation === "accept" ? "已接受团队邀请，可在「团队」中查看该团队。" : "已拒绝该团队邀请。",
            jumpToTeams: operation === "accept",
          };
        },
        after: async () => { await refreshInvitations(); },
        success: operation === "accept" ? "已接受团队邀请" : "已拒绝团队邀请",
        refreshMessage: "邀请已处理，但待处理列表暂未刷新。",
      },
    );
  }

  onMounted(async () => {
    await loadPending();
    if (!lifetime.signal.aborted) initialLoading.value = false;
  });
  onBeforeUnmount(() => {
    lifetime.abort();
    confirmDialog.value?.close();
    received.clear();
    ownership.clear();
    emit("dispose");
  });

  const { busy } = toRefs(props);
  const invitationRows = computed(() => invitations.value.map(item => ({ ...item, expiry: expiryMeta(item.expiresAt) })));
  const transferRows = computed(() => transfers.value.map(item => ({
    ...item, expiry: expiryMeta(item.expiresAt), operation: transferOperation(item), title: transferTitle(item),
  })));
  return { category, emit, invitations, transfers, initialLoading, refreshing, loading, headingCopy, emptyCopy, lastHandled, needMeCount, waitingOthersCount, urgentCount, totalCount, refreshAll, showInvitations, showTransfers, invitationsLoading, transfersLoading, moreInvitations, moreTransfers, errors, read, refreshInvitations, received, transferTitle, loadTransfers, updateInvitation, handleTransferClick, invitationRows, transferRows, confirmingTransfer, confirmDialog, closeConfirmDialog, confirmAcceptTransfer, busy };
}

export const pendingPageContext = createRequiredContext<ReturnType<typeof usePending>>("PendingPage");
