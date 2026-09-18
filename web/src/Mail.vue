<script setup lang="ts">
import StatusTag from './StatusTag.vue'
import { computed, onMounted, ref } from 'vue'
import type { AuthClient } from '../../sdk/browser/src/index.ts'
import { platform, listPath, ConsoleError, type Page } from './console-api'
import { canResendMail, type MailDelivery } from './mail-policy'
const props = defineProps<{ auth: AuthClient; language: 'en' | 'zh-CN' }>()
const en = computed(() => props.language === 'en'), rows = ref<Page<MailDelivery>>(), busy = ref(false)
const error = ref(''), notice = ref(''), selected = ref<MailDelivery>()
async function work(task: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await task() } catch (failure) {
    error.value = failure instanceof ConsoleError ? failure.code + ' ' + failure.requestId : 'AUTH_UNAVAILABLE'
    selected.value = undefined
  } finally { busy.value = false }
}
async function load(cursor: string | null = null) { rows.value = await platform(props.auth, listPath('/mail', cursor)) }
async function resend() {
  const target = selected.value; selected.value = undefined
  if (!target || !canResendMail(target)) return
  await work(async () => {
    await platform(props.auth, '/mail/' + target.id + '/resend', 'POST', {})
    await load()
    notice.value = en.value ? 'Retry queued. This does not confirm delivery.' : '重发任务已入队，不代表邮件已送达。'
  })
}
onMounted(() => work(() => load()))
</script>
<template>
  <section class="console-card">
    <h2>{{ en ? 'Mail delivery' : '邮件投递' }}</h2>
    <p>{{ en ? 'Failed notifications allow one manual retry batch. Verification emails require a new verification request.' : '失败通知允许一次人工重发批次。验证邮件须由用户重新发起验证，不能复用旧证明。' }}</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="selected" class="notice info">
      <p>{{ en ? 'Queue a retry for this recipient?' : '确认向以下收件人重发通知？' }} {{ selected.recipientEmail }}</p>
      <button :disabled="busy" @click="resend">{{ en ? 'Confirm' : '确认' }}</button>
      <button :disabled="busy" @click="selected = undefined">{{ en ? 'Cancel' : '取消' }}</button>
    </div>
    <div class="console-table"><table><thead><tr><th>{{ en ? 'Recipient' : '收件人' }}</th><th>{{ en ? 'Template' : '模板' }}</th><th>{{ en ? 'Status / attempts' : '状态 / 尝试次数' }}</th><th>{{ en ? 'Error' : '错误' }}</th><th></th></tr></thead>
      <tbody><tr v-for="row in rows?.items" :key="row.id"><td>{{ row.recipientEmail }}</td><td>{{ row.templateKey }}</td><td><StatusTag :value="row.status" /> / {{ row.attempts }}</td><td>{{ row.lastErrorCode ?? '—' }}</td><td><button :disabled="busy || !canResendMail(row)" @click="selected = row">{{ en ? 'Resend' : '重发' }}</button></td></tr></tbody>
    </table></div>
    <button :disabled="busy" @click="work(() => load())">{{ en ? 'First page / refresh' : '首页 / 刷新' }}</button>
    <button :disabled="busy || !rows?.nextCursor" @click="work(() => load(rows!.nextCursor))">{{ en ? 'Next page' : '下一页' }}</button>
  </section>
</template>
