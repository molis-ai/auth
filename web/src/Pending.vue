<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import { ElButton, ElPagination, ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import enLocale from 'element-plus/es/locale/lang/en'
import type { AuthClient } from '../../sdk/browser/src/index.ts'
import { spaceApi } from './console-api'
import { loadPending, type PendingInvitation } from './pending-api'
const props = defineProps<{ auth: AuthClient; language: 'en' | 'zh-CN'; active: boolean }>()
const emit = defineEmits<{ count: [value: number | undefined]; resolved: [] }>()
const items = ref<PendingInvitation[]>(), busy = ref(false), failure = ref(false), notice = ref('')
const confirmation = ref<{ item: PendingInvitation; accept: boolean }>(), dialog = ref<HTMLDialogElement>()
const en = computed(() => props.language === 'en')
const page = ref(1), pageSize = ref(10)
const total = computed(() => items.value?.length ?? 0)
const visibleItems = computed(() => items.value?.slice((page.value - 1) * pageSize.value, page.value * pageSize.value) ?? [])
watch([total, pageSize], () => { page.value = Math.min(page.value, Math.max(1, Math.ceil(total.value / pageSize.value))) })
function resizePage(size: number) { pageSize.value = size; page.value = 1 }
let disposed = false
async function read() {
  const result = await loadPending(props.auth)
  if (!disposed) { items.value = result; emit('count', result.length) }
}
async function refresh() {
  if (busy.value) return
  busy.value = true; failure.value = false
  try { await read() } catch { if (!disposed) { failure.value = true; emit('count', undefined) } }
  finally { busy.value = false }
}
async function ask(item: PendingInvitation, accept: boolean) {
  if (busy.value) return
  confirmation.value = { item, accept }; await nextTick(); dialog.value?.showModal()
}
function cancel() { if (busy.value) return; confirmation.value = undefined; dialog.value?.close() }
async function answer() {
  if (busy.value || !confirmation.value) return
  const action = confirmation.value
  busy.value = true; failure.value = false; notice.value = ''
  try {
    await spaceApi(props.auth, '/invitations/' + action.item.id + (action.accept ? '/accept' : '/decline'), 'POST', {})
    notice.value = action.accept ? (en.value ? 'Invitation accepted. The team is now available in Team management.' : '已接受邀请，可在团队管理中查看。') : (en.value ? 'Invitation declined.' : '已拒绝邀请。')
    items.value = items.value?.filter(item => item.id !== action.item.id)
    emit('count', items.value?.length); emit('resolved')
    await read()
  } catch { if (!disposed) { failure.value = true; emit('count', undefined) } }
  finally { busy.value = false; cancel() }
}
function onFocus() { if (props.active) void refresh() }
watch(() => props.active, value => { if (value) void refresh(); else cancel() })
onMounted(() => { void refresh(); window.addEventListener('focus', onFocus) })
onUnmounted(() => { disposed = true; window.removeEventListener('focus', onFocus) })
defineExpose({ refresh })
</script>
<template>
  <section class="pending-page" :aria-busy="busy">
    <p v-if="busy" role="status" class="console-muted">{{ en ? 'Processing…' : '正在处理…' }}</p>
    <div v-if="notice" class="notice success" role="status">{{ notice }}</div>
    <div v-if="failure" class="notice error" role="alert"><p>{{ en ? 'Could not confirm the latest state. Refresh before repeating an action.' : '暂时无法确认最新状态，请重新读取后再决定是否操作。' }}</p><ElButton :disabled="busy" @click="refresh">{{ en ? 'Reload' : '重新读取' }}</ElButton></div>
    <div v-if="items && !items.length && !busy && !failure" class="pending-empty"><h2>{{ en ? 'All caught up' : '暂无待处理事项' }}</h2><p>{{ en ? 'New pending items will appear here.' : '新的待办事项会显示在这里。' }}</p></div>
    <div v-if="total" class="pending-list">
      <article v-for="item in visibleItems" :key="item.id" class="pending-invitation">
        <div class="pending-team-avatar" aria-hidden="true">{{ Array.from(item.spaceName)[0] }}</div>
        <div class="pending-content"><div class="pending-title"><h2>{{ item.spaceName }}</h2><span class="pending-kind">{{ en ? 'Team invitation' : '团队邀请' }}</span></div><p>{{ item.inviterName }} {{ en ? 'invited you to join this team.' : '邀请你加入该团队。' }}</p><p class="pending-meta">{{ item.invitedEmail }} <span aria-hidden="true"> · </span>{{ en ? 'Expires' : '有效期至' }} {{ new Date(item.expiresAt).toLocaleString(language) }}</p></div>
        <div class="pending-actions"><ElButton type="primary" :disabled="busy || failure" @click="ask(item, true)">{{ en ? 'Accept' : '接受' }}</ElButton><ElButton text :disabled="busy || failure" @click="ask(item, false)">{{ en ? 'Decline' : '拒绝' }}</ElButton></div>
      </article>
    </div>
    <div v-if="total" class="pending-pagination"><span>{{ en ? 'Total ' + total : '共 ' + total + ' 条' }} · {{ (page - 1) * pageSize + 1 }}–{{ Math.min(page * pageSize, total) }}</span><ElConfigProvider :locale="en ? enLocale : zhCn"><ElPagination small v-model:current-page="page" :page-size="pageSize" :page-sizes="[10, 25, 50]" :total="total" :pager-count="5" :disabled="busy" layout="sizes, prev, pager, next, jumper" @size-change="resizePage" /></ElConfigProvider></div>
    <dialog ref="dialog" class="console-modal pending-confirm" aria-labelledby="pending-confirm-title" aria-describedby="pending-confirm-message" @cancel.prevent="cancel">
      <section v-if="confirmation" class="pending-confirm-body">
        <h2 id="pending-confirm-title">{{ confirmation.accept ? (en ? 'Accept invitation' : '接受邀请') : (en ? 'Decline invitation' : '拒绝邀请') }}</h2>
        <p id="pending-confirm-message">{{ confirmation.accept ? (en ? 'Accept the invitation to join “' + confirmation.item.spaceName + '”?' : '接受加入“' + confirmation.item.spaceName + '”的邀请？') : (en ? 'Decline the invitation from “' + confirmation.item.spaceName + '”?' : '拒绝“' + confirmation.item.spaceName + '”的邀请？') }}</p>
        <div class="pending-confirm-actions"><ElButton type="primary" :loading="busy" :disabled="busy" @click="answer">{{ en ? 'Confirm' : '确认' }}</ElButton><ElButton autofocus :disabled="busy" @click="cancel">{{ en ? 'Cancel' : '取消' }}</ElButton></div>
      </section>
    </dialog>
  </section>
</template>
<style>
.pending-confirm.console-modal { width:400px; max-width:calc(100vw - 32px); box-sizing:border-box; padding:24px; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--ink); box-shadow:0 16px 48px #0000001f; }
.pending-confirm.console-modal::backdrop { background:#00000040; }
.pending-confirm-body h2 { margin:0; font-size:18px; line-height:26px; font-weight:600; }
.pending-confirm-body p { margin:12px 0 24px; font-size:14px; line-height:22px; color:var(--muted); overflow-wrap:anywhere; }
.pending-confirm-actions { display:flex; justify-content:flex-end; gap:8px; }
.pending-confirm-actions .el-button { min-width:72px; }
.pending-confirm-actions .el-button + .el-button { margin-left:0; }
.pending-list { border-top:1px solid var(--line); }
.pending-invitation { display:flex; align-items:center; gap:12px; padding:16px 8px; border-bottom:1px solid var(--line); }
.pending-team-avatar { display:flex; align-items:center; justify-content:center; width:40px; height:40px; flex-shrink:0; border-radius:10px; background:var(--sidebar); color:var(--muted); font-size:18px; }
.pending-content { min-width:0; flex:1; overflow-wrap:anywhere; }
.pending-title { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.pending-title h2 { font-size:14px; line-height:22px; font-weight:600; margin:0; color:var(--ink); }
.pending-kind,.pending-invitation .pending-meta { font-size:12px; color:var(--muted); }
.pending-invitation p { font-size:13px; line-height:20px; margin:2px 0 0; }
.pending-actions { display:flex; gap:8px; flex-shrink:0; }
.pending-actions .el-button + .el-button { margin-left:0; }
.pending-pagination { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-top:16px; font-size:12px; color:var(--muted); }
.pending-pagination .el-pagination { flex-wrap:wrap; gap:8px; }
.pending-empty { padding:48px 24px; text-align:center; }
.pending-empty h2 { font-size:18px; font-weight:500; }
.pending-empty p { color:var(--muted); font-size:14px; }
@media(max-width:760px) { .pending-invitation { flex-wrap:wrap; align-items:flex-start; padding:16px 0; } .pending-content { flex-basis:calc(100% - 52px); } .pending-actions { width:100%; justify-content:flex-end; } .pending-actions .el-button { min-height:44px; } .pending-pagination .el-pagination { white-space:normal; } }
</style>
