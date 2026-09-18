<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import type { AuthClient, CurrentUser } from '../../sdk/browser/src/index.ts'
import { spaceApi } from './console-api'
const props = defineProps<{ user: CurrentUser; auth: AuthClient; language: 'en' | 'zh-CN' }>()
const emit = defineEmits<{ saved: [user: CurrentUser]; draft: [value: boolean] }>()
const dialog = ref<HTMLDialogElement>(), editButton = ref<HTMLButtonElement>(), fileInput = ref<HTMLInputElement>()
const name = ref(''), avatar = ref<string | null>(null), saving = ref(false), processing = ref(false), error = ref(''), success = ref(false), discard = ref(false)
const en = computed(() => props.language === 'en')
const initial = (value: string) => Array.from(value.trim())[0]?.toUpperCase() || '○'
const changed = computed(() => name.value !== props.user.displayName || avatar.value !== (props.user.avatarUrl ?? null))
function draft() { emit('draft', changed.value) }
function edit() { name.value = props.user.displayName; avatar.value = props.user.avatarUrl ?? null; error.value = ''; success.value = false; discard.value = false; dialog.value?.showModal() }
function close(force = false) { if (saving.value || processing.value) return; if (!force && changed.value) { discard.value = true; return }; dialog.value?.close(); emit('draft', false); editButton.value?.focus() }
async function choose(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''; if (!file) return
  error.value = ''; processing.value = true
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw Error()
    const data = await new Promise<string>((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file) })
    const image = new Image(); image.src = data; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128
    const context = canvas.getContext('2d'); if (!context) throw Error()
    const size = Math.min(image.naturalWidth, image.naturalHeight)
    context.drawImage(image, (image.naturalWidth-size)/2, (image.naturalHeight-size)/2, size, size, 0, 0, 128, 128)
    avatar.value = canvas.toDataURL('image/png'); draft()
  } catch { error.value = en.value ? 'Choose a PNG, JPG or WebP image under 5 MB.' : '请选择不超过 5 MB 的 PNG、JPG 或 WebP 图片。' }
  finally { processing.value = false }
}
async function save() {
  if (saving.value || processing.value || !name.value.trim() || !changed.value) return
  saving.value = true; error.value = ''
  try {
    const user = await spaceApi<CurrentUser>(props.auth, '/users/me/profile', 'POST', { displayName: name.value.trim(), avatarUrl: avatar.value })
    emit('saved', user); emit('draft', false); saving.value = false; close(true); success.value = true
  } catch { error.value = en.value ? 'Could not confirm the save. Your edits are still here; please try again.' : '暂时无法确认保存结果，已保留你的修改，请重试。' }
  finally { saving.value = false }
}
onBeforeUnmount(() => emit('draft', false))
</script>

<template>
  <section class="profile-page">
    <header class="profile-heading"><h1>{{ en ? 'Personal profile' : '个人资料' }}</h1><button ref="editButton" class="profile-edit" @click="edit"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 4 4 4M4 20l5-1L20 8a2.83 2.83 0 0 0-4-4L5 15z" /></svg>{{ en ? 'Edit profile' : '编辑资料' }}</button></header>
    <div class="profile-identity"><div class="profile-avatar"><img v-if="user.avatarUrl" :src="user.avatarUrl" :alt="en ? 'Profile photo' : '头像'" /><span v-else aria-hidden="true">{{ initial(user.displayName) }}</span></div><h2>{{ user.displayName }}</h2><p v-for="email in user.emails" :key="email">{{ email }}</p><p v-if="!user.emails.length">{{ en ? 'No email linked' : '未绑定邮箱' }}</p><p v-if="success" class="profile-success" role="status">{{ en ? 'Profile saved' : '个人资料已保存' }}</p></div>
    <dialog ref="dialog" class="profile-dialog" aria-labelledby="profile-edit-title" @cancel.prevent="close()">
      <form @submit.prevent="save">
        <h2 id="profile-edit-title">{{ en ? 'Edit profile' : '编辑个人资料' }}</h2>
        <fieldset :disabled="saving || processing">
          <div class="profile-photo-editor"><div class="profile-avatar"><img v-if="avatar" :src="avatar" :alt="en ? 'Profile photo preview' : '头像预览'" /><span v-else aria-hidden="true">{{ initial(name) }}</span></div><button type="button" class="profile-camera" :aria-label="en ? 'Change profile photo' : '更换头像'" @click="fileInput?.click()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/></svg></button></div>
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="choose" />
          <p class="profile-photo-help">{{ en ? 'PNG, JPG or WebP · up to 5 MB · center-cropped' : 'PNG、JPG 或 WebP · 不超过 5 MB · 居中裁切' }}</p>
          <button v-if="avatar" type="button" class="profile-remove" @click="avatar = null; draft()">{{ en ? 'Use default photo' : '恢复默认头像' }}</button>
          <label class="profile-field"><span>{{ en ? 'Display name' : '显示名称' }}</span><input v-model="name" autofocus required maxlength="120" :aria-invalid="!name.trim()" @input="draft" /></label>
        </fieldset>
        <p v-if="processing" role="status">{{ en ? 'Processing image…' : '正在处理头像…' }}</p>
        <p v-if="error" class="profile-error" role="alert">{{ error }}</p>
        <div v-if="discard" class="profile-discard" role="alert"><p>{{ en ? 'Discard unsaved changes?' : '放弃尚未保存的修改？' }}</p><button type="button" @click="discard = false">{{ en ? 'Keep editing' : '继续编辑' }}</button><button type="button" @click="close(true)">{{ en ? 'Discard' : '放弃修改' }}</button></div>
        <footer><button type="button" :disabled="saving || processing" @click="close()">{{ en ? 'Cancel' : '取消' }}</button><button type="submit" class="profile-save" :disabled="saving || processing || !changed || !name.trim()">{{ saving ? (en ? 'Saving…' : '保存中…') : (en ? 'Save' : '保存') }}</button></footer>
      </form>
    </dialog>
  </section>
</template>

<style>
.profile-page { margin-top:-24px; }
.profile-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; }
.profile-heading h1 { margin:0; font-size:16px; line-height:24px; font-weight:400; letter-spacing:0; }
.profile-edit { display:flex; gap:8px; align-items:center; border:0; padding:8px 12px; border-radius:8px; background:transparent; color:var(--ink); cursor:pointer; font-size:16px; line-height:24px; font-weight:400; }
.profile-edit svg { flex-shrink:0; }
.profile-edit:hover { background:var(--line); }
.profile-identity { max-width:640px; margin:24px auto 0; text-align:center; overflow-wrap:anywhere; }
.profile-avatar { width:96px; height:96px; margin:auto; display:grid; place-items:center; overflow:hidden; border-radius:50%; background:#e9edfb; color:#5068b7; font-size:36px; }
.profile-avatar img { width:100%; height:100%; object-fit:cover; }
.profile-identity h2 { margin:16px 0 8px; font-size:28px; font-weight:500; line-height:1.4; }
.profile-identity p { margin:4px 0; color:var(--muted); font-size:14px; }
.profile-identity .profile-success { margin-top:24px; color:#26704c; }
.profile-dialog { width:min(480px, calc(100vw - 32px)); max-height:calc(100svh - 32px); overflow:auto; padding:24px; border:1px solid var(--line); border-radius:14px; background:var(--surface); color:var(--ink); box-shadow:0 16px 64px #19191b26; }
.profile-dialog::backdrop { background:#19191b66; }
.profile-dialog h2 { margin:0; font-size:20px; font-weight:500; }
.profile-dialog fieldset { border:0; margin:0; padding:0; min-width:0; }
.profile-photo-editor { position:relative; width:112px; margin:32px auto 16px; }
.profile-photo-editor .profile-avatar { width:112px; height:112px; }
.profile-dialog button { cursor:pointer; color:var(--ink); background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:8px 16px; min-height:40px; }
.profile-dialog button:hover:not(:disabled) { background:var(--sidebar); }
.profile-dialog .profile-camera { position:absolute; right:-4px; bottom:0; display:grid; place-items:center; padding:0; width:40px; height:40px; border-radius:50%; }
.profile-photo-help { text-align:center; font-size:12px; color:var(--muted); margin:0 0 8px; }
.profile-dialog .profile-remove { display:block; margin:0 auto; border:0; font-size:12px; color:var(--muted); }
.profile-field { display:block; margin-top:24px; border:1px solid #d5d5db; border-radius:8px; padding:10px 14px; }
.profile-field:focus-within { outline:2px solid var(--accent); outline-offset:2px; }
.profile-field span { display:block; font-size:12px; color:var(--muted); margin-bottom:4px; }
.profile-field input { width:100%; border:0; padding:0; color:var(--ink); background:transparent; font-size:16px; line-height:24px; }
.profile-field input:focus-visible { outline:0; }
.profile-dialog footer { display:flex; justify-content:flex-end; gap:8px; margin-top:24px; }
.profile-dialog .profile-save { min-width:80px; background:#202023; color:white; border-color:#202023; }
.profile-dialog .profile-save:hover:not(:disabled) { background:#36363d; }
.profile-error { color:#a52a32; font-size:13px; }
.profile-discard { margin-top:16px; padding:12px; background:var(--sidebar); border-radius:8px; }
.profile-discard button + button { margin-left:8px; }
@media(max-width:760px) { .profile-page { margin-top:-16px; } .profile-identity { margin-top:16px; } .profile-dialog { padding:20px; } .profile-dialog button { min-height:44px; } }
</style>
