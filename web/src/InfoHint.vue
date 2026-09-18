<script setup lang="ts">
import { ref, useId } from 'vue'
defineProps<{ text: string; label: string }>()
const open = ref(false), id = useId()
</script>
<template>
  <span class="info-hint" @mouseenter="open = true" @mouseleave="open = false" @keydown.esc.stop.prevent="open = false">
    <button type="button" class="info-hint-trigger" :aria-label="label" :aria-describedby="id" :aria-expanded="open" @focus="open = true" @blur="open = false" @click="open = true"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.3"/><path d="M10 9v5"/><circle class="info-dot" cx="10" cy="6.2" r=".8"/></svg></button>
    <span v-show="open" :id="id" role="tooltip" class="info-hint-content">{{ text }}</span>
  </span>
</template>
<style>
.info-hint { display:inline-flex; position:relative; vertical-align:middle; }
.team-create-page .info-hint-trigger { display:grid; place-items:center; width:24px; height:24px; min-height:24px; padding:3px; border:0; background:transparent; color:var(--muted); border-radius:5px; }
.info-hint-trigger svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.3; stroke-linecap:round; }
.info-hint-trigger .info-dot { fill:currentColor; stroke:none; }
.info-hint-content { position:absolute; top:calc(100% + 6px); left:0; z-index:10; width:200px; padding:10px 12px; border:1px solid var(--line); border-radius:9px; background:var(--surface); color:var(--muted); box-shadow:0 4px 18px #19191b12; font-size:12px; font-weight:400; line-height:1.6; text-align:left; }
@media(max-width:760px) { .team-create-page .info-hint-trigger { width:44px; height:44px; min-height:44px; } .info-hint-content { left:50%; right:auto; transform:translateX(-50%); width:180px; } }
</style>
