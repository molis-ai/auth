<script setup lang="ts">
import { ref } from 'vue';
import { entryText } from '../lib/entry-copy.ts';
import { entryLanguage, saveEntryLanguage } from '../lib/entry-preferences.ts';
import logo from '../assets/molis-logo.png';

defineProps<{ showChrome: boolean }>();
const language = ref(entryLanguage());
const t = (text: string) => entryText(language.value, text);
document.documentElement.lang = language.value;

function toggleLanguage() {
  language.value = language.value === 'en' ? 'zh-CN' : 'en';
  saveEntryLanguage(language.value);
}
</script>

<template>
  <div v-if="showChrome" class="shell auth-entry">
    <header class="topbar">
      <a class="wordmark" href="/" aria-label="molis AI"><img class="brand-logo" :src="logo" alt="" width="32" height="32"><span class="brand-name">molis<span class="brand-ai">AI</span></span></a>
      <button class="language" type="button" @click="toggleLanguage">{{ language === 'en' ? '简体中文' : 'English' }}</button>
    </header>
    <main class="layout">
      <section class="story"><div class="brand-note"><h1>{{ t('一个账号，\n连接你的工作') }}</h1><p class="intro">{{ t('登录 Molis 账号，管理个人资料、租户与订阅。') }}</p></div></section>
      <slot :language="language" :t="t" />
    </main>
  </div>
  <slot v-else :language="language" :t="t" />
</template>
