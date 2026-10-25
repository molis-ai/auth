<script setup lang="ts">
import { computed } from 'vue'
import { authFeedback } from './auth-feedback'
import { copy } from './copy'
import type { ApiError } from './protocol'
const props = defineProps<{ error: ApiError; language: 'zh-CN' | 'en'; mode?: string; messageId?: string }>()
const feedback = computed(() => authFeedback(props.error, props.language, props.mode))
const t = computed(() => copy[props.language])
</script>

<template>
  <div class="notice auth-feedback" :class="feedback.neutral ? 'info' : 'error'" :role="feedback.neutral ? 'status' : 'alert'">
    <p :id="messageId">{{ feedback.message }}</p>
    <p v-if="feedback.retryHint" class="retry-hint">{{ feedback.retryHint }}</p>
    <details v-if="feedback.requestId" :key="feedback.requestId" class="error-details">
      <summary>{{ t.errorDetails }}</summary>
      <small>{{ t.request }}: {{ feedback.requestId }}</small>
      <small>{{ t.errorCode }}: {{ feedback.code }}</small>
      <small>{{ t.errorSupport }}</small>
    </details>
  </div>
</template>

<style scoped>
.auth-feedback { text-align: left; }
.auth-feedback .retry-hint { margin-top: 6px; }
.error-details { margin-top: 8px; }
.error-details summary { cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.error-details summary:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
</style>
