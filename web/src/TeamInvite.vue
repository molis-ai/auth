<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AuthClient } from '../../sdk/browser/src/index.ts'
import { ConsoleError, spaceApi } from './console-api'
const props = defineProps<{ auth: AuthClient; language: 'en' | 'zh-CN'; spaceId: string }>()
const emit = defineEmits<{ close: []; sent: [] }>()
type Candidate = { id: string; displayName: string; email: string; joined: boolean; invited: boolean }
const en = computed(() => props.language === 'en'), dialog = ref<HTMLDialogElement>(), query = ref(''), selected = ref('')
const results = ref<Candidate[]>([]), searching = ref(false), sending = ref(false), failed = ref(false), error = ref(''), uncertain = ref(false)
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined
watch(query, () => { selected.value = ''; results.value = []; failed.value = false; const current = ++generation; clearTimeout(timer); searching.value = query.value.trim().length >= 2; if (searching.value) timer = setTimeout(() => search(current), 350) })
async function search(current = ++generation) {
  searching.value = true; failed.value = false
  try { const value = await spaceApi<Candidate[]>(props.auth, '/spaces/' + props.spaceId + '/invite-candidates', 'POST', { query: query.value.trim() }); if (current === generation) results.value = value }
  catch { if (current === generation) failed.value = true }
  finally { if (current === generation) searching.value = false }
}
async function send() {
  if (!selected.value || sending.value || uncertain.value) return
  sending.value = true; error.value = ''
  try { await spaceApi(props.auth, '/spaces/' + props.spaceId + '/invitations', 'POST', { email: selected.value, locale: props.language }); emit('sent') }
  catch (e) { uncertain.value = e instanceof ConsoleError && e.uncertain; error.value = uncertain.value ? (en.value ? 'Check invitation records before sending again.' : '暂时无法确认结果，请关闭后检查邀请记录，避免重复发送。') : (e instanceof ConsoleError && e.code === 'INVITEE_NOT_REGISTERED' ? (en.value ? 'This account is not registered or is unavailable.' : '该账号未注册或不可用，请重新搜索。') : (en.value ? 'Invitation failed. Please try again.' : '邀请发送失败，请稍后重试。')) }
  finally { sending.value = false }
}
function close(event?: Event) { event?.preventDefault(); if (!sending.value) emit('close') }
onMounted(() => dialog.value?.showModal())
onUnmounted(() => { ++generation; clearTimeout(timer); dialog.value?.close() })
</script>
<template>
  <dialog ref="dialog" class="team-invite-dialog" aria-labelledby="invite-team-title" @cancel="close">
    <header><h2 id="invite-team-title">{{ en ? 'Invite members' : '邀请成员' }}</h2><button :disabled="sending" :aria-label="en ? 'Close' : '关闭'" @click="close">×</button></header>
    <form @submit.prevent="send">
      <label for="team-invite-search">{{ en ? 'User or email' : '站内用户或邮箱' }}</label>
      <input id="team-invite-search" v-model="query" autofocus autocomplete="off" maxlength="254" :disabled="sending || uncertain" :placeholder="en ? 'Search a name or enter an email' : '搜索名称，或输入完整邮箱'" />
      <div class="team-invite-results" aria-live="polite">
        <p v-if="searching">{{ en ? 'Searching…' : '正在搜索…' }}</p>
        <p v-else-if="failed">{{ en ? 'Search unavailable.' : '暂时无法搜索站内用户。' }} <button type="button" @click="search()">{{ en ? 'Retry' : '重试' }}</button></p>
        <p v-else-if="query.trim().length < 2">{{ en ? 'Enter at least two characters.' : '输入至少两个字，查找站内用户。' }}</p>
        <p v-else-if="!results.length">{{ en ? 'No registered users found.' : '未找到已注册用户，暂不支持站外邀请。' }}</p>
        <button v-for="user in results" :key="user.id + user.email" type="button" class="team-invite-result" :aria-pressed="selected === user.email" :disabled="user.joined || user.invited || sending || uncertain" @click="selected = user.email"><span class="team-member-initial">{{ Array.from(user.displayName)[0] }}</span><span>{{ user.displayName }}<small>{{ user.email }}</small></span><span class="team-invite-state">{{ user.joined ? (en ? 'Joined' : '已加入') : user.invited ? (en ? 'Invited' : '已邀请') : selected === user.email ? '✓' : '' }}</span></button>
      </div>
      <p class="team-invite-help">{{ en ? 'They join as a member after accepting. Roles can be changed later.' : '对方接受后以成员身份加入，之后可以调整角色。' }}</p>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <footer><button type="button" :disabled="sending" @click="close">{{ en ? 'Cancel' : '取消' }}</button><button type="submit" class="team-invite-send" :disabled="!selected || sending || uncertain">{{ sending ? (en ? 'Sending…' : '发送中…') : (en ? 'Send invitation' : '发送邀请') }}</button></footer>
    </form>
  </dialog>
</template>
<style>
.team-invite-dialog { width:min(440px,calc(100vw - 32px)); padding:24px; border:1px solid var(--line); border-radius:14px; color:var(--ink); background:var(--surface); max-height:calc(100dvh - 48px); }
.team-invite-dialog::backdrop { background:#19191b55; }
.team-invite-dialog header { display:flex; align-items:center; justify-content:space-between; margin-bottom:24px; }
.team-invite-dialog h2 { margin:0; font-size:18px; font-weight:500; }
.team-invite-dialog button { font:inherit; cursor:pointer; border:0; border-radius:7px; padding:8px 12px; background:transparent; color:var(--ink); }
.team-invite-dialog button:hover:not(:disabled) { background:var(--sidebar); }
.team-invite-dialog button:disabled { opacity:.5; cursor:default; }
.team-invite-dialog label { display:block; font-size:13px; margin-bottom:8px; }
.team-invite-dialog input { width:100%; box-sizing:border-box; font:inherit; padding:11px 12px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--ink); }
.team-invite-dialog input:focus { outline:2px solid #85858f; outline-offset:-2px; }
.team-invite-results { margin:12px 0 20px; max-height:260px; overflow:auto; min-height:54px; }
.team-invite-results p,.team-invite-help { color:var(--muted); font-size:12px; line-height:1.7; }
.team-invite-result { display:flex; width:100%; align-items:center; gap:10px; text-align:left; margin:4px 0; }
.team-invite-result[aria-pressed=true] { background:#e9edfb; }
.team-invite-result small { display:block; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.team-invite-result>span { min-width:0; overflow-wrap:anywhere; }
.team-invite-state { margin-left:auto; white-space:nowrap; font-size:12px; }
.team-invite-dialog footer { display:flex; justify-content:flex-end; gap:8px; margin-top:24px; }
.team-invite-dialog .team-invite-send { background:#202023; color:white; }
@media(max-width:760px){.team-invite-dialog button { min-height:44px; }.team-invite-dialog input { font-size:16px; }}
</style>
