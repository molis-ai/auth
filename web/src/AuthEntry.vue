<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { AccountClient } from '../../sdk/browser/src/index.ts';
import AuthenticationPanel from './AuthenticationPanel.vue';
import { accountErrorMessage } from './errors.ts';
import { entryText } from './entry-copy.ts';
import { entryLanguage, saveEntryLanguage } from './entry-preferences.ts';
import logo from './assets/molis-logo.png';
defineProps<{ client: AccountClient; busy: boolean }>();
const emit = defineEmits<{ complete: []; authenticating: [value: boolean] }>();
const language = ref(entryLanguage()), mode = ref('LOGIN'), resetHandle = ref('');
const panelBusy = ref(false);
const password = ref(''), confirmation = ref(''), saving = ref(false), notice = ref('');
watch(() => panelBusy.value || saving.value, value => emit('authenticating', value));
onBeforeUnmount(() => emit('authenticating', false));
const t = (text: string) => entryText(language.value, text);
document.documentElement.lang = language.value;
function toggleLanguage() { language.value = language.value === 'en' ? 'zh-CN' : 'en'; saveEntryLanguage(language.value); }
function changeMode(value: string) { panelBusy.value = false; mode.value = value; resetHandle.value = ''; password.value = ''; confirmation.value = ''; notice.value = ''; }
function completed(value: { handle: string; account?: unknown }) {
  panelBusy.value = false;
  if (mode.value === 'PASSWORD_RESET' && !value.account) resetHandle.value = value.handle;
  else emit('complete');
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
  <div class="shell auth-entry">
    <header class="topbar">
      <a class="wordmark" href="/" aria-label="molis AI"><img class="brand-logo" :src="logo" alt="" width="32" height="32"><span class="brand-name">molis<span class="brand-ai">AI</span></span></a>
      <button class="language" type="button" @click="toggleLanguage">{{ language === 'en' ? '简体中文' : 'English' }}</button>
    </header>
    <main class="layout">
      <section class="story"><div class="brand-note"><h1>{{ t('一个账号，\n连接你的工作') }}</h1><p class="intro">{{ t('登录 Molis 账号，管理个人资料、租户与订阅。') }}</p></div></section>
      <section class="panel login-panel" :class="{ 'recovery-panel': mode === 'PASSWORD_RESET' }" :aria-label="t(mode === 'LOGIN' ? '登录' : mode === 'EMAIL_SIGNUP' ? '邮箱注册' : '找回密码')">
        <p v-if="notice" class="notice info" role="status">{{ t(notice) }}</p>
        <AuthenticationPanel v-if="!resetHandle" :key="mode" :client="client" :purpose="mode" :entry="true" :language="language" :blocked="busy" @busy="panelBusy = $event" @complete="completed" @cancel="changeMode('LOGIN')">
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
    </main>
  </div>
</template>
