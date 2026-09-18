<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ value: string; label?: string }>()
const tone = computed(() => ['ACTIVE', 'SUCCESS', 'SENT', 'ACCEPTED'].includes(props.value) ? 'success' : ['FAILED', 'DENIED', 'DISABLED', 'REVOKED'].includes(props.value) ? 'error' : ['PENDING', 'SENDING'].includes(props.value) ? 'warning' : 'neutral')
</script>
<template><span class="status-tag" :data-tone="tone">{{ label ?? value }}</span></template>
