<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import WorkspaceIcon from './WorkspaceIcon.vue'
const props = defineProps<{ name?: string; email?: string; avatar?: string | null; busy: boolean; language: 'en' | 'zh-CN'; collapsed?: boolean; pendingCount?: number }>()
const emit = defineEmits<{ navigate: [page: 'account' | 'security' | 'pending']; language: [value: 'en' | 'zh-CN']; logout: []; logoutAll: []; signIn: []; refreshPending: [] }>()
const pendingLabel = computed(() => props.language === 'en' ? 'Pending' : '待处理')
const menuLabel = computed(() => labels.value.menu + ((props.pendingCount ?? 0) > 0 ? ` · ${pendingLabel.value} ${props.pendingCount}` : ''))
const root = ref<HTMLDetailsElement>(), trigger = ref<HTMLElement>(), open = ref(false)
const nameText = ref<HTMLElement>(), emailText = ref<HTMLElement>()
const nameClipped = ref(false), emailClipped = ref(false)
let textObserver: ResizeObserver | undefined
function measureText() {
  nameClipped.value = !!nameText.value && nameText.value.clientWidth > 0 && nameText.value.scrollWidth > nameText.value.clientWidth
  emailClipped.value = !!emailText.value && emailText.value.clientWidth > 0 && emailText.value.scrollWidth > emailText.value.clientWidth
}
watch(() => [props.name, props.email, props.language, props.collapsed], measureText, { flush: 'post' })
onMounted(() => {
  textObserver = new ResizeObserver(measureText)
  if (nameText.value) textObserver.observe(nameText.value)
  if (emailText.value) textObserver.observe(emailText.value)
  measureText()
  void document.fonts.ready.then(() => { if (textObserver) measureText() })
})
onUnmounted(() => { textObserver?.disconnect(); textObserver = undefined })
const labels = computed(() => props.language === 'en' ? { menu: 'Account menu', profile: 'Personal profile', security: 'Account security', language: 'Language', logout: 'Sign out', all: 'Sign out everywhere', guest: 'Not signed in', signin: 'Sign in / Register' } : { menu: '账号菜单', profile: '个人资料', security: '账号安全', language: '语言', logout: '退出登录', all: '退出所有设备', guest: '尚未登录', signin: '登录 / 注册' })
const popup = ref<HTMLElement>(), languageTrigger = ref<HTMLButtonElement>(), languagePanel = ref<HTMLElement>()
const languageOpen = ref(false), languagePosition = ref({ left: '0px', top: '0px' })
let leaveTimer: ReturnType<typeof setTimeout> | undefined
function holdLanguage() { if (leaveTimer) clearTimeout(leaveTimer); leaveTimer = undefined }
function closeLanguage(focus = false) { holdLanguage(); languageOpen.value = false; if (focus) languageTrigger.value?.focus() }
function scheduleLanguageClose() { holdLanguage(); leaveTimer = setTimeout(() => { if (!languagePanel.value?.contains(document.activeElement)) closeLanguage() }, 200) }
function positionLanguage() {
  const anchor = languageTrigger.value?.getBoundingClientRect(), menu = popup.value?.getBoundingClientRect()
  if (!anchor || !menu) return
  const width = 168, height = 106, gap = 8
  const left = menu.right + gap + width <= innerWidth - gap ? menu.right + gap : menu.left - gap - width
  languagePosition.value = { left: Math.max(gap, Math.min(left, innerWidth - width - gap)) + 'px', top: Math.max(gap, Math.min(anchor.top, innerHeight - height - gap)) + 'px' }
}
async function showLanguage(focus = false) { holdLanguage(); positionLanguage(); languageOpen.value = true; if (focus) { await nextTick(); languagePanel.value?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus() } }
function languageKeys(event: KeyboardEvent) {
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const buttons = [...(languagePanel.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
    buttons[index]?.focus()
  } else if (event.key === 'ArrowLeft') { event.preventDefault(); closeLanguage(true) }
}
function toggled() { open.value = !!root.value?.open; if (!open.value) closeLanguage(); else emit('refreshPending') }
function close(focus = false) { closeLanguage(); if (root.value) root.value.open = false; if (focus) trigger.value?.focus() }
function action(run: () => void) { close(true); run() }
function outside(event: PointerEvent) { if (!root.value?.contains(event.target as Node)) close() }
function escape(event: KeyboardEvent) { if (event.key === 'Escape' && root.value?.open) { event.preventDefault(); event.stopPropagation(); if (languageOpen.value) closeLanguage(true); else close(true) } }
function resized() { closeLanguage() }
onMounted(() => { document.addEventListener('pointerdown', outside); window.addEventListener('resize', resized) })
onUnmounted(() => { holdLanguage(); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resized) })
</script>

<template>
  <details ref="root" class="user-menu" :class="{ 'user-menu-compact': collapsed }" @toggle="toggled" @keydown="escape">
    <summary ref="trigger" class="user-trigger" :aria-label="menuLabel" :aria-expanded="open">
      <span class="user-avatar" aria-hidden="true"><img v-if="avatar" :src="avatar" alt="" /><template v-else>{{ name ? Array.from(name)[0]?.toUpperCase() : '○' }}</template></span>
      <span class="user-copy"><strong ref="nameText" :title="nameClipped ? (name || labels.guest) : undefined">{{ name || labels.guest }}</strong><small ref="emailText" :title="emailClipped ? (email || labels.signin) : undefined">{{ email || labels.signin }}</small></span>
      <span class="user-chevron" aria-hidden="true">⌃</span>
      <span v-if="(pendingCount ?? 0) > 0" class="user-pending-badge user-pending-avatar-badge" aria-hidden="true">{{ pendingCount! > 99 ? '99+' : pendingCount }}</span>
    </summary>
    <div ref="popup" class="user-popup" :aria-label="labels.menu" @scroll="closeLanguage()">
      <div class="user-popup-identity"><strong>{{ name || labels.guest }}</strong><small v-if="email">{{ email }}</small></div>
      <template v-if="name">
        <button :disabled="busy" @click="action(() => emit('navigate', 'account'))"><WorkspaceIcon name="account" />{{ labels.profile }}</button>
        <button :disabled="busy" @click="action(() => emit('navigate', 'security'))"><WorkspaceIcon name="security" />{{ labels.security }}</button>
        <button :disabled="busy" @click="action(() => emit('navigate', 'pending'))"><WorkspaceIcon name="pending" />{{ pendingLabel }}<span v-if="(pendingCount ?? 0) > 0" class="user-pending-badge user-pending-count">{{ pendingCount! > 99 ? '99+' : pendingCount }}</span></button>
      </template>
      <button ref="languageTrigger" class="language-submenu-trigger" aria-haspopup="menu" :aria-expanded="languageOpen" @pointerenter="event => { if (event.pointerType === 'mouse') showLanguage() }" @pointerleave="scheduleLanguageClose" @click="languageOpen ? closeLanguage() : showLanguage(true)" @keydown.right.prevent="showLanguage(true)" @keydown.down.prevent="showLanguage(true)"><WorkspaceIcon name="language" />{{ labels.language }}<span class="language-submenu-arrow" aria-hidden="true">›</span></button>
      <hr />
      <template v-if="name">
        <button :disabled="busy" @click="action(() => emit('logout'))">{{ labels.logout }}</button>
        <button :disabled="busy" @click="action(() => emit('logoutAll'))">{{ labels.all }}</button>
      </template>
      <button v-else :disabled="busy" @click="action(() => emit('signIn'))">{{ labels.signin }}</button>
    </div>
    <div v-if="languageOpen" ref="languagePanel" class="language-submenu" role="menu" :aria-label="labels.language" :style="languagePosition" @pointerenter="holdLanguage" @pointerleave="scheduleLanguageClose" @keydown="languageKeys" @focusout="event => { if (!languagePanel?.contains(event.relatedTarget as Node)) scheduleLanguageClose() }">
      <button v-for="option in (['zh-CN', 'en'] as const)" :key="option" role="menuitemradio" :aria-checked="language === option" @click="holdLanguage(); emit('language', option)"><span>{{ option === 'zh-CN' ? '简体中文' : 'English' }}</span><span class="language-check" aria-hidden="true">{{ language === option ? '✓' : '' }}</span></button>
    </div>
  </details>
</template>

<style>
.user-menu { position: relative; width: 100%; min-width: 0; }
.user-trigger { position:relative; }
.user-pending-badge { display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box; min-width:20px; height:20px; padding:0 5px; border-radius:999px; background:#c43b3b; color:#fff; font-size:11px; line-height:20px; font-weight:600; font-variant-numeric:tabular-nums; flex-shrink:0; }
.user-pending-avatar-badge { position:absolute; top:3px; left:32px; outline:2px solid var(--sidebar); }
.user-pending-count { margin-left:auto; }
.user-trigger { list-style: none; display: flex; align-items: center; gap: 10px; min-height: 60px; padding: 8px; border-radius: 8px; cursor: pointer; }
.user-trigger::-webkit-details-marker { display: none; }
.user-trigger:hover, .user-menu[open] .user-trigger { background: #e7e7eb; }
.user-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.user-avatar { flex: 0 0 36px; height: 36px; display: grid; place-items: center; border: 1px solid #d5d5db; border-radius: 50%; background: var(--surface); color: var(--muted); font-size: 15px; }
.user-copy { min-width: 0; flex: 1; }
.user-copy strong, .user-copy small { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.user-copy strong { font-size: 13px; font-weight: 600; }
.user-copy small { font-size: 12px; color: var(--muted); }
.user-chevron { color: var(--muted); }
.user-avatar { overflow: hidden; }
.user-avatar img { width: 100%; height: 100%; object-fit: cover; }
.user-popup { position: absolute; z-index: 30; bottom: calc(100% + 8px); left: 4px; width: calc(100% - 8px); max-width: calc(100vw - 32px); max-height: min(420px, calc(100svh - 100px)); overflow-y: auto; padding: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); box-shadow: 0 4px 16px #19191b10; }
.user-popup-identity { padding: 8px 10px 12px; border-bottom: 1px solid var(--line); margin-bottom: 4px; overflow-wrap: anywhere; }
.user-popup-identity strong, .user-popup-identity small { display: block; }
.user-popup-identity strong { font-size: 14px; line-height: 20px; font-weight: 500; }
.user-popup-identity small { color: var(--muted); font-size: 12px; margin-top: 4px; }
.user-popup button { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 38px; margin-block: 2px; border: 0; border-radius: 8px; padding: 8px 10px; background: transparent; color: #36363d; text-align: left; cursor: pointer; font-size: 14px; line-height: 20px; font-weight: 400; }
.user-popup button svg { flex: 0 0 18px; width: 18px; height: 18px; stroke-width: 1.6; }
.user-popup button:not(:has(svg)) { padding-left: 38px; }
.user-popup button:hover:not(:disabled), .language-submenu button:hover:not(:disabled) { background: #e8e8ec; color: var(--ink); }
.user-popup button:disabled { cursor: not-allowed; }
.user-popup hr { border: 0; border-top: 1px solid var(--line); margin: 6px 2px; }
.user-popup .language-submenu-trigger { justify-content: flex-start; }
.language-submenu-arrow { margin-left:auto; }
.language-submenu { position: fixed; z-index: 40; width: 168px; padding: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); box-shadow: 0 8px 28px #19191b18; }
.language-submenu button { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 38px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: #36363d; cursor: pointer; font-size: 14px; line-height: 20px; font-weight: 400; }
.language-submenu button + button { margin-top: 2px; }
.language-submenu button[aria-checked="true"] { background: #e1e1e6; color: var(--ink); }
.language-check { width: 16px; text-align: center; }
.user-menu-compact .user-copy, .user-menu-compact .user-chevron { display: none; }
.user-menu-compact .user-trigger { justify-content: center; }
.user-menu-compact .user-popup { left: 0; width: 224px; }
.workspace-sidebar > nav { overflow-y: auto; min-height: 0; }
.workspace-sidebar > .user-menu { margin-top: auto; border-top: 1px solid var(--line); padding-top: 12px; }
.workspace-drawer[open] { display: flex; flex-direction: column; }
.workspace-drawer > .user-menu { margin-top: auto; padding-top: 16px; }
.sidebar-collapse-control { align-self: flex-end; }
@media (max-width: 760px), (pointer: coarse) {
  .user-popup button, .language-submenu button { min-height: 44px; }
}
</style>
