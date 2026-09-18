<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import type { AuthClient } from '../../sdk/browser/src/index.ts'
import { ConsoleError, spaceApi } from './console-api'
import InfoHint from './InfoHint.vue'
import { prepareTeamAvatar, TeamAvatarError } from './team-avatar'
const props = defineProps<{ auth: AuthClient; language: 'en' | 'zh-CN'; team?: { id: string; name: string; description?: string; avatarUrl?: string | null; version: number } }>()
const emit = defineEmits<{ back: []; created: [id: string]; draft: [value: boolean]; busy: [value: boolean] }>()
const name = ref(''), description = ref(''), avatar = ref<string | null>(null), fileInput = ref<HTMLInputElement>(), nameInput = ref<HTMLInputElement>()
name.value = props.team?.name ?? ''; description.value = props.team?.description ?? ''; avatar.value = props.team?.avatarUrl ?? null
const saving = ref(false), processing = ref(false), submitted = ref(false), avatarError = ref(''), failure = ref(''), uncertain = ref(false)
const en = computed(() => props.language === 'en')
const locked = computed(() => saving.value || processing.value)
const nameError = computed(() => !name.value.trim() || Array.from(name.value.trim()).length > 120 || /[\u0000-\u001f\u007f]/.test(name.value))
const descriptionError = computed(() => Array.from(description.value).length > 200)
watch([name, description, avatar], () => emit('draft', name.value !== (props.team?.name ?? '') || description.value !== (props.team?.description ?? '') || avatar.value !== (props.team?.avatarUrl ?? null)))
watch(locked, value => emit('busy', value))
async function choose(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''; if (!file) return
  processing.value = true; avatarError.value = ''
  try {
    avatar.value = await prepareTeamAvatar(file)
  } catch (error) {
    const code=error instanceof TeamAvatarError ? error.code : 'process'
    const messages = {
      size: ['图片超过 5 MB，请选择更小的图片。', 'The image exceeds 5 MB. Choose a smaller image.'],
      format: ['不支持此图片格式，请选择 PNG、JPG 或 WebP。', 'Unsupported format. Choose PNG, JPG or WebP.'],
      read: ['无法读取图片，请重新选择文件。', 'Unable to read the image. Please select the file again.'],
      process: ['图片无法解析或处理，请尝试重新导出后上传。', 'Unable to decode or process the image. Try exporting it again.'],
    }
    avatarError.value=messages[code][en.value ? 1 : 0]!
  }
  finally { processing.value = false }
}
async function create() {
  if (locked.value || uncertain.value) return
  submitted.value = true; failure.value = ''
  if (nameError.value) { nameInput.value?.focus(); return }
  if (descriptionError.value) return
  saving.value = true
  try {
    const team = await spaceApi<{ id: string }>(props.auth, props.team ? '/spaces/' + props.team.id : '/spaces', props.team ? 'PUT' : 'POST', { name: name.value.trim(), description: description.value.trim(), avatarUrl: avatar.value, ...(props.team ? { version: props.team.version } : {}) })
    emit('draft', false); saving.value = false; emit('busy', false); emit('created', team.id)
  } catch (error) {
    uncertain.value = error instanceof ConsoleError && error.uncertain
    if (error instanceof ConsoleError && error.code === 'INVALID_AVATAR') avatarError.value = en.value ? 'This image cannot be used. Please choose another.' : '头像无法使用，请重新选择图片。'
    else if (error instanceof ConsoleError && error.code === 'VERSION_CONFLICT') failure.value = en.value ? 'The team has changed. Return to the details and reload before editing.' : '团队资料已发生变化，请返回详情重新读取后再修改。'
    else failure.value = uncertain.value ? (en.value ? 'The result could not be confirmed. Return to the team details and check before repeating.' : '暂时无法确认保存结果，请返回团队详情核对后再操作。') : (en.value ? 'Could not save. Your input is preserved; please try again.' : '保存失败，已保留填写内容，请稍后重试。')
  } finally { saving.value = false }
}
onBeforeUnmount(() => { emit('draft', false); emit('busy', false) })
</script>
<template>
  <section class="team-create-page" :aria-busy="locked">
    <header class="team-create-heading"><button class="team-create-back" :disabled="locked" @click="emit('back')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>{{ en ? 'Back to teams' : '返回团队管理' }}</button>
    <h1>{{ team ? (en ? 'Edit team profile' : '修改团队资料') : (en ? 'Create team' : '创建团队') }}</h1></header>
    <form class="team-create-form" novalidate @submit.prevent="create">
      <fieldset :disabled="locked">
        <div class="team-create-photo-row"><button type="button" class="team-create-avatar-button" :aria-label="en ? 'Change team photo' : '更换团队头像'" @click="fileInput?.click()"><span class="team-create-avatar"><img v-if="avatar" :src="avatar" alt=""/><span v-else aria-hidden="true">{{ Array.from(name.trim())[0]?.toUpperCase() || '团' }}</span></span><span class="team-create-camera" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/></svg></span></button><div class="team-create-photo-label"><span>{{ en ? 'Team photo' : '团队头像' }}</span><InfoHint :label="en ? 'Photo requirements' : '头像要求'" :text="en ? 'Optional. Click the photo to choose a PNG, JPG or WebP under 5 MB. Images are center-cropped.' : '头像选填。点击头像选择 PNG、JPG 或 WebP 图片，不超过 5 MB，图片将居中裁切。'"/></div><button v-if="avatar" class="team-create-remove-photo" type="button" @click="avatar = null">{{ en ? 'Use default' : '恢复默认' }}</button></div>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="choose"/>
        <p v-if="avatarError" class="team-create-error" role="alert">{{ avatarError }}</p>
        <p v-if="processing" role="status">{{ en ? 'Processing image…' : '正在处理头像…' }}</p>
        <div class="team-create-field"><div class="team-create-label"><label for="create-team-name">{{ en ? 'Team name' : '团队名称' }}</label><InfoHint :label="en ? 'Name requirements' : '名称要求'" :text="en ? 'Required, 1–120 characters. This name appears in team lists and invitations.' : '必填，1–120 字。此名称将显示在团队列表和邀请中。'"/></div><input id="create-team-name" ref="nameInput" v-model="name" required maxlength="120" :aria-invalid="submitted && nameError" :aria-describedby="submitted && nameError ? 'team-name-error' : undefined" :placeholder="en ? 'e.g. molis product team' : '例如：molis 产品团队'"/><span v-if="submitted && nameError" id="team-name-error" class="team-create-error" role="alert">{{ en ? 'Enter a name of 1–120 characters.' : '请填写 1–120 字的团队名称。' }}</span></div>
        <div class="team-create-field"><div class="team-create-label"><label for="create-team-description">{{ en ? 'Description' : '团队简介' }} <small>{{ en ? 'Optional' : '选填' }}</small></label><InfoHint :label="en ? 'Description help' : '简介说明'" :text="en ? 'Describe the team in up to 200 characters. You can leave this blank.' : '用不超过 200 字介绍团队的用途或工作内容，也可以留空。'"/></div><textarea id="create-team-description" v-model="description" rows="3" maxlength="200" :aria-invalid="descriptionError" :placeholder="en ? 'What does this team do?' : '简单介绍一下这个团队'"/><small v-if="description.length" class="team-description-count">{{ Array.from(description).length }}/200</small></div>
      </fieldset>
      <p v-if="failure" class="team-create-error" role="alert">{{ failure }}</p>
      <div class="team-create-actions"><button type="button" :disabled="locked" @click="emit('back')">{{ en ? 'Cancel' : '取消' }}</button><button class="team-create-submit" type="submit" :disabled="locked || uncertain">{{ saving ? (en ? 'Saving…' : '保存中…') : team ? (en ? 'Save changes' : '保存修改') : (en ? 'Create team' : '创建团队') }}</button></div>
    </form>
  </section>
</template>
<style>
.team-create-page { display:flex; flex-direction:column; min-height:100%; width:100%; margin:0; }
.team-content .team-create-page { max-width:none; padding:8px 24px 16px; }
.team-create-heading { flex-shrink:0; }
.team-create-page h1 { font-size:22px; line-height:1.4; font-weight:600; letter-spacing:-.4px; margin:12px 0 0; }
.team-create-page button { border:1px solid var(--line); border-radius:7px; background:var(--surface); color:var(--ink); padding:8px 14px; min-height:36px; cursor:pointer; }
.team-create-page button:hover:not(:disabled) { background:var(--sidebar); }
.team-create-page button:disabled { cursor:default; opacity:.6; }
.team-create-page .team-create-back { display:flex; gap:8px; align-items:center; border:0; background:transparent; padding:0; color:var(--muted); font-size:13px; }
.team-create-form { flex:1; display:flex; flex-direction:column; min-height:0; }
.team-create-form fieldset { border:0; padding:32px 0; margin:auto; min-width:0; width:min(440px,100%); }
.team-create-photo-row { display:flex; flex-direction:column; gap:10px; align-items:center; margin-bottom:28px; }
.team-create-page .team-create-avatar-button { position:relative; width:80px; height:80px; padding:0; border:0; border-radius:50%; background:transparent; }
.team-create-avatar { width:80px; height:80px; border-radius:50%; background:#e9edfb; color:var(--accent); overflow:hidden; display:grid; place-items:center; font-size:28px; font-weight:500; }
.team-create-camera { position:absolute; bottom:0; right:-2px; display:grid; place-items:center; width:28px; height:28px; background:var(--surface); border:1px solid var(--line); border-radius:50%; color:var(--muted); }
.team-create-camera svg { width:16px; height:16px; }
.team-create-avatar-button:hover:not(:disabled) .team-create-camera { color:var(--ink); background:var(--sidebar); }
.team-create-photo-label { display:flex; align-items:center; gap:4px; color:var(--muted); font-size:12px; }
.team-create-page .team-create-remove-photo { background:transparent; border:0; padding:0 8px; color:var(--muted); font-size:12px; min-height:28px; }
.team-create-avatar img { width:100%; height:100%; object-fit:cover; }
.team-create-field { display:flex; flex-direction:column; gap:6px; margin-bottom:20px; font-size:14px; position:relative; }
.team-create-label { display:flex; align-items:center; gap:4px; min-height:24px; }
.team-create-label label { font-size:13px; font-weight:500; color:var(--ink); }
.team-create-field small { color:var(--muted); font-size:12px; margin-left:4px; }
.team-create-field input,.team-create-field textarea { width:100%; border:1px solid #dedee3; border-radius:10px; padding:11px 14px; background:var(--surface); color:var(--ink); font:inherit; font-size:15px; font-weight:400; line-height:1.5; }
.team-create-field input::placeholder,.team-create-field textarea::placeholder { color:#93939b; font-weight:400; font-size:14px; }
.team-create-field textarea { resize:vertical; min-height:86px; }
.team-create-field input:focus,.team-create-field textarea:focus { outline:2px solid #85858f; outline-offset:-2px; }
.team-description-count { position:absolute; right:2px; bottom:-18px; }
.team-create-error { color:#942f35; font-size:12px; line-height:1.6; }
.team-create-actions { display:flex; justify-content:flex-end; gap:8px; padding-top:16px; margin-top:auto; flex-shrink:0; }
.team-create-page .team-create-submit { min-width:100px; background:#202023; color:white; border-color:#202023; }
.team-create-page .team-create-submit:hover:not(:disabled) { background:#39393e; }
@media(max-width:760px) { .team-create-page button { min-height:44px; } .team-content .team-create-page { padding:8px 12px 16px; } .team-create-form fieldset { padding:24px 0; } .team-create-page h1 { font-size:20px; } }
</style>
