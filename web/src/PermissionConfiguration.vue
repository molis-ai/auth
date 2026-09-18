<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElSelect, ElOption, ElButton, ElTooltip } from 'element-plus'
import 'element-plus/es/components/select/style/css'
import 'element-plus/es/components/option/style/css'
import 'element-plus/es/components/tooltip/style/css'
import type { AuthClient } from '../../sdk/browser/src/index.ts'
import { platform, ConsoleError, listPath, type Application, type Page } from './console-api'
import { permissionLevel, replaceResourceGrant, type PermissionLevel } from './permission-edit'
const emit = defineEmits<{ draft:[boolean]; busy:[boolean] }>()
const props = defineProps<{ auth: AuthClient; language: 'en' | 'zh-CN' }>()
type Matrix = { console: boolean; application: Application; roles: { role: string; actions: string[] }[] }
const apps = ref<Application[]>([]), selected = ref(''), matrix = ref<Matrix>(), loading = ref(false), failed = ref(false), appsFailed = ref(false)
const editing=ref(false), saving=ref(false), draft=ref<Record<string,string[]>>({}), error=ref(''), saved=ref(false), stale=ref(false)
const saveDialog=ref<HTMLDialogElement>(), saveButton=ref<HTMLButtonElement>()
const dirty=computed(()=>matrix.value?.roles.some(r=>JSON.stringify([...(draft.value[r.role]??r.actions)].sort())!==JSON.stringify([...r.actions].sort())) ?? false)
watch(dirty,value=>emit('draft',value));watch(saving,value=>emit('busy',value))
function startEdit(){if(!matrix.value||matrix.value.console)return;draft.value=Object.fromEntries(matrix.value.roles.map(r=>[r.role,[...r.actions]]));editing.value=true;error.value='';saved.value=false;stale.value=false}
function cancelEdit(){editing.value=false;draft.value={};error.value='';stale.value=false}
function levelLabel(level:PermissionLevel){return ({none:en.value?'No access':'无权限',read:en.value?'View':'查看',edit:en.value?'Edit':'编辑',custom:en.value?'Partial access':'细分权限'})[level]}
function updateCell(role:string,actions:string[],level:PermissionLevel){draft.value[role]=replaceResourceGrant(draft.value[role]??[],actions,level)}
function closeSave(){if(saving.value)return;saveDialog.value?.close();saveButton.value?.focus()}
async function save(){
 if(!matrix.value||saving.value||!dirty.value||stale.value)return
 saving.value=true;error.value=''
 try{
  const result=await platform<{saved:boolean;version:number}>(props.auth,'/applications/'+selected.value+'/permission-matrix','PUT',{version:matrix.value.application.version,grants:matrix.value.roles.flatMap(r=>(draft.value[r.role]??[]).map(a=>r.role+':'+a))})
  matrix.value={...matrix.value,application:{...matrix.value.application,version:result.version},roles:matrix.value.roles.map(r=>({...r,actions:[...(draft.value[r.role]??[])]}))}
  editing.value=false;draft.value={};saved.value=true
 }catch(failure){
  const conflict=failure instanceof ConsoleError&&failure.code==='VERSION_CONFLICT'
  const uncertain=failure instanceof ConsoleError&&failure.uncertain
  stale.value=conflict||uncertain
  error.value=conflict?(en.value?'Configuration changed elsewhere. Your edits are retained; reload before editing again.':'配置已被其他人修改，已保留本次内容。请重新加载后再编辑。'):uncertain?(en.value?'Save result unknown. Reload to check before trying again.':'保存结果不确定，请重新加载核对后再编辑。'):(en.value?'Save failed. Your edits are retained.':'保存失败，已保留修改内容。')
 }finally{saving.value=false;saveDialog.value?.close();saveButton.value?.focus()}
}
async function reloadAfterConflict(){if(!window.confirm(en.value?'Discard these edits and reload?':'放弃本次修改并重新加载？'))return;cancelEdit();await loadMatrix()}
const changes=computed(()=>matrix.value?.roles.flatMap(role=>rows.value.filter(row=>JSON.stringify(row.permissions.filter(a=>role.actions.includes(a)).sort())!==JSON.stringify(row.permissions.filter(a=>draft.value[role.role]?.includes(a)).sort())).map(row=>({key:role.role+row.resource,name:row.name,role:roleNames[role.role]?.[en.value?1:0]??role.role,before:levelLabel(permissionLevel(row.permissions,role.actions)),after:levelLabel(permissionLevel(row.permissions,draft.value[role.role]??role.actions))})))??[])
let generation = 0, disposed = false
const en = computed(() => props.language === 'en')
const names: Record<string, [string,string]> = { space:['团队','Team'], 'space.member':['成员','Members'], role:['角色','Roles'], project:['项目','Projects'], goal:['目标','Goals'], session:['会话','Sessions'], feed:['Feed','Feed'], planning:['规划','Planning'] }
const actions: Record<string,[string,string]> = { read:['查看','View'], create:['创建','Create'], update:['编辑','Edit'], delete:['删除','Delete'], archive:['归档','Archive'], restore:['恢复','Restore'], advance:['推进','Advance'], approve:['审批','Approve'], manage:['管理','Manage'] }
const roleNames: Record<string,[string,string]> = { OWNER:['所有者','Owner'], ADMIN:['管理员','Administrator'], MEMBER:['成员','Member'], VIEWER:['只读成员','Viewer'] }
const consoleCapabilities:Record<string,[string,string,string?]> = {
  'team.read':['查看团队资料','View team profile'], 'team.update':['修改团队资料','Edit team profile'],
  'members.read':['查看成员','View members'], 'members.invite':['邀请成员','Invite members'],
  'members.role':['修改成员角色','Change member roles','role'], 'members.remove':['移除成员','Remove members','remove'],
  'invitations.read':['查看邀请记录','View invitations'], 'invitations.revoke':['撤销邀请','Revoke invitations'],
  'audit.read':['查看操作日志','View activity log'], 'team.archive':['归档 / 恢复团队','Archive / restore team'], 'team.leave':['退出团队','Leave team']
}
function restriction(capability:string, role:string) {
  if (!['members.role','members.remove'].includes(capability)) return ''
  return role==='OWNER' ? (en.value?'Except the owner':'不含所有者') : role==='ADMIN' ? (en.value?'Members and viewers only':'仅成员与只读成员') : ''
}
const rows = computed(() => {
  if(matrix.value?.console)return matrix.value.application.actions.map(action=>({resource:action,name:consoleCapabilities[action]?.[en.value?1:0] ?? action,permissions:[action]}))
  const groups = new Map<string,string[]>()
  for (const action of matrix.value?.application.actions ?? []) { const resource = action.slice(0, action.lastIndexOf('.')); groups.set(resource,[...(groups.get(resource) ?? []), action]) }
  return [...groups].map(([resource, permissions]) => ({ resource, name:names[resource]?.[en.value?1:0] ?? resource, permissions }))
})
function capabilityLabel(capability:string, allowed:boolean) {
  if (!allowed) return en.value ? 'No access' : '无权限'
  if (capability.endsWith('.read')) return en.value ? 'View' : '查看'
  if (capability === 'team.update') return en.value ? 'Edit' : '编辑'
  return en.value ? 'Manage' : '管理'
}
function actionLabel(action: string) { const verb=action.slice(action.lastIndexOf('.')+1); return actions[verb]?.[en.value?1:0] ?? verb }
async function loadMatrix() {
  saved.value=false;error.value='';const id=selected.value, current=++generation; matrix.value=undefined; failed.value=false
  if (!id) return
  loading.value=true
  try { const result=await platform<Matrix>(props.auth,'/applications/'+id+'/permission-matrix'); if (!disposed && current===generation) matrix.value=result }
  catch { if (!disposed && current===generation) failed.value=true }
  finally { if (!disposed && current===generation) loading.value=false }
}
async function loadApps() {
  appsFailed.value=false; loading.value=true
  try {
    const found:Application[]=[], seen=new Set<string>(); let cursor:string|null=null
    do { const page:Page<Application>=await platform<Page<Application>>(props.auth,listPath('/applications',cursor)); found.push(...page.items); cursor=page.nextCursor; if(cursor && seen.has(cursor)) throw Error('Repeated cursor'); if(cursor)seen.add(cursor) } while(cursor && !disposed)
    if(disposed)return
    apps.value=found.sort((a,b)=>a.name.localeCompare(b.name)); selected.value=apps.value.some(a=>a.id===selected.value)?selected.value:(apps.value[0]?.id ?? ''); await loadMatrix()
  } catch { if(!disposed)appsFailed.value=true }
  finally { if(!disposed)loading.value=false }
}
onMounted(loadApps); onUnmounted(()=>{disposed=true;++generation;emit('draft',false);emit('busy',false)})
</script>
<template>
  <section class="permission-config" :aria-busy="loading">
    <div class="permission-config-toolbar">
      <div class="permission-app-field"><label for="permission-app">{{ en ? 'Application' : '应用' }}</label><ElSelect id="permission-app" v-model="selected" filterable :disabled="editing || saving || loading || appsFailed || !apps.length" :placeholder="en ? 'Select an application' : '选择应用'" @change="loadMatrix"><ElOption v-for="app in apps" :key="app.id" :label="app.name" :value="app.id" /></ElSelect></div>
      <div v-if="matrix && !matrix.console && !loading" class="permission-edit-actions"><template v-if="editing"><ElButton :disabled="saving" @click="cancelEdit">{{ en ? 'Cancel' : '取消' }}</ElButton><button ref="saveButton" class="permission-save" :disabled="!dirty || saving || stale" @click="saveDialog?.showModal()">{{ en ? 'Save' : '保存' }}</button></template><ElButton v-else :disabled="!rows.length || matrix.application.status !== 'ACTIVE'" @click="startEdit">{{ en ? 'Edit configuration' : '修改配置' }}</ElButton></div>
    </div>
    <p v-if="error" role="alert" class="permission-feedback">{{ error }} <ElButton v-if="stale" @click="reloadAfterConflict">{{ en ? 'Reload' : '重新加载' }}</ElButton></p><p v-if="saved" role="status" class="permission-feedback">{{ en ? 'Configuration saved' : '配置已保存' }}</p>
    <p v-if="appsFailed || failed" role="alert">{{ en ? 'Unable to load permissions.' : '权限加载失败。' }}<ElButton @click="appsFailed ? loadApps() : loadMatrix()">{{ en ? 'Retry' : '重试' }}</ElButton></p>
    <p v-else-if="loading" role="status" class="permission-empty">{{ en ? 'Loading permissions…' : '正在加载权限…' }}</p>
    <p v-else-if="!apps.length" class="permission-empty">{{ en ? 'No applications connected yet.' : '暂无接入应用，请先在应用管理中完成接入。' }}</p>
    <template v-else-if="matrix">
      <p v-if="matrix.application.status !== 'ACTIVE'" class="permission-warning" role="status">{{ en ? 'Application disabled. Access is unavailable.' : '该应用已停用，当前不可访问。' }}</p>
      <div class="permission-matrix-scroll" role="region" :aria-label="en ? 'Permission matrix' : '权限矩阵'" tabindex="0"><table class="permission-matrix" :class="{ 'console-capability-matrix': matrix.console }"><thead><tr><th scope="col"><span class="permission-sr">{{ matrix.console ? (en ? 'Capability' : '管理能力') : (en ? 'Resource' : '资源') }}</span></th><th v-for="role in matrix.roles" :key="role.role" scope="col">{{ roleNames[role.role]?.[en?1:0] ?? role.role }}<small>{{ role.role }}</small></th></tr></thead><tbody>
        <template v-for="row in rows" :key="row.resource">
          <tr><th scope="row">{{ row.name }}<small v-if="!matrix.console">{{ row.resource }}</small></th><td v-for="role in matrix.roles" :key="role.role">
            <template v-if="matrix.console"><span class="permission-cell-value"><span class="permission-symbol" :class="{ granted:role.actions.includes(row.resource) }">{{ capabilityLabel(row.resource,role.actions.includes(row.resource)) }}</span><ElTooltip v-if="role.actions.includes(row.resource) && restriction(row.resource,role.role)" :content="restriction(row.resource,role.role)" :trigger="['hover', 'focus', 'click']" placement="top" effect="light" :show-after="120"><button type="button" class="permission-restriction" :aria-label="(en ? 'Permission limit: ' : '权限限制：') + restriction(row.resource,role.role)"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M10 9v5"/><circle cx="10" cy="6" r=".7" fill="currentColor" stroke="none"/></svg></button></ElTooltip></span></template>
            <template v-else><ElSelect v-if="editing" :model-value="permissionLevel(row.permissions,draft[role.role]??role.actions)" :disabled="saving" :aria-label="row.name+' · '+(roleNames[role.role]?.[en?1:0]??role.role)" :class="{ 'permission-cell-changed': JSON.stringify(row.permissions.filter(a=>role.actions.includes(a))) !== JSON.stringify(row.permissions.filter(a=>draft[role.role]?.includes(a))) }" @update:model-value="value=>updateCell(role.role,row.permissions,value as PermissionLevel)"><ElOption value="none" :label="levelLabel('none')"/><ElOption v-if="row.permissions.some(a=>a.endsWith('.read'))" value="read" :label="levelLabel('read')"/><ElOption v-if="row.permissions.some(a=>!a.endsWith('.read'))" value="edit" :label="levelLabel('edit')"/><ElOption v-if="permissionLevel(row.permissions,draft[role.role]??role.actions)==='custom'" disabled value="custom" :label="levelLabel('custom')"/></ElSelect><span v-else :title="role.actions.filter(a=>row.permissions.includes(a)).map(actionLabel).join('、')">{{ levelLabel(permissionLevel(row.permissions,role.actions)) }}</span></template>
          </td></tr>
        </template>
        <tr v-if="!rows.length"><td :colspan="matrix.roles.length+1" class="permission-empty">{{ en ? 'No resources configured for this application' : '该应用尚未配置资源' }}</td></tr>
      </tbody></table></div>
    </template>
    <dialog ref="saveDialog" class="permission-save-dialog" aria-labelledby="permission-save-title" @cancel.prevent="closeSave"><h2 id="permission-save-title">{{ en ? 'Save configuration?' : '保存权限配置？' }}</h2><p>{{ matrix?.application.name }} · {{ en ? 'Applies to every team in this application' : '将对该应用下所有团队生效' }}</p><ul><li v-for="change in changes" :key="change.key">{{ change.name }} · {{ change.role }}：{{ change.before }} → {{ change.after }}</li></ul><div class="permission-edit-actions"><ElButton :disabled="saving" @click="closeSave">{{ en ? 'Cancel' : '取消' }}</ElButton><ElButton type="primary" :loading="saving" @click="save">{{ en ? 'Confirm save' : '确认保存' }}</ElButton></div></dialog>
  </section>
</template>
<style scoped>
.permission-edit-actions { display:flex; gap:8px; justify-content:flex-end; }
.permission-save { border:0; border-radius:6px; background:var(--primary); color:white; padding:7px 16px; font:inherit; cursor:pointer; }
.permission-save:disabled { opacity:.45; cursor:default; }
.permission-feedback { font-size:13px; color:var(--muted); }
.permission-cell-changed :deep(.el-select__wrapper) { background:var(--accent-soft); }
.permission-save-dialog { width:min(480px,calc(100vw - 32px)); padding:24px; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--ink); max-height:80vh; overflow:auto; }
.permission-save-dialog::backdrop { background:#19191b66; }
.permission-save-dialog h2 { font-size:18px; margin-top:0; }
.permission-save-dialog p,.permission-save-dialog li { font-size:13px; line-height:1.8; }
.permission-config { padding-top:8px; }
.permission-config-toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.permission-app-field { display:flex; align-items:center; gap:12px; }
.permission-app-field label { font-size:13px; color:var(--muted); }
.permission-app-field .el-select { width:260px; --el-color-primary:var(--accent); }
.permission-matrix-scroll { margin-top:16px; overflow:auto; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
.permission-matrix-scroll:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.permission-matrix { width:100%; min-width:720px; border-collapse:collapse; font-size:13px; table-layout:fixed; background:transparent; }
.permission-matrix th,.permission-matrix td { padding:12px 16px; vertical-align:middle; border-bottom:1px solid var(--line); text-align:center; height:44px; box-sizing:border-box; }
.permission-matrix th:first-child { text-align:left; width:28%; }
.permission-matrix thead th { font-weight:500; background:transparent; height:62px; }
.permission-matrix tbody th { font-weight:400; }
.permission-matrix small { display:block; font-size:11px; font-weight:400; color:var(--muted); line-height:16px; margin-top:3px; }
.permission-matrix thead small { font-size:10px; letter-spacing:.04em; }
.permission-matrix tr:last-child td,.permission-matrix tr:last-child th { border-bottom:0; }
.permission-matrix tbody tr:hover { background:color-mix(in srgb,var(--sidebar) 40%,transparent); }
.permission-cell-value { position:relative; display:inline-flex; align-items:center; justify-content:center; }
.permission-restriction { position:absolute; left:calc(100% + 4px); top:50%; transform:translateY(-50%); display:inline-flex; align-items:center; justify-content:center; width:24px; height:28px; padding:0; border:0; border-radius:5px; background:transparent; color:var(--muted); cursor:help; }
.permission-restriction:hover { background:var(--sidebar); color:var(--ink); }
.permission-restriction:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media(pointer:coarse) { .permission-restriction { width:44px; height:44px; } }
.permission-symbol { display:inline-flex; align-items:center; justify-content:center; color:var(--muted); height:20px; }
.permission-symbol.granted { color:var(--ink); }
.permission-point { display:flex; justify-content:center; align-items:center; gap:8px; line-height:24px; color:var(--muted); }
.permission-point.granted { color:var(--ink); }
.permission-empty { padding:40px 16px!important; text-align:center; color:var(--muted); font-size:13px; }
.permission-warning { font-size:13px; color:var(--muted); }
.permission-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
@media(max-width:600px) { .permission-app-field { width:100%; }.permission-app-field .el-select { flex:1; width:auto; } }
</style>
