<script setup lang="ts">
import { lazyComponent } from "../../shared/components/lazy-component.ts";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { AccountClient } from '../../shared/api/account-client.ts';
import { accountErrorMessage } from '../../shared/api/errors.ts';
import type { WriteOptions } from '../../shared/api/idempotent-submit.ts';
type Member = { displayName: string; email: string | null; membershipId: string; userId: string; role: string; status: string; version: number };
type Tenant = { tenantId: string; name: string; status: string; myRole: string; membershipId: string; membershipVersion: number; version: number };
const props = defineProps<{
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
}>();
const tab = defineModel<'members' | 'billing'>('tab', { required: true });
const BillingPanel = lazyComponent(() => import('../billing/index.ts'));
const emit = defineEmits<{
  left: [tenantId: string];
  expired: [error: unknown];
  orderAccessDenied: [];
  openBilling: [tenantId: string];
  previous: [];
  next: [];
  resize: [size: number];
}>();
const action = 'tenant-member:' + props.tenant.tenantId;
const query = ref(''), roleFilter = ref<'ALL' | 'OWNER' | 'ADMIN' | 'MEMBER'>('ALL'), sort = ref('role'), dialog = ref<HTMLDialogElement>();
const openMoreId = ref<string | null>(null);
const operation = ref(''), target = ref<Member>(), role = ref('MEMBER'), invite = ref(''), inviteKind = ref<'EMAIL' | 'PHONE'>('EMAIL'), saving = ref(false), error = ref('');
const labels: Record<string,string> = { OWNER: '所有者', ADMIN: '管理员', MEMBER: '成员' };
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
</script>
<template>
  <section class="tenant-members" :aria-busy="tab === 'members' && (loading || saving)">
    <header class="tm-heading">
      <div class="tm-heading-left">
        <div class="tm-team-avatar">{{ tenant.name.slice(0,1) }}</div>
        <div class="tm-heading-copy">
          <div class="tm-heading-row">
            <h2>{{ tenant.name }}</h2>
            <span class="tm-pill" :class="active ? 'is-success' : 'is-neutral'"><i class="tm-pill-dot" aria-hidden="true"></i>{{ active ? '正常' : '已停用' }}</span>
          </div>
          <p>{{ labels[tenant.myRole] }} · 本页 {{ members.length }} 位成员</p>
        </div>
      </div>
      <div class="tm-heading-actions">
        <button v-if="manager" type="button" class="tm-primary" :disabled="saving || busy || loading || refreshPending" @click="open('invite')">＋ 邀请成员</button>
        <button v-if="active && tenant.myRole !== 'OWNER'" type="button" class="tm-quiet tm-danger-soft" :disabled="saving || busy || loading || refreshPending" @click="open('leave')">退出团队</button>
      </div>
    </header>

    <div class="tm-card">
      <div class="tm-card-topbar">
        <nav class="tm-tabs" aria-label="团队管理">
          <div class="tm-tab-item" :class="{ 'is-active': tab === 'members' }">
            <button type="button" :aria-current="tab === 'members' ? 'page' : undefined" @click="tab = 'members'">成员管理</button>
            <span class="tm-tab-badge" aria-hidden="true" @click="tab = 'members'">{{ members.length }}</span>
          </div>
          <div class="tm-tab-item" :class="{ 'is-active': tab === 'billing' }">
            <button type="button" :aria-current="tab === 'billing' ? 'page' : undefined" @click="tab = 'billing'">套餐与账单</button>
          </div>
        </nav>

        <div v-if="tab === 'members'" class="tm-search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input v-model="query" type="search" placeholder="搜索本页名称或邮箱" aria-label="搜索本页名称或邮箱" />
        </div>
        <button v-else-if="billingEnabled" type="button" class="tm-topbar-action" :disabled="busy" @click="emit('openBilling', tenant.tenantId)">
          账单中心全屏查看 →
        </button>
      </div>

      <div v-if="tab === 'billing' && billingEnabled" class="tm-billing-body">
        <BillingPanel
          :key="billingScope"
          :client="client"
          :viewer-id="viewerId"
          :tenant-id="tenant.tenantId"
          :owner-name="tenant.name"
          :can-manage-orders="['OWNER', 'ADMIN'].includes(tenant.myRole)"
          @expired="emit('expired', $event)"
          @order-access-denied="emit('orderAccessDenied')"
        />
      </div>

      <div v-show="tab === 'members'">
        <div v-if="members.length > 1" class="tm-filter-bar">
          <div class="tm-filter-pills" role="group" aria-label="按角色筛选">
            <button
              v-for="[key, label] in ([['ALL', '全部'], ['OWNER', '所有者'], ['ADMIN', '管理员'], ['MEMBER', '成员']] as const)"
              :key="key"
              type="button"
              class="tm-filter-pill"
              :class="{ 'is-active': roleFilter === key }"
              @click="roleFilter = key"
            >
              <span>{{ label }}</span>
              <span class="tm-filter-cnt">{{ roleCounts[key] }}</span>
            </button>
          </div>
          <span class="tm-filter-hint">点击表头可按名称或角色排序</span>
        </div>

        <p v-if="error && !dialog?.open" class="tm-alert" role="alert">{{ error }}</p>

        <div class="tm-table-wrap">
          <table>
            <thead>
              <tr>
                <th :aria-sort="sort === 'name' ? 'ascending' : undefined"><button @click="sort='name'">用户 {{ sort==='name'?'↑':'' }}</button></th>
                <th>状态</th>
                <th :aria-sort="sort === 'role' ? 'ascending' : undefined"><button @click="sort='role'">角色 {{ sort==='role'?'↑':'' }}</button></th>
                <th class="tm-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading"><td colspan="4" class="tm-empty">正在加载成员…</td></tr>
              <tr v-else-if="!rows.length">
                <td colspan="4" class="tm-empty">
                  {{ query || roleFilter !== 'ALL' ? '没有匹配的成员' : active ? '暂无成员' : '团队已停用' }}
                  <button v-if="query || roleFilter !== 'ALL'" type="button" class="tm-clear-btn" @click="query = ''; roleFilter = 'ALL'">清除筛选</button>
                </td>
              </tr>
              <tr v-for="(m, index) in loading ? [] : rows" :key="m.membershipId">
                <td>
                  <div class="tm-person">
                    <span class="tm-initial">{{ (m.displayName || '未').slice(0,1).toUpperCase() }}</span>
                    <div>
                      <strong>{{ m.displayName || '未设置名称' }}<span v-if="m.membershipId === tenant.membershipId" class="tm-self">（我）</span></strong>
                      <small>{{ m.email || '未绑定邮箱' }}</small>
                    </div>
                  </div>
                </td>
                <td><span class="tm-status">{{ m.status === 'ACTIVE' ? '正常' : m.status }}</span></td>
                <td><span class="tm-role-pill" :class="m.role === 'OWNER' ? 'is-owner' : m.role === 'ADMIN' ? 'is-admin' : 'is-member'">{{ labels[m.role] }}</span></td>
                <td class="tm-actions">
                  <div class="tm-row-actions">
                    <template v-if="active && tenant.myRole === 'OWNER' && m.role !== 'OWNER'">
                      <button type="button" class="tm-row-btn" :disabled="saving || busy || refreshPending" @click="open('role', m)">修改角色</button>
                      <div class="tm-more-wrap">
                        <button
                          type="button"
                          class="tm-row-btn tm-more-trigger"
                          aria-label="更多操作"
                          :aria-expanded="openMoreId === m.membershipId"
                          :disabled="saving || busy || refreshPending"
                          @click.stop="toggleMore(m.membershipId)"
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <circle cx="5" cy="12" r="1.6" fill="currentColor" />
                            <circle cx="12" cy="12" r="1.6" fill="currentColor" />
                            <circle cx="19" cy="12" r="1.6" fill="currentColor" />
                          </svg>
                        </button>
                        <div
                          v-if="openMoreId === m.membershipId"
                          class="tm-more-menu"
                          :class="{ 'is-up': rows.length > 1 && index >= rows.length - 1 }"
                        >
                          <button type="button" @click="open('transfer', m)">交接所有权</button>
                          <button
                            v-if="m.role === 'MEMBER' && m.membershipId !== tenant.membershipId"
                            type="button"
                            class="is-danger"
                            @click="open('remove', m)"
                          >移除</button>
                        </div>
                      </div>
                    </template>
                    <button
                      v-else-if="manager && m.role === 'MEMBER' && m.membershipId !== tenant.membershipId"
                      type="button"
                      class="tm-row-btn tm-danger"
                      :disabled="saving || busy || refreshPending"
                      @click="open('remove', m)"
                    >移除</button>
                    <span v-else class="tm-no-actions" aria-label="暂无可用操作">—</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <footer class="tm-pagination">
          <span>本页 {{ rows.length }} 位成员</span>
          <div class="tm-page-controls">
            <button
              type="button"
              class="tm-page-size-trigger"
              popovertarget="tm-page-sizes"
              :disabled="busy || loading"
            >
              每页 {{ size }} 人
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
            </button>
            <div id="tm-page-sizes" ref="pageSizeMenu" class="tm-page-size-menu" popover role="group" aria-label="每页人数">
              <button
                v-for="option in pageSizes"
                :key="option"
                type="button"
                :aria-pressed="size === option"
                :disabled="busy || loading"
                @click="selectPageSize(option)"
              >
                {{ option }} 人
                <svg v-if="size === option" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-6" /></svg>
              </button>
            </div>
            <nav class="tm-page-navigation" aria-label="成员分页">
              <button type="button" :disabled="page <= 1 || busy || loading" aria-label="上一页" @click="emit('previous')">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 4-4 4 4 4" /></svg>
              </button>
              <span>第 {{ page }} 页</span>
              <button type="button" :disabled="!hasNext || busy || loading" aria-label="下一页" @click="emit('next')">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
              </button>
            </nav>
          </div>
        </footer>
      </div>
    </div>

    <div v-if="tab === 'members'" class="tm-role-footnote">
      <strong>权限说明：</strong>所有者可调整角色、交接所有权并管理账单；管理员可邀请或移除普通成员；成员可使用团队共享资源。
    </div>

    <dialog
      ref="dialog"
      class="tm-dialog"
      :class="{ 'tm-invite-dialog': operation === 'invite' }"
      aria-labelledby="tm-dialog-title"
      @cancel.prevent="close"
    >
      <form @submit.prevent="submit">
        <header>
          <h2 id="tm-dialog-title">{{ title }}</h2>
          <button type="button" aria-label="关闭" :disabled="saving" @click="close">×</button>
        </header>
        <div class="tm-dialog-body">
          <template v-if="operation === 'invite'">
            <label v-if="canInviteByPhone">邀请方式
              <select v-model="inviteKind" :disabled="saving">
                <option value="EMAIL">邮箱</option>
                <option value="PHONE">手机号</option>
              </select>
            </label>
            <label>{{ inviteKind === 'EMAIL' ? '邮箱地址' : '手机号（含国家区号）' }}
              <input
                v-model="invite"
                :type="inviteKind === 'EMAIL' ? 'email' : 'tel'"
                :placeholder="inviteKind === 'EMAIL' ? 'colleague@molis.ai' : undefined"
                aria-describedby="tm-invite-help"
                autocomplete="off"
                autofocus
                required
                :disabled="saving"
              />
            </label>
            <p id="tm-invite-help">对方使用此{{ inviteKind === 'EMAIL' ? '邮箱' : '手机号' }}登录后，可在「待处理」接受邀请。</p>
          </template>
          <template v-else-if="operation === 'role'">
            <p>{{ target?.displayName }}</p>
            <label>团队角色
              <select v-model="role" :disabled="saving">
                <option value="ADMIN">管理员</option>
                <option value="MEMBER">成员</option>
              </select>
            </label>
            <p>管理员可以邀请成员和移除普通成员；所有权需要单独交接。</p>
          </template>
          <p v-else-if="operation === 'remove'">确定移除 {{ target?.displayName }}？该成员的团队席位会同时释放。</p>
          <p v-else-if="operation === 'transfer'">将所有权交接给 {{ target?.displayName }}。对方接受后，你将不再是所有者。</p>
          <p v-else>确定退出 {{ tenant.name }}？你在该团队的席位会同时释放。</p>
          <p v-if="error" role="alert" class="tm-danger">{{ error }}</p>
        </div>
        <footer>
          <button type="button" :disabled="saving" @click="close">取消</button>
          <button class="tm-primary" :disabled="saving || (operation === 'role' && role === target?.role)" type="submit">
            {{ saving ? '正在提交…' : operation === 'invite' ? '创建邀请' : '确认' }}
          </button>
        </footer>
      </form>
    </dialog>
  </section>
</template>
<style scoped>
.tenant-members { min-width: 0; color: var(--ink); display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }

.tm-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px 16px; padding: 0; }
.tm-heading-left { display: flex; align-items: center; gap: 14px; min-width: 0; }
.tm-heading-copy { min-width: 0; }
.tm-heading-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.tm-heading h2 { font-size: 22px; line-height: 1.25; margin: 0; font-weight: 650; letter-spacing: -0.02em; }
.tm-heading p { margin: 4px 0 0; font-size: 12.5px; color: var(--muted); }
.tm-team-avatar {
  display: grid; place-items: center; width: 44px; height: 44px; border-radius: 11px;
  background: #eae9f9; color: #4b4899; font-size: 18px; font-weight: 650; flex-shrink: 0;
}
.tm-heading-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tm-pill {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px;
  border-radius: 999px; font-size: 11.5px; font-weight: 500; border: 1px solid transparent;
}
.tm-pill.is-success { background: #ecf7f0; color: #216b46; border-color: #cbe8d7; }
.tm-pill.is-neutral { background: #efeff2; color: var(--muted); border-color: #e2e2e7; }
.tm-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; font-style: normal; }

/* Unified Card + Embedded Topbar Tabs */
.tm-card {
  min-width: 0;
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04);
}
.tm-card-topbar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 8px 16px; padding: 0 20px; border-bottom: 1px solid var(--line);
  border-radius: 14px 14px 0 0;
}
.tm-tabs { display: flex; gap: 22px; align-items: stretch; }
.tm-tab-item {
  position: relative; display: inline-flex; align-items: center; gap: 6px; height: 48px;
}
.tm-tab-item.is-active::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  background: var(--ink); border-radius: 2px 2px 0 0;
}
.tenant-members .tm-tabs button {
  border: 0; border-radius: 0; box-shadow: none; height: 100%; min-height: 0;
  padding: 0 2px; font-size: 13.5px; font-weight: 500; color: var(--muted); background: transparent;
}
.tenant-members .tm-tabs button:hover:not(:disabled) { background: transparent; color: var(--ink); }
.tenant-members .tm-tabs button[aria-current] { color: var(--ink); font-weight: 600; }
.tm-tab-badge {
  min-width: 19px; height: 19px; padding: 0 6px; border-radius: 999px;
  background: #efeff3; color: var(--muted); font-size: 11px; font-weight: 600;
  display: inline-grid; place-items: center; font-variant-numeric: tabular-nums; cursor: pointer;
}
.tm-tab-item.is-active .tm-tab-badge { background: var(--primary); color: #fff; }

.tm-search-box { position: relative; display: inline-flex; align-items: center; padding: 8px 0; }
.tm-search-box svg {
  position: absolute; left: 10px; width: 14px; height: 14px; stroke-width: 1.8;
  color: #8e8e98; pointer-events: none;
}
.tm-search-box input { width: 224px; max-width: 100%; height: 32px; min-height: 32px; padding: 0 10px 0 30px; margin: 0; font-size: 12.5px; }
.tenant-members button.tm-topbar-action {
  margin: 8px 0; height: 30px; min-height: 30px; padding: 0 11px; font-size: 12px; border-radius: 7px;
}

.tm-billing-body { padding: 20px; }

/* Filter Bar (only when multiple members exist) */
.tm-filter-bar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 10px 14px; padding: 13px 20px;
}
.tm-filter-pills { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.tenant-members button.tm-filter-pill {
  height: 28px; min-height: 28px; padding: 0 10px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface); color: var(--muted);
  font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 5px;
}
.tenant-members button.tm-filter-pill:hover:not(:disabled) { border-color: #c8c8d2; color: var(--ink); background: var(--surface); }
.tenant-members button.tm-filter-pill.is-active { background: var(--primary); border-color: var(--primary); color: #fff; }
.tm-filter-cnt { opacity: 0.72; font-size: 11px; font-variant-numeric: tabular-nums; }
.tm-filter-hint { font-size: 12px; color: var(--muted); }
.tm-alert { margin: 12px 20px 0; color: #a62b33; font-size: 13px; }

/* Buttons */
.tenant-members button {
  margin: 0; font-size: 13px; border: 1px solid #d5d5db; border-radius: 8px;
  background: var(--surface); color: var(--ink); padding: 0 13px; height: 34px;
  cursor: pointer; white-space: nowrap; font-weight: 500;
}
.tenant-members button:hover:not(:disabled) { background: #fafafb; border-color: #c2c2cb; }
.tenant-members button:disabled { opacity: 0.45; cursor: default; }
.tenant-members button.tm-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.tenant-members button.tm-primary:hover:not(:disabled) { background: #343439; border-color: #343439; }
.tenant-members button.tm-danger-soft { border-color: #f4d3d6; color: #a62b33; background: var(--surface); }
.tenant-members button.tm-danger-soft:hover:not(:disabled) { background: #fdf1f2; }

/* Table */
.tm-table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; font-weight: 500; color: var(--muted); font-size: 12px;
  padding: 10px 20px; background: #fafafb;
  border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); white-space: nowrap;
}
.tenant-members th button {
  height: auto; min-height: 0; border: 0; background: transparent; box-shadow: none;
  border-radius: 0; padding: 0; font-size: 12px; color: var(--muted);
}
.tenant-members th button:hover:not(:disabled) { background: transparent; color: var(--ink); }
td { padding: 14px 20px; border-bottom: 1px solid var(--line); vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: #fafafc; }

.tm-person { display: flex; align-items: center; gap: 11px; min-width: 180px; }
.tm-initial {
  display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
  background: #e3e8f8; color: #40558f; font-size: 12.5px; font-weight: 650;
}
.tm-person strong { display: block; font-size: 13.5px; font-weight: 550; overflow-wrap: anywhere; color: var(--ink); }
.tm-self { color: var(--muted); font-weight: 400; }
.tm-person small { display: block; font-size: 12px; color: var(--muted); margin-top: 1px; }
.tm-status {
  display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px;
  color: #216b46; background: #ecf7f0; border: 1px solid #cbe8d7; font-size: 11.5px; font-weight: 500;
  white-space: nowrap;
}
.tm-role-pill {
  display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px;
  font-size: 11.5px; font-weight: 500; border: 1px solid transparent; white-space: nowrap;
}
.tm-role-pill.is-owner { background: #222227; color: #f5f5f7; }
.tm-role-pill.is-admin { background: var(--accent-soft); color: var(--accent); border-color: #d5def5; }
.tm-role-pill.is-member { background: #efeff2; color: var(--muted); border-color: #e2e2e7; }

/* Compact Row Actions + Overflow Menu */
.tm-actions { text-align: right; white-space: nowrap; }
.tm-row-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; }
.tenant-members button.tm-row-btn {
  height: 30px; min-height: 30px; padding: 0 10px; border: 1px solid #d5d5db; border-radius: 7px;
  background: var(--surface); font-size: 12px; color: var(--ink);
}
.tenant-members button.tm-row-btn.tm-danger { color: #a62b33; border-color: #f4d3d6; }
.tenant-members button.tm-row-btn.tm-danger:hover:not(:disabled) { background: #fdf1f2; }
.tm-no-actions { font-size: 12px; color: #8e8e98; }

.tm-more-wrap { position: relative; display: inline-flex; }
.tenant-members button.tm-more-trigger { width: 30px; padding: 0; display: inline-grid; place-items: center; color: var(--muted); }
.tenant-members button.tm-more-trigger svg { width: 14px; height: 14px; }
.tm-more-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; min-width: 132px;
  padding: 5px; border-radius: 10px; background: var(--surface);
  border: 1px solid var(--line); box-shadow: 0 6px 20px rgba(25, 25, 27, 0.1);
  display: grid; gap: 2px; text-align: left;
}
.tm-more-menu.is-up { top: auto; bottom: calc(100% + 4px); }
.tenant-members .tm-more-menu button {
  width: 100%; height: 32px; min-height: 32px; padding: 0 10px; border: 0; border-radius: 7px;
  background: transparent; text-align: left; font-size: 12.5px; color: var(--ink); box-shadow: none;
}
.tenant-members .tm-more-menu button:hover:not(:disabled) { background: #f2f2f6; }
.tenant-members .tm-more-menu button.is-danger { color: #a62b33; }
.tenant-members .tm-more-menu button.is-danger:hover:not(:disabled) { background: #fdf1f2; }

.tm-empty { text-align: center; height: 140px; color: var(--muted); }
.tenant-members button.tm-clear-btn { height: 28px; min-height: 28px; padding: 0 10px; margin-left: 8px; font-size: 12px; border-radius: 7px; }

.tm-pagination {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px;
  font-size: 12px; color: var(--muted); padding: 8px 20px;
  border-top: 1px solid var(--line); border-radius: 0 0 14px 14px;
  font-variant-numeric: tabular-nums;
}
.tm-page-controls, .tm-page-navigation { display: flex; align-items: center; gap: 4px; }
.tm-page-controls { margin-inline-start: auto; gap: 10px; }
.tm-page-navigation span { min-width: 46px; white-space: nowrap; text-align: center; }
.tenant-members .tm-pagination button {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 30px; min-height: 30px; padding: 0 8px; font-size: 12px;
  background: transparent; border-color: transparent; color: var(--muted);
}
.tenant-members .tm-pagination button:hover:not(:disabled) { background: #f2f2f6; color: var(--ink); }
.tenant-members .tm-page-navigation button { width: 30px; padding: 0; }
.tm-pagination svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.tm-page-size-trigger { anchor-name: --tm-page-size-trigger; }
.tm-page-size-menu {
  width: 108px; box-sizing: border-box; padding: 4px; border: 1px solid var(--line);
  border-radius: 10px; background: var(--surface); color: var(--ink);
  box-shadow: 0 4px 16px rgba(25, 25, 27, 0.10);
}
.tm-page-size-menu:popover-open { display: grid; gap: 2px; }
.tenant-members .tm-page-size-menu button { justify-content: space-between; width: 100%; color: var(--ink); }
.tenant-members .tm-page-size-menu button[aria-pressed=true] { background: #efeff3; }
@supports (position-anchor: --tm-page-size-trigger) {
  .tm-page-size-menu {
    position-anchor: --tm-page-size-trigger; inset: auto; right: anchor(right); bottom: calc(anchor(top) + 6px);
    margin: 0; position-try-fallbacks: flip-block;
  }
}

.tm-role-footnote {
  padding: 12px 18px; border-radius: 11px; background: var(--surface);
  border: 1px solid var(--line); font-size: 12px; color: var(--muted); line-height: 1.55;
}
.tm-role-footnote strong { color: var(--ink); font-weight: 600; }

.tm-dialog {
  width: min(460px, calc(100vw - 32px)); box-sizing: border-box; padding: 24px;
  border: 1px solid var(--line); border-radius: 14px; background: var(--surface);
  color: var(--ink); max-height: 90vh; overflow: auto;
}
.tm-dialog::backdrop { background: rgba(25, 25, 27, 0.42); backdrop-filter: blur(2px); }
.tm-dialog header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.tenant-members .tm-dialog header button { border: 0; background: transparent; box-shadow: none; height: 28px; padding: 0 8px; }
.tm-dialog h2 { font-size: 17px; font-weight: 600; margin: 0; }
.tm-dialog p { font-size: 13px; line-height: 1.65; color: var(--muted); overflow-wrap: anywhere; }
.tm-dialog label { display: block; font-size: 12.5px; margin-bottom: 14px; font-weight: 500; }
.tm-dialog input, .tm-dialog select { display: block; width: 100%; margin-top: 6px; box-sizing: border-box; }
.tm-dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
.tm-dialog form { margin: 0; }
.tm-danger { color: #a62b33; }

.tm-invite-dialog {
  width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0;
  box-shadow: 0 24px 60px rgba(25, 25, 27, 0.18);
}
.tenant-members .tm-invite-dialog form { margin: 0; }
.tm-invite-dialog header { margin: 0; padding: 18px 22px 14px; border-bottom: 1px solid var(--line); }
.tm-invite-dialog h2 { font-size: 16px; font-weight: 650; }
.tenant-members .tm-invite-dialog header button {
  width: 28px; min-height: 28px; padding: 0; border-radius: 7px; color: var(--muted); font-size: 18px;
}
.tenant-members .tm-invite-dialog header button:hover:not(:disabled) { background: #f2f2f5; color: var(--ink); }
.tm-invite-dialog .tm-dialog-body { padding: 18px 22px; display: grid; gap: 12px; color: #3f3f46; }
.tm-invite-dialog label { display: grid; gap: 6px; margin: 0; font-size: 13px; font-weight: 400; }
.tenant-members .tm-invite-dialog .tm-dialog-body input,
.tenant-members .tm-invite-dialog .tm-dialog-body select {
  height: 36px; min-height: 36px; margin: 0; padding: 0 10px;
  border: 1px solid #d5d5db; border-radius: 8px; background: var(--surface); color: var(--ink);
}
.tm-invite-dialog input:focus-visible, .tm-invite-dialog select:focus-visible { outline-offset: -2px; }
.tm-invite-dialog p { margin: 0; font-size: 12px; }
.tm-invite-dialog p[role=alert] { color: #a62b33; }
.tm-invite-dialog footer {
  margin: 0; padding: 14px 22px 18px; border-top: 1px solid var(--line); background: #fafafb;
}
.tenant-members .tm-invite-dialog footer button { min-height: 34px; padding: 0 13px; }

@media (max-width: 760px) {
  .tm-heading h2 { font-size: 19px; }
  .tm-card-topbar { padding: 0 16px; }
  .tm-search-box { width: 100%; }
  .tm-search-box input { width: 100%; }
  .tm-filter-bar { padding: 12px 16px; }
  .tm-filter-hint { display: none; }
  th, td { padding-inline: 14px; }
  .tm-pagination { padding: 6px 12px; }
  .tm-page-controls { gap: 4px; }
  .tm-page-navigation { gap: 0; }
  .tenant-members .tm-pagination button { min-height: 44px; }
  .tenant-members .tm-page-navigation button { width: 44px; }
  .tenant-members .tm-invite-dialog header button { width: 44px; height: 44px; }
  .tenant-members .tm-invite-dialog .tm-dialog-body input,
  .tenant-members .tm-invite-dialog .tm-dialog-body select { min-height: 44px; font-size: 16px; }
  .tenant-members .tm-invite-dialog footer button { min-height: 44px; }
}
</style>
