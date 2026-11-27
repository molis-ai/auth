<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import type { AccountClient } from '../../shared/api/account-client.ts';
import type { AuthCompletion } from './auth-flow.ts';
import AuthenticationPanel from './AuthenticationPanel.vue';
import { accountErrorMessage } from '../../shared/api/errors.ts';
import { entryText } from './entry-copy.ts';
const props = defineProps<{
  client: AccountClient;
  busy: boolean;
  language: string;
  prefetchedCapabilities?: ReturnType<AccountClient['loginCapabilities']>;
}>();
const emit = defineEmits<{ complete: [value: AuthCompletion]; authenticating: [value: boolean] }>();
const mode = ref('LOGIN'), resetHandle = ref('');
const panelBusy = ref(false);
const password = ref(''), confirmation = ref(''), saving = ref(false), notice = ref('');
watch(() => panelBusy.value || saving.value, value => emit('authenticating', value));
onBeforeUnmount(() => emit('authenticating', false));
const t = (text: string) => entryText(props.language, text);
let firstCapabilities = props.prefetchedCapabilities;
function changeMode(value: string) {
  if (mode.value !== value) firstCapabilities = undefined;
  panelBusy.value = false;
  mode.value = value;
  resetHandle.value = '';
  password.value = '';
  confirmation.value = '';
  notice.value = '';
}
function completed(value: AuthCompletion) {
  panelBusy.value = false;
  if (mode.value === 'PASSWORD_RESET' && !value.account) resetHandle.value = value.handle;
  else emit('complete', value);
}
async function resetPassword(client: AccountClient) {
  if (saving.value) return;
  saving.value = true; notice.value = '';
  try {
    if (password.value !== confirmation.value) throw Error('两次密码不一致');
    await client.request('/password/reset', {resetHandle: resetHandle.value, newPassword: password.value});
    changeMode('LOGIN'); notice.value = '密码已重设，请登录';
  } catch (error) { notice.value = accountErrorMessage(error); }
  finally { saving.value = false; }
}
</script>
<template>
  <section class="panel login-panel" :class="{ 'recovery-panel': mode === 'PASSWORD_RESET' }" :aria-label="t(mode === 'LOGIN' ? '登录' : mode === 'EMAIL_SIGNUP' ? '邮箱注册' : '找回密码')">
    <p v-if="notice" class="notice info" role="status">{{ t(notice) }}</p>
    <AuthenticationPanel
      v-if="!resetHandle"
      :key="mode"
      :client="client"
      :purpose="mode"
      :entry="true"
      :language="language"
      :blocked="busy"
      :prefetched-capabilities="firstCapabilities"
      @busy="panelBusy = $event"
      @complete="completed"
      @cancel="changeMode('LOGIN')"
    >
      <template #recovery><nav class="entry-footer" :aria-label="t('找回密码')"><button class="text-button" type="button" :disabled="busy || panelBusy" @click="changeMode('PASSWORD_RESET')">{{ t('找回密码') }}</button></nav></template>
    </AuthenticationPanel>
    <form v-else class="entry-content reset-form" @submit.prevent="resetPassword(client)">
      <div class="panel-heading"><h2>{{ t('重设密码') }}</h2></div>
      <label class="field">{{ t('新密码') }}<input v-model="password" type="password" autocomplete="new-password" required :disabled="saving"></label>
      <label class="field">{{ t('确认新密码') }}<input v-model="confirmation" type="password" autocomplete="new-password" required :disabled="saving"></label>
      <button class="entry-primary" :disabled="saving">{{ t(saving ? '正在处理…' : '重设密码') }}</button>
    </form>
    <nav v-if="mode !== 'LOGIN'" class="entry-footer" :aria-label="t('登录方式')">
      <button class="text-button" type="button" :disabled="busy || saving" @click="changeMode('LOGIN')">{{ t('返回登录') }}</button>
    </nav>
  </section>
</template>
