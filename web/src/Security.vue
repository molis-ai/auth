<script setup lang="ts">
import StatusTag from './StatusTag.vue'
import { computed, nextTick, ref, watch } from 'vue'
import { ElButton, ElTabs, ElTabPane } from 'element-plus'
import 'element-plus/es/components/tabs/style/css'
import 'element-plus/es/components/tab-pane/style/css'
import { AuthError, type AuthClient } from '../../sdk/browser/src/index.ts'
import { spaceApi, ConsoleError, listPath, type Page } from './console-api'
import { revokeAuthentication, type AuthenticationSession, type SecurityEvent } from './security-api'
import LoginMethods from './LoginMethods.vue'
const props = defineProps<{ auth: AuthClient; language: 'en' | 'zh-CN' }>()
const emit = defineEmits<{ ended: [restorePaused: boolean] }>()
const t = computed(() => props.language === 'en' ? {
  title: 'Account security', sessions: 'Login management', events: 'Security history', first: 'Reload first page', next: 'Next page', empty: 'No records.',
  note: 'Each entry is a full-authentication session, not a verified physical device. Revocation signs out every application linked to that session, not your Google or Apple account.',
  eventNote: 'Account registration, password login/reset and session revocation events currently recorded by Auth. This is not the platform or space audit log.',
  id: 'Session ID', time: 'Authenticated', activity: 'Last interaction', expires: 'Expires', count: 'Issued application sessions (including ended)', current: 'Current',
  status: 'Status', revoke: 'Revoke', confirm: 'Confirm revocation', cancel: 'Cancel', action: 'Event', eventTime: 'Event time', outcome: 'Outcome', request: 'Request ID',
  active: 'Active', expired: 'Expired', revoked: 'Revoked', done: 'Session revoked.', failed: 'Request failed. No automatic retry was made.',
  uncertain: 'The result is uncertain. Reload the list before repeating this operation.', confirmHint: 'This invalidates all application sessions and browser restoration attached to this login session. It does not delete account data.',
  currentWarning: 'This is your current session. You will be signed out of this page too.',
} : {
  title: '账号安全', sessions: '登录管理', events: '安全记录', first: '重新读取第一页', next: '下一页', empty: '暂无记录。',
  note: '每条记录代表一次完整认证建立的登录会话，并不等于一台已确认的物理设备。撤销后，关联此会话的各应用登录态一起失效，不会退出 Google 或 Apple 账号。',
  eventNote: '展示 Auth 目前记录的注册、密码登录／重置及会话撤销事件，不包含平台或空间管理审计。',
  id: '会话 ID', time: '完整认证时间', activity: '最后用户交互', expires: '到期时间', count: '已签发的应用会话数（含已结束）', current: '当前',
  status: '状态', revoke: '撤销', confirm: '确认撤销', cancel: '取消', action: '事件', eventTime: '发生时间', outcome: '结果', request: '请求 ID',
  active: '有效', expired: '已过期', revoked: '已撤销', done: '会话已撤销。', failed: '请求失败，未自动重试。',
  uncertain: '操作结果尚不确定，请重新读取列表后再决定是否重试。', confirmHint: '这会使该登录会话关联的所有应用会话及浏览器恢复失效，不会删除账号数据。',
  currentWarning: '这是当前会话，撤销后本页面也会退出登录。',
})
const tab = ref<'connections' | 'sessions' | 'events'>('connections'), sessions = ref<Page<AuthenticationSession>>(), events = ref<Page<SecurityEvent>>()
const busy = ref(false), error = ref<{ code: string; requestId: string; uncertain: boolean }>(), notice = ref('')
const pending = ref<AuthenticationSession>(), dialog = ref<HTMLDialogElement>()
watch(pending, async value => { await nextTick(); if (value && !dialog.value?.open) dialog.value?.showModal(); else if (!value) dialog.value?.close() })
async function work(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = undefined; notice.value = ''
  try { await action() } catch (failure) {
    error.value = failure instanceof ConsoleError ? failure : failure instanceof AuthError
      ? { code: failure.code, requestId: failure.requestId, uncertain: false } : { code: 'AUTH_UNAVAILABLE', requestId: '', uncertain: false }
  } finally { busy.value = false }
}
async function load(cursor: string | null = null) {
  if (tab.value === 'sessions') { sessions.value = undefined; sessions.value = await spaceApi(props.auth, listPath('/sessions/authentications', cursor)) }
  else if (tab.value === 'events') { events.value = undefined; events.value = await spaceApi(props.auth, listPath('/sessions/security-events', cursor)) }
}
async function changeTab() { error.value = undefined; notice.value = ''; if (tab.value !== 'connections') await work(() => load()) }
async function confirm() {
  const target = pending.value; pending.value = undefined
  if (target) await work(async () => {
    const result = await revokeAuthentication(props.auth, target.id)
    if (result.current) emit('ended', result.restorePaused)
    else { await load(); notice.value = t.value.done }
  })
}
function date(value: string) { return new Date(value).toLocaleString(props.language) }
</script>

<template>
  <section class="console-card" :aria-busy="busy"><h2>{{ t.title }}</h2>
    <ElTabs v-model="tab" class="security-tabs" @tab-change="changeTab">
      <ElTabPane name="connections" :label="language === 'en' ? 'Connected accounts' : '关联账号'" :disabled="busy"><LoginMethods :auth="auth" :language="language" @ended="value => emit('ended', value)" /></ElTabPane>
      <ElTabPane name="sessions" :label="t.sessions" :disabled="busy">
    <template v-if="tab === 'sessions'"><p class="console-muted">{{ t.note }}</p>
      <div class="console-table"><table><thead><tr><th>{{ t.id }}</th><th>{{ t.time }}</th><th>{{ t.activity }}</th><th>{{ t.expires }}</th><th>{{ t.count }}</th><th>{{ t.status }}</th><th></th></tr></thead>
        <tbody><tr v-for="session in sessions?.items" :key="session.id"><td><strong v-if="session.current">{{ t.current }}</strong><code>{{ session.id }}</code></td><td>{{ date(session.authenticatedAt) }}</td><td>{{ date(session.lastUserActivityAt) }}</td><td>{{ date(session.expiresAt) }}</td><td>{{ session.applicationSessionCount }}</td><td>{{ session.status === 'ACTIVE' ? t.active : session.status === 'EXPIRED' ? t.expired : t.revoked }}</td><td><ElButton :disabled="busy || session.status === 'REVOKED'" @click="pending = session">{{ t.revoke }}</ElButton></td></tr></tbody></table></div>
      <p v-if="sessions && !sessions.items.length">{{ t.empty }}</p>
    </template>
      </ElTabPane>
      <ElTabPane name="events" :label="t.events" :disabled="busy">
    <template v-if="tab === 'events'"><p class="console-muted">{{ t.eventNote }}</p>
      <div class="console-table"><table><thead><tr><th>{{ t.eventTime }}</th><th>{{ t.action }}</th><th>{{ t.outcome }}</th><th>{{ t.id }}</th><th>{{ t.request }}</th></tr></thead><tbody><tr v-for="event in events?.items" :key="event.id"><td>{{ date(event.occurredAt) }}</td><td>{{ event.action }}</td><td><StatusTag :value="event.outcome" /></td><td>{{ event.authenticationSessionId ?? '—' }}</td><td>{{ event.requestId }}</td></tr></tbody></table></div>
      <p v-if="events && !events.items.length">{{ t.empty }}</p>
    </template>
      </ElTabPane>
    </ElTabs>
    <div v-if="error" class="notice error" role="alert"><p>{{ t.failed }}</p><code>{{ error.code }}</code><p v-if="error.uncertain">{{ t.uncertain }}</p><small v-if="error.requestId">{{ t.request }}: {{ error.requestId }}</small></div>
    <p v-if="notice" class="notice success" role="status">{{ notice }}</p>
    <p v-if="busy" class="console-muted" role="status">{{ language === 'en' ? 'Loading…' : '正在加载…' }}</p>
    <div v-if="tab !== 'connections'" class="console-actions"><ElButton :disabled="busy" @click="work(() => load())">{{ t.first }}</ElButton><ElButton :disabled="busy || !(tab === 'sessions' ? sessions?.nextCursor : events?.nextCursor)" @click="work(() => load(tab === 'sessions' ? sessions!.nextCursor : events!.nextCursor))">{{ t.next }}</ElButton></div>
    <dialog ref="dialog" class="console-modal" aria-labelledby="session-revoke-title" @cancel="pending = undefined" @close="pending = undefined"><section v-if="pending" class="console-card"><h2 id="session-revoke-title">{{ t.confirm }}</h2><p>{{ t.confirmHint }}</p><p v-if="pending.current" class="notice info">{{ t.currentWarning }}</p><code>{{ pending.id }}</code><div class="console-actions"><ElButton autofocus @click="pending = undefined">{{ t.cancel }}</ElButton><ElButton type="danger" @click="confirm">{{ t.confirm }}</ElButton></div></section></dialog>
  </section>
</template>

<style>
.security-tabs > .el-tabs__header { margin-bottom:20px; }
.security-tabs .el-tabs__item { font-size:14px; font-weight:500; }
.security-tabs .account-connections > h3 { display:none; }
.security-tabs .el-tabs__content { overflow:visible; }
</style>
