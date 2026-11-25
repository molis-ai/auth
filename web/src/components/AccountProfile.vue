<script setup lang="ts">
import { defineAsyncComponent, nextTick, onBeforeUnmount, ref } from 'vue';
import { AccountClient, AuthError, type AccountView } from '../lib/account-client.ts';
import { accountErrorMessage } from '../lib/errors.ts';
import '../styles/profile.css';

const AvatarCropper = defineAsyncComponent(() => import('./AvatarCropper.vue'));
const props = defineProps<{ user: NonNullable<AccountView['user']>; githubAccount?: string; client: AccountClient; onSaved: () => Promise<void> }>();
const emit = defineEmits<{ expired: [error: AuthError] }>();
const profilePicker = ref<HTMLInputElement>();
const error = ref(''), avatarSelected = ref(false), cropFile = ref<File|null>(null);
let active = true;
const nameInput = ref<HTMLInputElement>();
const editingName = ref(false), nameSaving = ref(false), inlineName = ref(''), nameError = ref('');
const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function editName() {
  if (nameSaving.value || cropFile.value) return;
  inlineName.value = props.user.displayName; nameError.value = ''; editingName.value = true;
  await nextTick(); nameInput.value?.focus(); nameInput.value?.select();
}
function cancelName() { if (!nameSaving.value) { editingName.value = false; nameError.value = ''; } }
async function saveName() {
  if (!editingName.value || nameSaving.value) return;
  const value = inlineName.value.trim();
  if (!value) { nameError.value = '请输入昵称'; return; }
  if (value === props.user.displayName) { cancelName(); return; }
  nameSaving.value = true; nameError.value = '';
  try {
    await props.client.request('/profile', {displayName:value,expectedVersion:props.user.version}, 'PATCH', crypto.randomUUID());
    if (!active) return;
    await props.onSaved();
    if (active) editingName.value = false;
  } catch (cause) {
    if (active && cause instanceof AuthError && ['SESSION_EXPIRED','SESSION_REVOKED','LOGIN_REQUIRED'].includes(cause.code)) emit('expired',cause);
    else if (active) nameError.value = accountErrorMessage(cause);
  } finally { if (active) nameSaving.value = false; }
}
function nameKey(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'Enter') { event.preventDefault(); void saveName(); }
  if (event.key === 'Escape') { event.preventDefault(); cancelName(); }
}
function pickProfileAvatar() { if (editingName.value || nameSaving.value) return; avatarSelected.value = true; profilePicker.value?.click(); }
function chooseFromProfile(event: Event) {
  const input=event.target as HTMLInputElement, file=input.files?.[0];input.value='';
  if(!file)return;
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>10*1024*1024) { error.value='请选择 10 MB 以内的 PNG、JPG 或 WebP 图片';return; }
  error.value='';cropFile.value=file;
}
async function applyCrop(image:string) {
  try {
    await props.client.request('/profile',{displayName:props.user.displayName,avatarDataUrl:image,expectedVersion:props.user.version},'PATCH',crypto.randomUUID());
    if(active)await props.onSaved();
  } catch(cause) {
    if(active && cause instanceof AuthError && ['SESSION_EXPIRED','SESSION_REVOKED','LOGIN_REQUIRED'].includes(cause.code))emit('expired',cause);
    throw cause;
  }
}
onBeforeUnmount(() => { active = false; cropFile.value=null; });
</script>
<template>
  <section class="console-card profile-page">
    <header class="profile-header">
      <h1>个人资料</h1>
      <p class="profile-subtitle">管理你的公开头像、显示昵称及 Molis 全线产品基础身份信息</p>
    </header>

    <div class="profile-card">
      <div class="profile-identity">
        <button type="button" class="profile-portrait profile-avatar-trigger" :class="{ selected: avatarSelected }" aria-label="编辑头像" @click="pickProfileAvatar" @blur="avatarSelected=false">
          <img v-if="user.avatarUrl" :src="user.avatarUrl" alt="头像">
          <span v-else>{{ user.displayName.slice(0,1) || 'M' }}</span>
          <span class="profile-avatar-pencil">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15z"/></svg>
          </span>
        </button>
        <h2 class="profile-inline-name" :class="{ 'is-editing': editingName }">
          <span v-if="!editingName" tabindex="0" role="button" aria-label="修改昵称" @click="editName" @keydown.enter.prevent="editName" @keydown.space.prevent="editName">{{ user.displayName }}</span>
          <span v-else class="profile-name-field">
            <span aria-hidden="true">{{ inlineName || '昵称' }}</span>
            <input ref="nameInput" v-model="inlineName" aria-label="修改昵称" maxlength="80" autocomplete="nickname" :readonly="nameSaving" :aria-busy="nameSaving" @blur="saveName" @keydown="nameKey">
          </span>
        </h2>
        <p v-if="nameSaving" class="profile-name-status" role="status">正在保存...</p>
        <p v-else-if="nameError" class="profile-name-status profile-name-error" role="alert">{{ nameError }}</p>
        <div class="profile-badges">
          <p v-if="user.email" class="profile-email">{{ user.email }}</p>
          <p v-if="githubAccount" class="profile-github">GitHub · {{ githubAccount }}</p>
        </div>
      </div>
    </div>

    <section class="profile-card profile-facts-card" aria-label="基础账号信息">
      <div class="profile-facts-head">
        <h3>基础账号信息</h3>
        <p>用于 Molis Work、Molis Club 等全线产品身份识别</p>
      </div>
      <dl class="profile-facts-list">
        <div class="profile-fact-row">
          <dt>账号 ID</dt>
          <dd class="profile-mono">{{ user.userId }}</dd>
        </div>
        <div v-if="user.email" class="profile-fact-row">
          <dt>主邮箱</dt>
          <dd><span>{{ user.email }}</span><span class="profile-tag">由管理员维护</span></dd>
        </div>
        <div v-if="githubAccount" class="profile-fact-row">
          <dt>GitHub 账号</dt>
          <dd>{{ githubAccount }}</dd>
        </div>
        <div class="profile-fact-row">
          <dt>当前显示时区</dt>
          <dd>{{ viewerZone }}</dd>
        </div>
      </dl>
    </section>

    <input ref="profilePicker" class="profile-direct-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择新的头像" hidden @change="chooseFromProfile">
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <AvatarCropper v-if="cropFile" :file="cropFile" :apply="applyCrop" @close="cropFile=null" />
  </section>
</template>
