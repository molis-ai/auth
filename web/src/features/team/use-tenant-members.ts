import { roleLabel } from "../../shared/format/role-label.ts";
import { toRefs } from "vue";
import type { Ref } from "vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { AccountClient } from '../../shared/api/account-client.ts';
import { accountErrorMessage } from '../../shared/api/errors.ts';
import type { WriteOptions } from '../../shared/api/idempotent-submit.ts';
type Member = { displayName: string; email: string | null; membershipId: string; userId: string; role: string; status: string; version: number };
type Tenant = { tenantId: string; name: string; status: string; myRole: string; membershipId: string; membershipVersion: number; version: number };

import { createRequiredContext, type EmitFor } from "../../shared/composables/create-required-context.ts";

export type Props = {
  client: AccountClient;
  viewerId: string;
  billingEnabled: boolean;
  tenant: Tenant;
  members: Member[];
  loading: boolean;
  busy: boolean;
  page: number;
  size: number;
  hasNext: boolean;
  canInviteByPhone: boolean;
  refreshPending: boolean;
  reload: (tenant: Tenant) => Promise<void>;
  leave: () => Promise<void>;
  discard: (action: string) => void;
  submitWrite: <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;
};
export type Events = {
  left: [tenantId: string];
  expired: [error: unknown];
  orderAccessDenied: [];
  openBilling: [tenantId: string];
  previous: [];
  next: [];
  resize: [size: number];
};
type Emit = EmitFor<Events>;

export function useTenantMembers(props: Props, emit: Emit, tab: Ref<"members" | "billing">) {
  const action = 'tenant-member:' + props.tenant.tenantId;
  const query = ref(''), roleFilter = ref<'ALL' | 'OWNER' | 'ADMIN' | 'MEMBER'>('ALL'), sort = ref('role'), dialog = ref<HTMLDialogElement>();
  const openMoreId = ref<string | null>(null);
  const operation = ref(''), target = ref<Member>(), role = ref('MEMBER'), invite = ref(''), inviteKind = ref<'EMAIL' | 'PHONE'>('EMAIL'), saving = ref(false), error = ref('');
    const weights: Record<string,number> = { OWNER: 0, ADMIN: 1, MEMBER: 2 };
  const active = computed(() => props.tenant.status === 'ACTIVE');
  const manager = computed(() => active.value && ['OWNER','ADMIN'].includes(props.tenant.myRole));
  const pageSizes = [10, 20, 50] as const;
  const pageSizeMenu = ref<HTMLElement>();
  const billingScope = computed(() => JSON.stringify([
    props.viewerId, props.tenant.tenantId, props.tenant.membershipId, props.tenant.myRole, props.tenant.status,
  ]));
  const roleCounts = computed(() => ({
    ALL: props.members.length,
    OWNER: props.members.filter(m => m.role === 'OWNER').length,
    ADMIN: props.members.filter(m => m.role === 'ADMIN').length,
    MEMBER: props.members.filter(m => m.role === 'MEMBER').length,
  }));
  const rows = computed(() =>
    props.members
      .filter(m => roleFilter.value === 'ALL' || m.role === roleFilter.value)
      .filter(m => [m.displayName, m.email ?? ''].some(value => value.toLowerCase().includes(query.value.trim().toLowerCase())))
      .sort((a, b) => sort.value === 'role' ? weights[a.role]! - weights[b.role]! || a.displayName.localeCompare(b.displayName) : a.displayName.localeCompare(b.displayName)),
  );

  function onWindowClick(event: MouseEvent) {
    if (!openMoreId.value) return;
    const el = event.target as HTMLElement | null;
    if (!el?.closest('.tm-more-wrap')) openMoreId.value = null;
  }
  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && openMoreId.value) openMoreId.value = null;
  }
  onMounted(() => {
    window.addEventListener('click', onWindowClick);
    window.addEventListener('keydown', onWindowKeydown);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('click', onWindowClick);
    window.removeEventListener('keydown', onWindowKeydown);
    props.discard(action);
    dialog.value?.close();
  });

  watch([role, () => invite.value.trim(), inviteKind, () => props.tenant.version],
    () => props.discard(action), { flush: 'sync' });
  watch(tab, () => { openMoreId.value = null; });

  function toggleMore(membershipId: string) {
    openMoreId.value = openMoreId.value === membershipId ? null : membershipId;
  }
  function selectPageSize(size: number) {
    pageSizeMenu.value?.hidePopover();
    if (size !== props.size) emit('resize', size);
  }
  async function open(kind: string, member?: Member) {
    openMoreId.value = null;
    if (props.busy || props.loading || props.refreshPending) return;
    props.discard(action);
    if (kind === 'invite') inviteKind.value = 'EMAIL';
    operation.value = kind; target.value = member; role.value = member?.role ?? 'MEMBER'; invite.value = ''; error.value = '';
    await nextTick(); dialog.value?.showModal();
  }
  function close() {
    if (saving.value) return;
    props.discard(action);
    dialog.value?.close();
  }
  const title = computed(() => ({ invite: '邀请成员', role: '修改角色', remove: '移除成员', transfer: '交接所有权', leave: '退出团队' })[operation.value]);
  async function submit() {
    if (saving.value || props.busy || props.loading || props.refreshPending) return;
    saving.value = true; error.value = '';
    try {
      const tenant = props.tenant;
      const base = '/tenants/' + encodeURIComponent(tenant.tenantId);
      const member = target.value;
      const kind = operation.value;
      let path: string, body: unknown;
      if (kind === 'invite') {
        path = base + '/invitations';
        body = { target: { kind: inviteKind.value, value: invite.value.trim() } };
      } else if (kind === 'transfer' && member) {
        path = base + '/ownership-transfers';
        body = { targetMembershipId: member.membershipId, expectedVersion: tenant.version };
      } else if (kind === 'leave') {
        path = base + '/leave';
        body = { expectedVersion: tenant.membershipVersion };
      } else {
        if (!member) return;
        path = base + '/members/' + encodeURIComponent(member.membershipId) + (kind === 'role' ? '/role' : '/remove');
        body = { expectedVersion: member.version, ...(kind === 'role' ? { role: role.value } : {}) };
      }
      const success = kind === 'invite' ? '邀请已创建'
        : kind === 'transfer' ? '交接已发起，可在「待处理」查看。' : '操作已完成';
      await props.submitWrite(path, body, {
        action,
        method: kind === 'role' ? 'PATCH' : 'POST',
        success,
        refreshMessage: '操作已完成，但成员或团队数据暂未刷新。',
        committed: () => {
          dialog.value?.close();
          if (kind === 'leave') emit('left', tenant.tenantId);
        },
        after: async () => {
          if (kind === 'leave') await props.leave();
          else await props.reload(tenant);
        },
      });
    } catch(e) {
      emit('expired', e);
      error.value = accountErrorMessage(e);
    }
    finally { saving.value = false; }
  }

  const { tenant, members, loading, busy, page, size, hasNext, canInviteByPhone, refreshPending } = toRefs(props);
  return { tab, emit, saving, active, manager, billingScope, roleLabel, query, roleFilter, sort, roleCounts, rows, openMoreId, toggleMore, open, close, operation, title, role, target, invite, inviteKind, error, submit, pageSizes, pageSizeMenu, selectPageSize, dialog, tenant, members, loading, busy, page, size, hasNext, canInviteByPhone, refreshPending };
}

export const tenantMembersContext = createRequiredContext<ReturnType<typeof useTenantMembers>>("TenantMembers");
