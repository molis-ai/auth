<script setup lang="ts">
import { computed, ref, watch } from 'vue'
const props = defineProps<{ items: { id: string; name: string; avatarUrl?: string | null }[]; selected?: string; busy: boolean; loading: boolean; failed: boolean; more: boolean; query: string; order: 'asc' | 'desc'; language: 'en' | 'zh-CN' }>()
const emit = defineEmits<{ select: [id: string]; create: []; search: [value: string]; sort: []; more: []; retry: []; clear: [] }>()
const list = ref<HTMLElement>()
const en = computed(() => props.language === 'en')
const sortLabel = computed(() => en.value ? `Name ${props.order === 'asc' ? 'ascending; switch to descending' : 'descending; switch to ascending'}` : `名称${props.order === 'asc' ? '升序，点击切换为降序' : '降序，点击切换为升序'}`)
watch(() => [props.query, props.order], () => { list.value?.scrollTo({ top: 0 }) })
</script>
<template>
  <nav class="team-navigation" :aria-label="en ? 'Teams' : '团队列表'">
    <div class="team-nav-toolbar">
      <input class="team-search" type="search" :value="query" maxlength="120" :aria-label="en ? 'Search teams' : '搜索团队'" :placeholder="en ? 'Search' : '搜索团队'" @input="emit('search', ($event.target as HTMLInputElement).value)" />
      <button class="team-tool" :title="sortLabel" :aria-label="sortLabel" @click="emit('sort')"><svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="order === 'asc'" d="M5 4v16m-3-3 3 3 3-3M12 6h3m-3 6h6m-6 6h9" /><path v-else d="M5 20V4m-3 3 3-3 3 3M12 6h9m-9 6h6m-6 6h3" /></svg></button>
      <button class="team-tool" :disabled="busy" :title="en ? 'Create team' : '创建团队'" :aria-label="en ? 'Create team' : '创建团队'" @click="emit('create')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
    </div>
    <div ref="list" class="team-nav-list" :class="{ 'team-nav-list-empty': !loading && !failed && !items.length }" :aria-busy="loading">
      <button v-for="team in items" :key="team.id" class="team-nav-item" :aria-current="selected === team.id ? 'page' : undefined" :disabled="busy" :title="team.name" @click="emit('select', team.id)"><span class="team-nav-avatar" aria-hidden="true"><img v-if="team.avatarUrl" :src="team.avatarUrl" alt=""/><template v-else>{{ Array.from(team.name.trim())[0]?.toUpperCase() || '○' }}</template></span><span class="team-nav-name">{{ team.name }}</span></button>
      <p v-if="loading" class="team-list-message" role="status">{{ en ? 'Loading…' : '加载中…' }}</p>
      <div v-else-if="failed" class="team-list-message" role="alert">{{ en ? 'Could not load teams.' : '团队列表加载失败。' }}<button class="team-list-link" @click="emit('retry')">{{ en ? 'Retry' : '重试' }}</button></div>
      <div v-else-if="!items.length" class="team-list-message">{{ query ? (en ? 'No matching teams' : '没有匹配的团队') : (en ? 'No teams yet' : '暂无团队') }}<button v-if="query" class="team-list-link" @click="emit('clear')">{{ en ? 'Clear search' : '清除搜索' }}</button></div>
      <button v-else-if="more" class="team-list-link" @click="emit('more')">{{ en ? 'Load more' : '加载更多' }}</button>
    </div>
  </nav>
</template>
<style>
.team-navigation { display:flex; flex-direction:column; gap:4px; min-width:0; }
.team-navigation button,.team-navigation input { font:inherit; }
.team-navigation button { cursor:pointer; color:var(--ink); }
.team-nav-toolbar { display:flex; align-items:center; gap:2px; min-width:0; }
.team-nav-toolbar .team-search { width:0; min-width:0; flex:1; height:32px; padding:4px 8px; border:1px solid var(--line); border-radius:6px; font-size:13px; background:var(--surface); color:var(--ink); }
.team-nav-toolbar .team-search:focus { border-color:#85858f; outline:none; box-shadow:none; }
.team-nav-toolbar .team-search:focus-visible { outline:2px solid #85858f; outline-offset:-2px; }
.team-navigation .team-tool { display:grid; place-items:center; position:relative; flex:0 0 26px; width:26px; height:30px; padding:4px; border:0; border-radius:6px; background:transparent; list-style:none; cursor:pointer; }
.team-tool svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.team-navigation .team-tool:hover:not(:disabled) { background:var(--sidebar); }
.team-tool:focus-visible,.team-nav-item:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.team-nav-list { max-height:calc(100svh - 168px); overflow:auto; min-height:0; scrollbar-width:thin; }
.team-navigation .team-nav-item { display:flex; align-items:center; gap:6px; width:100%; min-height:32px; padding:4px; margin-top:0; border:0; border-radius:6px; background:transparent; text-align:left; font-size:13px; transition:background-color 160ms ease; }
.team-navigation .team-nav-item[aria-current] { background:var(--accent-soft,#e9edfb); color:var(--accent); }
.team-navigation .team-nav-item:hover:not(:disabled) { background:#e8e8ec; }
.team-navigation .team-nav-item[aria-current]:hover:not(:disabled) { background:#dce3f7; }
.team-nav-avatar { display:grid; place-items:center; flex:0 0 20px; height:20px; border-radius:5px; background:var(--surface); color:var(--muted); font-size:11px; }
.team-nav-avatar { overflow:hidden; }
.team-nav-avatar img { width:20px; height:20px; object-fit:cover; }
.team-nav-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.team-nav-list-empty { display:flex; align-items:center; justify-content:center; min-height:160px; text-align:center; }
.team-list-message { color:var(--muted); font-size:12px; padding:12px 4px; line-height:1.6; }
.team-navigation .team-list-link { display:block; width:100%; background:transparent; border:0; padding:8px 4px; color:var(--accent); font-size:12px; }
@media(max-width:1000px) { .team-navigation .team-nav-item,.team-navigation .team-tool,.team-navigation .team-list-link { min-height:44px; } .team-navigation .team-tool { width:44px; flex-basis:44px; } .team-nav-toolbar .team-search { height:44px; } }
</style>
