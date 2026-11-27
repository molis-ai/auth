<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { entryText } from './entry-copy.ts';
import { entryLanguage, saveEntryLanguage } from './entry-preferences.ts';
import logo from '../../assets/molis-logo.png';

defineProps<{ showChrome: boolean }>();
const language = ref(entryLanguage());
const t = (text: string) => entryText(language.value, text);
document.documentElement.lang = language.value;

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

function toggleLanguage() {
  language.value = language.value === 'en' ? 'zh-CN' : 'en';
  saveEntryLanguage(language.value);
}
</script>

<template>
  <div v-if="showChrome" class="shell auth-entry">
    <header class="topbar" data-local-hover>
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
      <section class="story"><div class="brand-note"><div class="story-rule" aria-hidden="true"></div><h1>{{ t('一个账号，\n连接你的工作') }}</h1><p class="intro">{{ t('登录 Molis 账号，管理个人资料、团队与订阅。') }}</p></div></section>
      <slot :language="language" :t="t" />
    </main>
  </div>
  <slot v-else :language="language" :t="t" />
</template>
