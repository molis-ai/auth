<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { AccountClient } from '../lib/account-client.ts';
import type { AuthCompletion } from '../lib/auth-flow.ts';
import AuthenticationPanel from './AuthenticationPanel.vue';
import { accountErrorMessage } from '../lib/errors.ts';
import { entryText } from '../lib/entry-copy.ts';
import { entryLanguage, saveEntryLanguage } from '../lib/entry-preferences.ts';
import logo from '../assets/molis-logo.png';
defineProps<{ client: AccountClient; busy: boolean }>();
const emit = defineEmits<{ complete: [value: AuthCompletion]; authenticating: [value: boolean] }>();
const language = ref(entryLanguage()), mode = ref('LOGIN'), resetHandle = ref('');
const productsMenu = ref<HTMLDetailsElement | null>(null);
const products: ReadonlyArray<{ name: string; description: string; href?: string }> = [
  { name: 'Molis Work', description: '一张可以按需组合工具、让人与 AI 共同工作的工作台。', href: 'https://molis.ai/work' },
  { name: 'Molis Tool', description: '围绕当前文字、文件或网页出现的随手工具。', href: 'https://molis.ai/tool' },
  { name: 'Molis Life', description: '围绕个人心愿与琐事的生活助理。' },
  { name: 'Molis Story', description: '把阅读、对话、探索和创作做成可以进入的世界。' },
  { name: 'Molis World', description: '一个可以亲自搭建、布置和持续改变的个人世界。' },
];

function closeOutside(event: Event) {
  const menu = productsMenu.value;
  if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
}
function closeOnEscape(event: KeyboardEvent) {
  const menu = productsMenu.value;
  if (event.key !== 'Escape' || !menu?.open) return;
  menu.open = false;
  menu.querySelector('summary')?.focus();
}
onMounted(() => {
  document.addEventListener('pointerdown', closeOutside);
  document.addEventListener('focusin', closeOutside);
  document.addEventListener('keydown', closeOnEscape);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeOutside);
  document.removeEventListener('focusin', closeOutside);
  document.removeEventListener('keydown', closeOnEscape);
});
const panelBusy = ref(false);
const password = ref(''), confirmation = ref(''), saving = ref(false), notice = ref('');
watch(() => panelBusy.value || saving.value, value => emit('authenticating', value));
onBeforeUnmount(() => emit('authenticating', false));
const t = (text: string) => entryText(language.value, text);
document.documentElement.lang = language.value;
function toggleLanguage() { language.value = language.value === 'en' ? 'zh-CN' : 'en'; saveEntryLanguage(language.value); }
function changeMode(value: string) { panelBusy.value = false; mode.value = value; resetHandle.value = ''; password.value = ''; confirmation.value = ''; notice.value = ''; }
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
  <div class="shell auth-entry">
    <header class="topbar">
      <a class="wordmark" href="https://molis.ai" target="_blank" rel="noopener noreferrer" :aria-label="t('Molis AI 官网')">
        <img class="brand-logo" :src="logo" alt="" width="30" height="30"><span lang="en">Molis AI</span>
      </a>
      <nav class="topbar-nav" :aria-label="t('主导航')">
        <details ref="productsMenu" class="entry-products">
          <summary class="topbar-action">
            {{ t('产品') }}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </summary>
          <ul class="product-list">
            <li v-for="(product, index) in products" :key="product.name">
              <component :is="product.href ? 'a' : 'div'" class="product-row" :class="{ 'is-soon': !product.href }"
                v-bind="product.href ? { href: product.href, target: '_blank', rel: 'noopener noreferrer' } : {}">
                <span class="product-number" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
                <span class="product-name" lang="en">{{ product.name }}</span>
                <span class="product-meta">{{ t(product.description) }} <span class="product-status">{{ t(product.href ? '开发中' : '探索中，敬请期待') }}</span></span>
              </component>
            </li>
          </ul>
        </details>
        <button class="topbar-action" type="button" @click="toggleLanguage">{{ language === 'en' ? '简体中文' : 'English' }}</button>
      </nav>
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
