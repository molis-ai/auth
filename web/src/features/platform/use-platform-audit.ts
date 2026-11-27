import { useAccountContext } from "../../shared/api/account-context.ts";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AuthError } from "../../shared/api/account-client.ts";
import { cursorCollection } from "../../shared/api/cursor-collection.ts";
import { accountErrorMessage } from "../../shared/api/errors.ts";
import {
  auditActorLabel,
  auditOperationMeta,
  formatAuditTimestamp,
  formatRelativeAuditTime,
  platformAuditPath,
  targetKindTone,
  type AuditCategory,
  type AuditEvent,
} from "./platform-audit.ts";
import { platformTenantPath, type PlatformTenant } from "./platform-tenants.ts";
import { useDebouncedSearch } from "../../shared/composables/use-debounced-search.ts";

import { createRequiredContext, type EmitFor } from "../../shared/composables/create-required-context.ts";

export type Props = {
  capabilities: readonly string[];
  initialTenantScope?: string | null;
};
export type Events = {
  expired: [error: unknown];
  notify: [message: string];
  openTenant: [tenantId: string];
};
type Emit = EmitFor<Events>;

export function usePlatformAudit(props: Props, emit: Emit) {
  const { client } = useAccountContext();

  const hasTenantRead = computed(() => props.capabilities.includes("TENANT_READ"));

  const auditCollection = cursorCollection<AuditEvent>(client);
  const allEvents = auditCollection.items;
  const nextCursor = auditCollection.nextCursor;
  const loadingMore = computed(() => auditCollection.loading.value && allEvents.value.length > 0);

  const category = ref<AuditCategory>("all");
  const resultFilter = ref<"ALL" | "SUCCEEDED" | "DENIED">("ALL");
  const query = ref("");
  const tenantScope = ref<string | null>(props.initialTenantScope ?? null);
  const selectedEvent = ref<AuditEvent | null>(null);
  const busy = auditCollection.loading;
  const { applied: appliedQuery, reset: resetSearch } = useDebouncedSearch(query);
  const message = ref("");

  let active = true;

  const scopedNames = ref(new Map<string, string>());
  const requestedNames = new Set<string>();
  let nameRequest: AbortController | undefined;
  const scopedName = computed(() => {
    const id = tenantScope.value;
    return id ? allEvents.value.find(event => event.tenantId === id)?.tenantName ?? scopedNames.value.get(id) ?? id : "";
  });

  const isFiltered = computed(() => Boolean(
    tenantScope.value || category.value !== "all" || resultFilter.value !== "ALL" || appliedQuery.value,
  ));
  const succeededCount = computed(() => allEvents.value.filter(e => e.result === "SUCCEEDED").length);
  const deniedCount = computed(() => allEvents.value.filter(e => e.result === "DENIED").length);

  const categories: ReadonlyArray<{ id: AuditCategory; label: string }> = [
    { id: "all", label: "全部事件" },
    { id: "account", label: "账号与权限" },
    { id: "tenant", label: "团队与成员" },
    { id: "app", label: "应用与客户端" },
  ];

  watch(
    () => props.initialTenantScope,
    scope => {
      tenantScope.value = scope ?? null;
      if (scope) {
        category.value = "all";
        resultFilter.value = "ALL";
        resetSearch();
      }
    },
  );

  async function loadScopedName(id: string) {
    if (!hasTenantRead.value || scopedNames.value.has(id) || requestedNames.has(id)) return;
    requestedNames.add(id);
    const request = new AbortController();
    nameRequest = request;
    try {
      const team = await client.request<PlatformTenant>(
        platformTenantPath(id), undefined, "GET", undefined, request.signal,
      );
      if (!request.signal.aborted) scopedNames.value.set(id, team.name);
    } catch (error) {
      if (request.signal.aborted) requestedNames.delete(id);
      else if (active) emit("expired", error);
    } finally {
      if (nameRequest === request) nameRequest = undefined;
    }
  }

  async function load(showFeedback = false) {
    message.value = "";
    try {
      const scope = tenantScope.value;
      const loaded = await auditCollection.first(platformAuditPath({
        category: category.value,
        result: resultFilter.value,
        tenantId: scope,
        q: appliedQuery.value,
      }), 50);
      if (!loaded || !active) return;
      if (scope && scope === tenantScope.value) {
        const name = allEvents.value.find(event => event.tenantId === scope)?.tenantName;
        if (name) scopedNames.value.set(scope, name);
        else if (!allEvents.value.length) void loadScopedName(scope);
      }
      if (showFeedback) emit("notify", "已刷新平台审计日志");
    } catch (error) {
      if (!active || (error instanceof AuthError && error.code === "CANCELLED")) return;
      message.value = accountErrorMessage(error);
      emit("expired", error);
    }
  }

  async function loadMore() {
    if (!nextCursor.value) return;
    try {
      const before = allEvents.value.length;
      const loaded = await auditCollection.more();
      if (loaded && active) {
        const added = allEvents.value.length - before;
        emit("notify", `已通过 cursor 游标追加加载 ${added} 条更早日志`);
      }
    } catch (error) {
      if (!active || (error instanceof AuthError && error.code === "CANCELLED")) return;
      message.value = accountErrorMessage(error);
      emit("expired", error);
    }
  }

  function resetFilters() {
    category.value = "all";
    resultFilter.value = "ALL";
    tenantScope.value = null;
    resetSearch();
  }

  watch(tenantScope, () => nameRequest?.abort());
  watch([category, resultFilter, tenantScope, appliedQuery], () => {
    auditCollection.clear();
    selectedEvent.value = null;
    void load();
  });
  onMounted(() => void load());
  onBeforeUnmount(() => {
    active = false;
    nameRequest?.abort();
    auditCollection.clear();
  });
  const eventRows = computed(() => allEvents.value.map(event => ({
    event, timestamp: formatAuditTimestamp(event.occurredAt), relative: formatRelativeAuditTime(event.occurredAt),
  })));
  return { hasTenantRead, tenantScope, scopedName, selectedEvent, allEvents, succeededCount, deniedCount, busy, message, load, loadMore, nextCursor, loadingMore, resetFilters, isFiltered, categories, category, resultFilter, query, auditActorLabel, auditOperationMeta, targetKindTone, eventRows };
}

export const platformAuditContext = createRequiredContext<ReturnType<typeof usePlatformAudit>>("PlatformAudit");
