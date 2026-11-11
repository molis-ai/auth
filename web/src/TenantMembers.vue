<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { AccountClient } from '../../sdk/browser/src/index.ts';
import { accountErrorMessage } from './errors.ts';
type Member = { displayName: string; email: string | null; membershipId: string; userId: string; role: string; status: string; version: number };
type Tenant = { tenantId: string; name: string; status: string; myRole: string; membershipId: string; version: number };
const props = defineProps<{ tenant: Tenant; members: Member[]; client: AccountClient; loading: boolean; reload: () => Promise<void>; refreshTransfers: () => Promise<void>; leave: () => Promise<void> }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
let mounted = true;
onBeforeUnmount(() => { mounted = false; dialog.value?.close(); });
const query = ref(''), page = ref(1), size = ref(10), sort = ref('role'), dialog = ref<HTMLDialogElement>();
const operation = ref(''), target = ref<Member>(), role = ref('MEMBER'), invite = ref(''), inviteKind = ref('EMAIL'), saving = ref(false), error = ref(''), notice = ref('');
const labels: Record<string,string> = { OWNER: '所有者', ADMIN: '管理员', MEMBER: '成员' };
const weights: Record<string,number> = { OWNER: 0, ADMIN: 1, MEMBER: 2 };
const active = computed(() => props.tenant.status === 'ACTIVE');
const manager = computed(() => active.value && ['OWNER','ADMIN'].includes(props.tenant.myRole));
const filtered = computed(() => props.members.filter(m => [m.displayName,m.email ?? ''].some(value => value.toLowerCase().includes(query.value.trim().toLowerCase()))).sort((a,b) => sort.value === 'role' ? weights[a.role]! - weights[b.role]! || a.displayName.localeCompare(b.displayName) : a.displayName.localeCompare(b.displayName)));
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / size.value)));
const rows = computed(() => filtered.value.slice((page.value-1)*size.value,page.value*size.value));
watch([query,size,sort], () => { page.value = 1; });
watch(pages, value => { page.value = Math.min(page.value,value); });
async function open(kind: string, member?: Member) {
  operation.value = kind; target.value = member; role.value = member?.role ?? 'MEMBER'; invite.value = ''; error.value = ''; notice.value = '';
  await nextTick(); dialog.value?.showModal();
}
function close() { if (!saving.value) dialog.value?.close(); }
const title = computed(() => ({ invite: '邀请成员', role: '修改角色', remove: '移除成员', transfer: '交接所有权', leave: '退出团队' })[operation.value]);
async function submit() {
  if (saving.value) return;
  saving.value = true; emit('busy', true); error.value = '';
  try {
    const base = '/tenants/' + encodeURIComponent(props.tenant.tenantId);
    const member = target.value;
    if (operation.value === 'invite') await props.client.request(base+'/invitations', {target: {kind:inviteKind.value,value:invite.value.trim()}}, 'POST', crypto.randomUUID());
    else if (operation.value === 'transfer' && member) await props.client.request(base+'/ownership-transfers',{targetMembershipId:member.membershipId,expectedVersion:props.tenant.version},'POST',crypto.randomUUID());
    else if (operation.value === 'leave') {
      const mine = props.members.find(m => m.membershipId === props.tenant.membershipId);
      if (!mine) throw Error('请刷新成员列表后重试');
      await props.client.request(base+'/leave',{expectedVersion:mine.version},'POST',crypto.randomUUID());
    } else if (member) await props.client.request(base+'/members/'+encodeURIComponent(member.membershipId)+(operation.value==='role'?'/role':'/remove'),{expectedVersion:member.version,...(operation.value==='role'?{role:role.value}:{})},operation.value==='role'?'PATCH':'POST',crypto.randomUUID());
    if (!mounted) return;
    dialog.value?.close();
    notice.value = operation.value === 'invite' ? '邀请已发送，对方接受后会加入团队。' : '操作已完成';
    if (operation.value === 'leave') { emit('busy', false); await props.leave(); }
    else { await props.reload(); await props.refreshTransfers(); }
  } catch(e) { error.value = accountErrorMessage(e); }
  finally { saving.value = false; if (mounted) emit('busy', false); }
}
</script>
<template>
  <section class="tenant-members" :aria-busy="loading || saving">
    <header class="tm-heading"><div class="tm-team-avatar">{{ tenant.name.slice(0,1) }}</div><div><h2>{{ tenant.name }}</h2><p>{{ labels[tenant.myRole] }} · {{ members.length }} 位成员</p></div><button v-if="active && tenant.myRole !== 'OWNER'" class="tm-quiet" :disabled="saving || loading" @click="open('leave')">退出团队</button></header>
    <nav class="tm-tabs" aria-label="团队管理"><span aria-current="page">成员管理</span></nav>
    <div class="tm-tools"><input v-model="query" type="search" placeholder="搜索名称或邮箱" aria-label="搜索名称或邮箱"/><button v-if="manager" class="tm-primary" :disabled="saving || loading" @click="open('invite')">＋ 邀请成员</button></div>
    <p v-if="notice" role="status" class="tm-feedback">{{ notice }}</p><p v-if="error && !dialog?.open" role="alert">{{ error }}</p>
    <div class="tm-table-wrap"><table><thead><tr><th><button @click="sort='name'">用户 {{ sort==='name'?'↓':'' }}</button></th><th>状态</th><th><button @click="sort='role'">角色 {{ sort==='role'?'↓':'' }}</button></th><th class="tm-actions">操作</th></tr></thead><tbody>
      <tr v-if="loading"><td colspan="4" class="tm-empty">正在加载成员…</td></tr>
      <tr v-else-if="!rows.length"><td colspan="4" class="tm-empty">{{ query ? '没有匹配的成员' : active ? '暂无成员' : '团队已停用' }}<button v-if="query" @click="query=''">清除搜索</button></td></tr>
      <tr v-for="m in loading ? [] : rows" :key="m.membershipId"><td><div class="tm-person"><span class="tm-initial">{{ (m.displayName || '未').slice(0,1).toUpperCase() }}</span><div><strong>{{ m.displayName || '未设置名称' }}<span v-if="m.membershipId === tenant.membershipId" class="tm-self">（我）</span></strong><small>{{ m.email || '未绑定邮箱' }}</small></div></div></td><td><span class="tm-status">{{ m.status === 'ACTIVE' ? '正常' : m.status }}</span></td><td>{{ labels[m.role] }}</td><td class="tm-actions">
        <div class="tm-action-slots">
          <span><button v-if="active && tenant.myRole==='OWNER' && m.role!=='OWNER'" :disabled="saving" @click="open('role',m)">修改角色</button></span>
          <span><button v-if="active && tenant.myRole==='OWNER' && m.role!=='OWNER'" :disabled="saving" @click="open('transfer',m)">交接所有权</button></span>
          <span><button v-if="manager && m.role==='MEMBER' && m.membershipId!==tenant.membershipId" class="tm-danger" :disabled="saving" @click="open('remove',m)">移除</button></span>
          <span v-if="!manager || m.role==='OWNER'" class="tm-no-actions" aria-label="暂无可用操作">—</span>
        </div>
      </td></tr>
    </tbody></table></div>
    <footer class="tm-pagination"><span>共 {{ filtered.length }} 位成员</span><label>每页 <select v-model="size"><option :value="10">10</option><option :value="20">20</option><option :value="50">50</option></select> 人</label><button :disabled="page<=1" aria-label="上一页" @click="page--">‹</button><span>{{ page }} / {{ pages }}</span><button :disabled="page>=pages" aria-label="下一页" @click="page++">›</button></footer>
    <dialog ref="dialog" class="tm-dialog" aria-labelledby="tm-dialog-title" @cancel.prevent="close"><form @submit.prevent="submit"><header><h2 id="tm-dialog-title">{{ title }}</h2><button type="button" aria-label="关闭" :disabled="saving" @click="close">×</button></header>
      <template v-if="operation==='invite'"><label>邀请方式<select v-model="inviteKind" :disabled="saving"><option value="EMAIL">邮箱</option><option value="PHONE">手机号</option><option value="USER">账号 ID</option></select></label><label>{{ inviteKind==='EMAIL'?'邮箱地址':inviteKind==='PHONE'?'手机号（含国家区号）':'账号 ID' }}<input v-model="invite" :type="inviteKind==='EMAIL'?'email':'text'" required :disabled="saving" autocomplete="off" /></label><p>对方接受后以成员身份加入，之后可以调整角色。</p></template>
      <template v-else-if="operation==='role'"><p>{{ target?.displayName }}</p><label>团队角色<select v-model="role" :disabled="saving"><option value="ADMIN">管理员</option><option value="MEMBER">成员</option></select></label><p>管理员可以邀请成员和移除普通成员；所有权需要单独交接。</p></template>
      <p v-else-if="operation==='remove'">确定移除 {{ target?.displayName }}？该成员的团队席位会同时释放。</p>
      <p v-else-if="operation==='transfer'">将所有权交接给 {{ target?.displayName }}。对方接受后，你将不再是所有者。</p>
      <p v-else>确定退出 {{ tenant.name }}？你在该团队的席位会同时释放。</p>
      <p v-if="error" role="alert" class="tm-danger">{{ error }}</p><footer><button type="button" :disabled="saving" @click="close">取消</button><button class="tm-primary" :disabled="saving || (operation==='role' && role===target?.role)" type="submit">{{ saving?'正在提交…':operation==='invite'?'发送邀请':'确认' }}</button></footer>
    </form></dialog>
  </section>
</template>
<style scoped>
.tenant-members{min-width:0;color:var(--ink)}.tm-heading{display:flex;align-items:center;gap:14px;padding:8px 0 25px}.tm-heading h2{font-size:21px;margin:0 0 6px;font-weight:550}.tm-heading p{margin:0;font-size:12px;color:var(--muted)}.tm-team-avatar{display:grid;place-items:center;width:48px;height:48px;border:1px solid var(--line);border-radius:12px;background:var(--sidebar);font-size:20px}.tm-quiet{margin-left:auto}.tm-tabs{border-bottom:1px solid var(--line);margin-bottom:24px}.tm-tabs span{display:inline-block;border-bottom:2px solid var(--ink);padding:12px 2px;font-size:14px}.tm-tools{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.tm-tools input{max-width:300px;margin:0}.tenant-members button{margin:0;font-size:12px;border:0;background:transparent;color:inherit;padding:8px 10px;cursor:pointer;white-space:nowrap}.tenant-members button:hover:not(:disabled){background:var(--sidebar)}.tenant-members button:disabled{opacity:.45;cursor:default}.tenant-members .tm-primary{background:var(--ink);color:var(--surface);border-radius:7px;padding:10px 15px}.tenant-members .tm-primary:hover:not(:disabled){background:#45454d}.tm-table-wrap{overflow-x:auto;min-height:220px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;font-weight:450;color:var(--muted);padding:12px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th button{padding:0!important}td{padding:16px 10px;border-bottom:1px solid var(--line)}.tm-person{display:flex;align-items:center;gap:10px;min-width:160px}.tm-initial{display:grid;place-items:center;background:var(--sidebar);width:34px;height:34px;border-radius:50%;flex-shrink:0}.tm-person strong{display:block;font-size:13px;font-weight:500;overflow-wrap:anywhere}.tm-person small{display:block;font-size:11px;color:var(--muted);margin-top:4px}.tm-status{color:#367153;background:#edf5ef;border-radius:5px;padding:3px 7px;font-size:11px}.tm-actions{text-align:right}.tm-actions button{padding:6px}.tenant-members .tm-danger{color:#b42318}.tm-empty{text-align:center;height:160px;color:var(--muted)}.tm-pagination{display:flex;align-items:center;justify-content:flex-end;gap:12px;font-size:12px;color:var(--muted);padding:18px 0}.tm-pagination>span:first-child{margin-right:auto}.tm-pagination label{display:flex;align-items:center;gap:6px;margin:0}.tm-pagination select{width:auto;margin:0;padding:4px}.tm-feedback{font-size:13px;color:#367153}.tm-dialog{width:min(460px,calc(100vw - 32px));box-sizing:border-box;padding:24px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);max-height:90vh;overflow:auto}.tm-dialog::backdrop{background:#19191b55}.tm-dialog header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.tm-dialog h2{font-size:18px;margin:0}.tm-dialog p{font-size:13px;line-height:1.7;color:var(--muted);overflow-wrap:anywhere}.tm-dialog label{display:block;font-size:13px;margin-bottom:16px}.tm-dialog input,.tm-dialog select{display:block;width:100%;margin-top:8px;box-sizing:border-box}.tm-dialog footer{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}@media(max-width:760px){.tm-heading h2{font-size:17px}.tm-tools{flex-wrap:wrap}.tm-actions{min-width:140px}.tenant-members button{min-height:40px}.tm-pagination{flex-wrap:wrap}}
/* Keep the compact member controls from the previous team screen above shell defaults. */
.tenant-members th button{min-height:0;border:0;background:transparent;box-shadow:none;border-radius:0;padding:0}
.tenant-members .tm-actions button{min-height:32px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;font-size:12px;margin-left:6px}
.tenant-members .tm-dialog header button{border:0;background:transparent;box-shadow:none}
.tenant-members .tm-dialog h2{font-size:18px;font-weight:550}
.tenant-members .tm-dialog form{margin:0}
</style>
