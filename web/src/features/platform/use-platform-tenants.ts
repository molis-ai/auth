import { useAccountContext } from "../../shared/api/account-context.ts";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AuthError } from "../../shared/api/account-client.ts";
import { cursorCollection } from "../../shared/api/cursor-collection.ts";
import { accountErrorMessage } from "../../shared/api/errors.ts";
import {
  auditActorLabel,
  auditOperationMeta,
  copyToClipboard,
  formatAuditTimestamp,
  formatRelativeAuditTime,
  platformAuditPath,
  type AuditEvent,
} from "./platform-audit.ts";
import { platformTenantPath as teamPath, tenantOwner, type PlatformTenant, type PlatformTenantMember } from "./platform-tenants.ts";
import { useDebouncedSearch } from "../../shared/composables/use-debounced-search.ts";
import type PlatformTenantDialogs from "./PlatformTenantDialogs.vue";

import { createRequiredContext, type EmitFor } from "../../shared/composables/create-required-context.ts";

export type Props = {
  capabilities: readonly string[];
  initialTenantId?: string;
};
export type Events = {
  expired: [error: unknown];
  notify: [message: string];
  openAudit: [tenantId: string];
};
type Emit = EmitFor<Events>;

export function usePlatformTenants(props: Props, emit: Emit) {
  const { client, submitWrite } = useAccountContext();

  const canCreate = computed(() => props.capabilities.includes("TENANT_CREATE"));
  const canSetStatus = computed(() => props.capabilities.includes("TENANT_STATUS"));
  const hasUserRead = computed(() => props.capabilities.includes("USER_READ"));
  const hasAuditRead = computed(() => props.capabilities.includes("AUDIT_READ"));

  const tenantCollection = cursorCollection<PlatformTenant>(client);
  const tenants = tenantCollection.items;
  const nextCursor = tenantCollection.nextCursor;
  const loadingMore = computed(() => tenantCollection.loading.value && tenants.value.length > 0);

  const memberCollection = cursorCollection<PlatformTenantMember>(client);
  const members = memberCollection.items;
  const membersLoading = memberCollection.loading;
  const memberCursor = memberCollection.nextCursor;
  const detail = ref<PlatformTenant>();
  const detailRequested = ref(Boolean(props.initialTenantId));
  const directoryLoading = tenantCollection.loading;

  let detailGeneration = 0;
  let scopeRead: AbortController | undefined;
  let scopeRequest = Promise.resolve();
  const auditEvents = ref<AuditEvent[]>([]);
  const selectedTenantId = ref(props.initialTenantId ?? "");
  const search = ref("");
  const { applied: appliedSearch, reset: resetSearch } = useDebouncedSearch(search);
  const statusFilter = ref<"ALL" | "ACTIVE" | "DISABLED">("ALL");
  const busy = ref(false);
  const message = ref("");
  const activeAuditEvent = ref<AuditEvent | null>(null);

  const dialogs = ref<InstanceType<typeof PlatformTenantDialogs>>();
  let active = true;

  const hasFilters = computed(() => statusFilter.value !== "ALL" || Boolean(appliedSearch.value));
  const selectedTenant = computed(() =>
    tenants.value.find(team => team.tenantId === selectedTenantId.value)
      ?? (detail.value?.tenantId === selectedTenantId.value ? detail.value : undefined)
      ?? (detailRequested.value ? null : tenants.value[0] ?? null),
  );
  const selectedOwner = computed(() => selectedTenant.value ? tenantOwner(selectedTenant.value) : null);
  const relatedAudits = auditEvents;
  const latestRelatedAudit = computed(() => relatedAudits.value[0] ?? null);
  async function loadDetail(tenantId: string) {
    const generation = ++detailGeneration;
    const team = await client.request<PlatformTenant>(teamPath(tenantId));
    if (active && generation === detailGeneration && selectedTenantId.value === tenantId) detail.value = team;
  }

  watch(() => props.initialTenantId, tenantId => {
    if (!tenantId) return;
    detailRequested.value = true;
    selectedTenantId.value = tenantId;
    detail.value = undefined;
    if (!tenants.value.some(team => team.tenantId === tenantId)) {
      void loadDetail(tenantId).catch(reportError);
    }
  });

  async function run(task: () => Promise<void>) {
    if (busy.value) return;
    busy.value = true;
    message.value = "";
    try {
      await task();
    } catch (error) {
      if (!active || (error instanceof AuthError && error.code === "CANCELLED")) return;
      message.value = accountErrorMessage(error);
      emit("expired", error);
    } finally {
      if (active) busy.value = false;
    }
  }

  function reportError(error: unknown) {
    if (!active || (error instanceof AuthError && error.code === "CANCELLED")) return;
    message.value = accountErrorMessage(error);
    emit("expired", error);
  }

  async function loadScope(tenantId: string | undefined, keepMembers = false) {
    scopeRead?.abort();
    if (!keepMembers) {
      auditEvents.value = [];
      memberCollection.clear();
    }
    if (!tenantId) return;
    const request = new AbortController();
    scopeRead = request;
    const requests: Promise<unknown>[] = [memberCollection.first(`${teamPath(tenantId)}/members`)];
    if (hasAuditRead.value) {
      requests.push(client.request<{ items: AuditEvent[] }>(
        platformAuditPath({ tenantId, limit: 10 }), undefined, "GET", undefined, request.signal,
      ).then(page => {
        if (!request.signal.aborted) auditEvents.value = page.items;
      }));
    }
    const outcomes = await Promise.allSettled(requests);
    if (!request.signal.aborted) {
      for (const outcome of outcomes) if (outcome.status === "rejected") reportError(outcome.reason);
    }
  }

  async function load(showFeedback = false) {
    const params = new URLSearchParams();
    if (statusFilter.value !== "ALL") params.set("status", statusFilter.value);
    if (appliedSearch.value) params.set("q", appliedSearch.value);
    const path = params.size ? `/platform/tenants?${params}` : "/platform/tenants";
    const loaded = await tenantCollection.first(path, 30);
    if (loaded && showFeedback && active) {
      if (detailRequested.value && selectedTenantId.value && !tenants.value.some(team => team.tenantId === selectedTenantId.value)) {
        await loadDetail(selectedTenantId.value);
      }
      const tenantId = selectedTenant.value?.tenantId;
      await loadScope(tenantId, true);
      emit("notify", "已同步最新平台团队列表");
    }
  }

  function applyCommitted(team: PlatformTenant) {
    const previous = selectedTenant.value;
    const matchesId = (row: PlatformTenant) => row.tenantId === team.tenantId;
    const updated = { ...(previous && matchesId(previous) ? previous : undefined), ...team };
    detailGeneration++;
    selectedTenantId.value = team.tenantId;
    detailRequested.value = true;
    detail.value = updated;
    if (statusFilter.value === "ALL" || statusFilter.value === team.status) {
      tenantCollection.replace(matchesId, updated);
    } else {
      tenantCollection.remove(matchesId);
    }
    if (previous?.tenantId === team.tenantId) scopeRequest = loadScope(team.tenantId, true);
  }

  async function refreshCommitted(team: PlatformTenant, created: boolean) {
    await nextTick();
    if (!active) return;
    if (created || hasFilters.value) await load();
    // Exact idempotent responses recorded before the new projection can still
    // be replayed. Refresh their missing metadata using the ordinary detail read.
    if (team.memberCount === undefined && selectedTenantId.value === team.tenantId) {
      await loadDetail(team.tenantId);
      const snapshot = detail.value;
      if (snapshot?.tenantId === team.tenantId) {
        tenantCollection.replace(row => row.tenantId === team.tenantId, snapshot);
      }
    }
    await scopeRequest;
  }

  function selectTenant(tenantId: string) {
    detailGeneration++;
    detail.value = undefined;
    detailRequested.value = false;
    selectedTenantId.value = tenantId;
  }

  function resetFilters() {
    resetSearch();
    statusFilter.value = "ALL";
  }

  async function copyField(value: string, label: string) {
    const ok = await copyToClipboard(value);
    emit("notify", ok ? `已复制${label}` : `${label}：${value}`);
  }

  watch([appliedSearch, statusFilter], () => {
    message.value = "";
    selectTenant("");
    tenantCollection.clear();
    void load().catch(reportError);
  });
  watch(() => selectedTenant.value?.tenantId, tenantId => {
    activeAuditEvent.value = null;
    scopeRequest = loadScope(tenantId);
  });
  onMounted(() => {
    void run(async () => {
      try {
        await load();
        const id = selectedTenantId.value;
        if (id && !tenants.value.some(team => team.tenantId === id)) await loadDetail(id);
      } catch (error) {
        if (!selectedTenant.value) detailRequested.value = false;
        throw error;
      }
    });
  });
  onBeforeUnmount(() => {
    active = false;
    scopeRead?.abort();
    tenantCollection.clear();
    memberCollection.clear();
  });
  return { client, submitWrite, canCreate, canSetStatus, hasUserRead, hasAuditRead, tenantCollection, tenants, nextCursor, loadingMore, members, membersLoading, memberCursor, memberCollection, detailRequested, directoryLoading, busy, message, relatedAudits, latestRelatedAudit, activeAuditEvent, selectedTenant, selectedOwner, search, statusFilter, dialogs, hasFilters, tenantOwner, selectTenant, resetFilters, reportError, run, load, copyField, formatAuditTimestamp, formatRelativeAuditTime, auditOperationMeta, auditActorLabel, applyCommitted, refreshCommitted, emit };
}

export const platformTenantsContext = createRequiredContext<ReturnType<typeof usePlatformTenants>>("PlatformTenants");
