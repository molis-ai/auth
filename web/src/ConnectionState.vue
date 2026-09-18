<script setup lang="ts">
import { computed } from 'vue'
import { ElTooltip } from 'element-plus'
import 'element-plus/es/components/tooltip/style/css'
const props = defineProps<{ connected?: boolean; failed: boolean; language: 'en' | 'zh-CN' }>()
const state = computed(() => props.failed ? 'failed' : props.connected === undefined ? 'loading' : props.connected ? 'connected' : 'disconnected')
const label = computed(() => (props.language === 'en'
  ? { failed: 'Could not read connection status', loading: 'Loading connection status', connected: 'Connected', disconnected: 'Not connected' }
  : { failed: '关联状态读取失败', loading: '正在读取关联状态', connected: '已关联', disconnected: '未关联' })[state.value])
</script>
<template>
  <ElTooltip :content="label" placement="top" :show-after="150">
    <span class="connection-status-icon" :class="'is-' + state" role="img" :aria-label="label" tabindex="0">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <template v-if="state === 'connected'"><circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="m8 12 2.5 2.5 5.5-5.5" stroke="white"/></template>
        <template v-else-if="state === 'failed'"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/></template>
        <path v-else-if="state === 'loading'" d="M21 12a9 9 0 1 1-9-9"/>
        <circle v-else cx="12" cy="12" r="9"/>
      </svg>
    </span>
  </ElTooltip>
</template>
<style>
.connection-status-icon { display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; flex-shrink:0; color:var(--muted); border-radius:6px; }
.connection-status-icon svg { width:22px; height:22px; }
.connection-status-icon.is-connected { color:#28805b; }
.connection-status-icon.is-failed { color:#b34a3c; }
.connection-status-icon:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.connection-status-icon.is-loading svg { animation:connection-status-spin 1s linear infinite; }
@keyframes connection-status-spin { to { transform:rotate(360deg); } }
@media(prefers-reduced-motion:reduce) { .connection-status-icon.is-loading svg { animation:none; } }
</style>
