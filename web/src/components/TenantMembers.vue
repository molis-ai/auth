<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { AccountClient } from '../lib/account-client.ts';
import { accountErrorMessage } from '../lib/errors.ts';
import type { WriteOptions } from '../lib/idempotent-submit.ts';
type Member = { displayName: string; email: string | null; membershipId: string; userId: string; role: string; status: string; version: number };
type Tenant = { tenantId: string; name: string; status: string; myRole: string; membershipId: string; version: number };
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
  invitationChannels: string[];
  refreshPending: boolean;
  reload: (tenant: Tenant) => Promise<void>;
  ownMembership: (tenant: Tenant) => Promise<Member | undefined>;
  refreshTransfers: () => Promise<void>;
  leave: () => Promise<void>;
  discard: (action: string) => void;
  submitWrite: <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;
}>();
const tab = defineModel<'members' | 'billing'>('tab', { required: true });
const BillingPanel = defineAsyncComponent(() => import('./BillingPanel.vue'));
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
onBeforeUnmount(() => { props.discard(action); dialog.value?.close(); });
const query = ref(''), sort = ref('role'), dialog = ref<HTMLDialogElement>();
const operation = ref(''), target = ref<Member>(), role = ref('MEMBER'), invite = ref(''), inviteKind = ref(props.invitationChannels[0] ?? 'USER'), saving = ref(false), error = ref('');
const inviteLabels: Record<string, string> = { EMAIL: '邮箱', PHONE: '手机号', USER: '账号 ID' };
const labels: Record<string,string> = { OWNER: '所有者', ADMIN: '管理员', MEMBER: '成员' };
const weights: Record<string,number> = { OWNER: 0, ADMIN: 1, MEMBER: 2 };
const active = computed(() => props.tenant.status === 'ACTIVE');
const manager = computed(() => active.value && ['OWNER','ADMIN'].includes(props.tenant.myRole));
const billingScope = computed(() => JSON.stringify([
  props.viewerId, props.tenant.tenantId, props.tenant.membershipId, props.tenant.myRole, props.tenant.status,
]));
const rows = computed(() => props.members.filter(m => [m.displayName,m.email ?? ''].some(value => value.toLowerCase().includes(query.value.trim().toLowerCase()))).sort((a,b) => sort.value === 'role' ? weights[a.role]! - weights[b.role]! || a.displayName.localeCompare(b.displayName) : a.displayName.localeCompare(b.displayName)));
watch([role, () => invite.value.trim(), inviteKind, () => props.tenant.version],
  () => props.discard(action), { flush: 'sync' });
async function open(kind: string, member?: Member) {
  if (props.busy || props.loading || props.refreshPending) return;
  props.discard(action);
  if (kind === 'invite') inviteKind.value = props.invitationChannels[0] ?? 'USER';
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
      const mine = await props.ownMembership(tenant);
      if (!mine) throw Error('请刷新成员列表后重试');
      path = base + '/leave';
      body = { expectedVersion: mine.version };
    } else {
      if (!member) return;
      path = base + '/members/' + encodeURIComponent(member.membershipId) + (kind === 'role' ? '/role' : '/remove');
      body = { expectedVersion: member.version, ...(kind === 'role' ? { role: role.value } : {}) };
    }
    const success = kind === 'invite' ? '邀请已发送' : '操作已完成';
    await props.submitWrite(path, body, {
      action,
      method: kind === 'role' ? 'PATCH' : 'POST',
      success,
      refreshMessage: success + '，但成员或租户数据暂未刷新。',
      committed: () => {
        dialog.value?.close();
        if (kind === 'leave') emit('left', tenant.tenantId);
      },
      after: async () => {
        if (kind === 'leave') await props.leave();
        else await Promise.all([props.reload(tenant), props.refreshTransfers()]);
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
            <span class="tm-pill is-neutral">我的角色：{{ labels[tenant.myRole] }}</span>
          </div>
          <p>{{ labels[tenant.myRole] }} · 本页 {{ members.length }} 位成员</p>
        </div>
      </div>
      <div class="tm-heading-actions">
        <button v-if="billingEnabled" type="button" class="tm-ghost-btn" :disabled="busy" @click="emit('openBilling', tenant.tenantId)">查看团队账单 →</button>
        <button v-if="manager && tab === 'members'" type="button" class="tm-primary" :disabled="saving || busy || loading || refreshPending" @click="open('invite')">＋ 邀请成员</button>
        <button v-if="active && tenant.myRole !== 'OWNER'" type="button" class="tm-quiet tm-danger-soft" :disabled="saving || busy || loading || refreshPending" @click="open('leave')">退出团队</button>
      </div>
    </header>
    <nav class="tm-tabs" aria-label="团队管理">
      <button type="button" :aria-current="tab === 'members' ? 'page' : undefined" @click="tab = 'members'">成员管理</button>
      <button type="button" :aria-current="tab === 'billing' ? 'page' : undefined" @click="tab = 'billing'">套餐与账单</button>
    </nav>
    <BillingPanel v-if="tab === 'billing' && billingEnabled" :key="billingScope" :client="client"
      :viewer-id="viewerId" :tenant-id="tenant.tenantId" :owner-name="tenant.name"
      :can-manage-orders="['OWNER', 'ADMIN'].includes(tenant.myRole)" @expired="emit('expired', $event)"
      @order-access-denied="emit('orderAccessDenied')" />
    <div v-show="tab === 'members'" class="tm-card">
      <div class="tm-tools">
        <div class="tm-tools-title">
          <h3>成员列表</h3>
          <span class="tm-count">{{ rows.length }}</span>
        </div>
        <input v-model="query" type="search" placeholder="搜索本页名称或邮箱" aria-label="搜索本页名称或邮箱"/>
      </div>
      <p v-if="error && !dialog?.open" class="tm-alert" role="alert">{{ error }}</p>
      <div class="tm-table-wrap"><table><thead><tr><th :aria-sort="sort === 'name' ? 'ascending' : undefined"><button @click="sort='name'">用户 {{ sort==='name'?'↑':'' }}</button></th><th>状态</th><th :aria-sort="sort === 'role' ? 'ascending' : undefined"><button @click="sort='role'">角色 {{ sort==='role'?'↑':'' }}</button></th><th class="tm-actions">操作</th></tr></thead><tbody>
        <tr v-if="loading"><td colspan="4" class="tm-empty">正在加载成员…</td></tr>
        <tr v-else-if="!rows.length"><td colspan="4" class="tm-empty">{{ query ? '没有匹配的成员' : active ? '暂无成员' : '团队已停用' }}<button v-if="query" @click="query=''">清除搜索</button></td></tr>
        <tr v-for="m in loading ? [] : rows" :key="m.membershipId"><td><div class="tm-person"><span class="tm-initial">{{ (m.displayName || '未').slice(0,1).toUpperCase() }}</span><div><strong>{{ m.displayName || '未设置名称' }}<span v-if="m.membershipId === tenant.membershipId" class="tm-self">（我）</span></strong><small>{{ m.email || '未绑定邮箱' }}</small></div></div></td><td><span class="tm-status">{{ m.status === 'ACTIVE' ? '正常' : m.status }}</span></td><td><span class="tm-role-pill" :class="m.role === 'OWNER' ? 'is-owner' : m.role === 'ADMIN' ? 'is-admin' : 'is-member'">{{ labels[m.role] }}</span></td><td class="tm-actions">
          <div class="tm-action-slots">
            <span><button v-if="active && tenant.myRole==='OWNER' && m.role!=='OWNER'" :disabled="saving || busy || refreshPending" @click="open('role',m)">修改角色</button></span>
            <span><button v-if="active && tenant.myRole==='OWNER' && m.role!=='OWNER'" :disabled="saving || busy || refreshPending" @click="open('transfer',m)">交接所有权</button></span>
            <span><button v-if="manager && m.role==='MEMBER' && m.membershipId!==tenant.membershipId" class="tm-danger" :disabled="saving || busy || refreshPending" @click="open('remove',m)">移除</button></span>
            <span v-if="!manager || m.role==='OWNER'" class="tm-no-actions" aria-label="暂无可用操作">—</span>
          </div>
        </td></tr>
      </tbody></table></div>
      <footer class="tm-pagination"><span>本页 {{ rows.length }} 位成员</span><label>每页 <select :value="size" :disabled="busy || loading" @change="emit('resize', Number(($event.target as HTMLSelectElement).value))"><option :value="10">10</option><option :value="20">20</option><option :value="50">50</option></select> 人</label><button :disabled="page<=1 || busy || loading" aria-label="上一页" @click="emit('previous')">‹</button><span>第 {{ page }} 页</span><button :disabled="!hasNext || busy || loading" aria-label="下一页" @click="emit('next')">›</button></footer>
    </div>
    <dialog ref="dialog" class="tm-dialog" aria-labelledby="tm-dialog-title" @cancel.prevent="close"><form @submit.prevent="submit"><header><h2 id="tm-dialog-title">{{ title }}</h2><button type="button" aria-label="关闭" :disabled="saving" @click="close">×</button></header>
      <template v-if="operation==='invite'"><label v-if="invitationChannels.length > 1">邀请方式<select v-model="inviteKind" :disabled="saving"><option v-for="channel in invitationChannels" :key="channel" :value="channel">{{ inviteLabels[channel] }}</option></select></label><label>{{ inviteKind==='EMAIL'?'邮箱地址':inviteKind==='PHONE'?'手机号（含国家区号）':'账号 ID' }}<input v-model="invite" :type="inviteKind==='EMAIL'?'email':'text'" required :disabled="saving" autocomplete="off" /></label><p>对方接受后以成员身份加入，之后可以调整角色。</p></template>
      <template v-else-if="operation==='role'"><p>{{ target?.displayName }}</p><label>团队角色<select v-model="role" :disabled="saving"><option value="ADMIN">管理员</option><option value="MEMBER">成员</option></select></label><p>管理员可以邀请成员和移除普通成员；所有权需要单独交接。</p></template>
      <p v-else-if="operation==='remove'">确定移除 {{ target?.displayName }}？该成员的团队席位会同时释放。</p>
      <p v-else-if="operation==='transfer'">将所有权交接给 {{ target?.displayName }}。对方接受后，你将不再是所有者。</p>
      <p v-else>确定退出 {{ tenant.name }}？你在该团队的席位会同时释放。</p>
      <p v-if="error" role="alert" class="tm-danger">{{ error }}</p><footer><button type="button" :disabled="saving" @click="close">取消</button><button class="tm-primary" :disabled="saving || (operation==='role' && role===target?.role)" type="submit">{{ saving?'正在提交…':operation==='invite'?'发送邀请':'确认' }}</button></footer>
    </form></dialog>
  </section>
</template>
<style scoped>
.tenant-members { min-width: 0; color: var(--ink); }
.tm-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; padding: 0 0 16px; }
.tm-heading-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.tm-heading-copy { min-width: 0; }
.tm-heading-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.tm-heading h2 { font-size: 22px; line-height: 1.3; margin: 0; font-weight: 650; letter-spacing: -0.02em; }
.tm-heading p { margin: 3px 0 0; font-size: 12.5px; color: var(--muted); }
.tm-team-avatar {
  display: grid; place-items: center; width: 42px; height: 42px; border-radius: 10px;
  background: #eae9f9; color: #4b4899; font-size: 17px; font-weight: 650; flex-shrink: 0;
}
.tm-heading-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tm-pill {
  display: inline-flex; align-items: center; gap: 5px; height: 23px; padding: 0 9px;
  border-radius: 999px; font-size: 11.5px; font-weight: 500; border: 1px solid transparent;
}
.tm-pill.is-success { background: #ecf7f0; color: #216b46; border-color: #cbe8d7; }
.tm-pill.is-neutral { background: #efeff2; color: var(--muted); border-color: #e2e2e7; }
.tm-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; font-style: normal; }

.tm-tabs { display: flex; gap: 20px; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.tenant-members .tm-tabs button {
  border: 0; border-bottom: 2px solid transparent; border-radius: 0; box-shadow: none;
  padding: 10px 2px; font-size: 14px; font-weight: 500; color: var(--muted); background: transparent;
}
.tenant-members .tm-tabs button:hover:not(:disabled) { background: transparent; color: var(--ink); }
.tenant-members .tm-tabs button[aria-current] { border-bottom-color: var(--ink); color: var(--ink); font-weight: 600; }

.tm-card {
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04); overflow: hidden;
}
.tm-tools {
  display: flex; align-items: center; justify-content: space-between; gap: 12px 16px;
  padding: 16px 20px; flex-wrap: wrap;
}
.tm-tools-title { display: inline-flex; align-items: center; gap: 8px; }
.tm-tools-title h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); }
.tm-count {
  min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
  background: #efeff3; color: var(--muted); font-size: 11px; font-weight: 600;
  display: inline-grid; place-items: center; font-variant-numeric: tabular-nums;
}
.tm-tools input { max-width: 240px; margin: 0; }
.tm-alert { margin: 0 20px 12px; color: #a62b33; font-size: 13px; }

.tenant-members button {
  margin: 0; font-size: 13px; border: 1px solid #d5d5db; border-radius: 8px;
  background: var(--surface); color: var(--ink); padding: 0 13px; height: 34px;
  cursor: pointer; white-space: nowrap; font-weight: 500;
}
.tenant-members button:hover:not(:disabled) { background: #fafafb; border-color: #c2c2cb; }
.tenant-members button:disabled { opacity: 0.45; cursor: default; }
.tenant-members .tm-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.tenant-members .tm-primary:hover:not(:disabled) { background: #343439; border-color: #343439; }
.tenant-members .tm-danger-soft { border-color: #f4d3d6; color: #a62b33; background: var(--surface); }
.tenant-members .tm-danger-soft:hover:not(:disabled) { background: #fdf1f2; }

.tm-table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; font-weight: 500; color: var(--muted); font-size: 12px;
  padding: 10px 18px; background: #fafafb;
  border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); white-space: nowrap;
}
.tenant-members th button {
  height: auto; min-height: 0; border: 0; background: transparent; box-shadow: none;
  border-radius: 0; padding: 0; font-size: 12px; color: var(--muted);
}
.tenant-members th button:hover:not(:disabled) { background: transparent; color: var(--ink); }
td { padding: 13px 18px; border-bottom: 1px solid var(--line); vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: #fafafc; }

.tm-person { display: flex; align-items: center; gap: 10px; min-width: 160px; }
.tm-initial {
  display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
  background: #e3e8f8; color: #40558f; font-size: 12px; font-weight: 650;
}
.tm-person strong { display: block; font-size: 13px; font-weight: 550; overflow-wrap: anywhere; color: var(--ink); }
.tm-self { color: var(--muted); font-weight: 400; }
.tm-person small { display: block; font-size: 11.5px; color: var(--muted); margin-top: 1px; }
.tm-status {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px;
  color: #216b46; background: #ecf7f0; border: 1px solid #cbe8d7; font-size: 11.5px; font-weight: 500;
  white-space: nowrap;
}
.tm-role-pill {
  display: inline-flex; align-items: center; height: 23px; padding: 0 9px; border-radius: 999px;
  font-size: 11.5px; font-weight: 500; border: 1px solid transparent; white-space: nowrap;
}
.tm-role-pill.is-owner { background: #222227; color: #f5f5f7; }
.tm-role-pill.is-admin { background: var(--accent-soft); color: var(--accent); border-color: #d5def5; }
.tm-role-pill.is-member { background: #efeff2; color: var(--muted); border-color: #e2e2e7; }

.tm-actions { text-align: right; }
.tenant-members .tm-actions button {
  height: 28px; min-height: 28px; padding: 0 9px; border: 1px solid #d5d5db; border-radius: 7px;
  background: var(--surface); font-size: 12px; margin-left: 6px;
}
.tenant-members .tm-actions button.tm-danger { color: #a62b33; border-color: #f4d3d6; }
.tenant-members .tm-actions button.tm-danger:hover:not(:disabled) { background: #fdf1f2; }
.tm-empty { text-align: center; height: 140px; color: var(--muted); }
.tm-pagination {
  display: flex; align-items: center; justify-content: flex-end; gap: 10px;
  font-size: 12px; color: var(--muted); padding: 12px 20px;
  border-top: 1px solid var(--line); background: #fafafb;
}
.tm-pagination > span:first-child { margin-right: auto; }
.tm-pagination label { display: flex; align-items: center; gap: 6px; margin: 0; }
.tm-pagination select { width: auto; margin: 0; padding: 3px 6px; height: 28px; min-height: 28px; }
.tenant-members .tm-pagination button { height: 28px; min-height: 28px; padding: 0 9px; font-size: 12px; }

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

@media (max-width: 760px) {
  .tm-heading h2 { font-size: 19px; }
  .tm-tools { padding: 14px 16px; }
  .tm-actions { min-width: 140px; }
  .tm-pagination { flex-wrap: wrap; padding: 12px 16px; }
}
</style>
