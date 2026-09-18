<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, ApiError, secretPattern, type Context, type AuthProvider } from './protocol'
import { saveProviderAttempt } from './provider'
import { ProviderMailboxFlow } from './provider-mailbox'
const props = defineProps<{ transaction: string; continuation: string; language: 'en' | 'zh-CN'; providers: AuthProvider[] }>()
const en = computed(() => props.language === 'en'), busy = ref(true), sent = ref(false), terminal = ref(false), failure = ref('')
const email = ref(''), context = ref<Context>(), provider = ref(''), expires = ref('')
const linking = ref(false), password = ref('')
let flow: ProviderMailboxFlow | undefined
async function work(action: () => Promise<void>) {
  busy.value = true; failure.value = ''
  try { await action() } catch (error) { failure.value = error instanceof ApiError ? error.code : 'AUTH_UNAVAILABLE' }
  finally { terminal.value = flow?.terminal ?? true; busy.value = false }
}
async function loadContext() {
  if(!flow) throw new ApiError('INVALID_TRANSACTION')
  const result = await flow.context(); context.value = result.context; provider.value = result.provider; expires.value = result.expiresAt
  linking.value = result.mode === 'LINK_PASSWORD'; if (linking.value) email.value = result.email
}
onMounted(() => work(async () => {
  flow = new ProviderMailboxFlow(props.transaction, props.continuation, location.origin)
  await loadContext()
}))
function submit() { if (busy.value || !flow || !context.value) return; return work(async () => {
  if (linking.value) { try { location.replace(await flow!.linkPassword(password.value)) } finally { password.value = '' } }
  else if (!sent.value) { await flow!.request(email.value, props.language); sent.value = true }
  else { const url = await flow!.complete(props.language); if(url) location.replace(url); else { sent.value = false; await loadContext() } }
}) }
function reauthenticate(selected: AuthProvider) { if(busy.value || !context.value || !flow || !props.providers.includes(selected)) return
  password.value = ''
  return work(async () => { saveProviderAttempt(sessionStorage, context.value!, selected); location.replace(await flow!.reauthenticate(selected)) })
}
async function restart() { if (busy.value || !context.value) return; await work(async () => {
  const c = context.value!
  const result = await api<{ transaction: string }>('/transactions', undefined, { clientId: c.clientId, redirectUri: c.redirectUri, codeChallenge: c.challenge,
    codeChallengeMethod: 'S256', state: c.state, scopes: c.scopes, forceLogin: true })
  if (!secretPattern.test(result.transaction)) throw new ApiError('INVALID_RESPONSE')
  location.replace(location.origin + '/login#transaction=' + result.transaction)
}) }
</script>
<template>
  <section :aria-busy="busy">
    <p v-if="linking">{{ en ? 'This verified mailbox already has an account. Verify its existing password or an already linked provider to confirm linking. No new account or space will be created.' : '此已验证邮箱已有账号。请验证原密码或已绑定的第三方身份，确认关联；不会另建账号或空间。' }}</p>
    <p v-else>{{ en ? 'Your provider identity is verified. Verify a mailbox to finish creating your account. No new password is needed.' : '第三方身份已验证，请验证一个邮箱以完成账号创建，无需另外设置密码。' }}</p>
    <p v-if="context">{{ provider }} · {{ context.clientId }}</p>
    <p v-if="expires">{{ en ? 'Complete before:' : '请在此时间前完成：' }} {{ new Date(expires).toLocaleString() }}</p>
    <p v-if="linking">{{ en ? 'Submitting or choosing a provider confirms the link after successful verification. Choose the provider identity already attached to this account. Cancelling the later login confirmation will not undo the link.' : '提交密码或选择提供方表示：验证成功后确认关联。请选择已绑定在原账号上的身份。之后取消登录确认不会撤销关联。' }}</p>
    <p v-else>{{ en ? 'Verifying a mailbox will not merge existing accounts. Opening the email link does not sign you in; return here and confirm.' : '验证邮箱不会合并已有账号。打开邮件链接不会自动登录；确认邮件后请回到本页继续。' }}</p>
    <p v-if="failure" role="alert">{{ failure }} · {{ en ? 'No automatic retry. If expired or uncertain, restart sign-in.' : '未自动重试；过期或结果不确定时，请重新登录。' }}</p>
    <p v-if="failure === 'ACCOUNT_LINK_REQUIRED'">{{ en ? 'This mailbox already belongs to an account. Sign in with its existing method, then bind your provider from account security.' : '此邮箱已有账号，请先使用该账号原有方式登录，再到账号安全页绑定第三方身份。' }}</p>
    <form v-if="!terminal && context" @submit.prevent="submit">
      <label class="field">{{ en ? 'Email' : '邮箱' }}<input v-model="email" type="email" autocomplete="username" required maxlength="254" :disabled="busy || sent || linking" /></label>
      <label v-if="linking" class="field">{{ en ? 'Existing password' : '原账号密码' }}<input v-model="password" type="password" autocomplete="current-password" required maxlength="512" :disabled="busy" /></label>
      <p v-if="sent" role="status">{{ en ? 'Check your email, explicitly confirm the link, then return here.' : '请查收邮件，打开链接并明确确认，然后返回本页。' }}</p>
      <button type="submit" :disabled="busy">{{ linking ? (en ? 'Verify password and confirm link' : '验证原密码并确认关联') : sent ? (en ? 'Confirm and create account' : '确认并创建账号') : (en ? 'Send verification email' : '发送验证邮件') }}</button>
      <button type="button" :disabled="busy" @click="work(() => flow!.cancel())">{{ en ? 'Cancel' : '取消' }}</button>
      <button v-for="choice in (linking ? providers : [])" :key="choice" type="button" :disabled="busy" @click="reauthenticate(choice)">{{ en ? 'Confirm using existing' : '使用原有身份验证并确认：' }} {{ choice }}</button>
    </form>
    <button v-if="terminal && context" :disabled="busy" @click="restart">{{ en ? 'Restart sign-in' : '重新开始登录' }}</button>
  </section>
</template>
