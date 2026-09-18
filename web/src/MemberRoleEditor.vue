<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElSelect, ElOption } from 'element-plus'
import 'element-plus/es/components/select/style/css'
import 'element-plus/es/components/option/style/css'
import type { AuthClient } from '../../sdk/browser/src/index.ts'
import { spaceApi, ConsoleError } from './console-api'
import type { Role } from './space-policy'
const props = defineProps<{ auth: AuthClient; spaceId: string; language: string; member: { id: string; displayName: string; emails: string[]; role: Role }; options: Role[] }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const dialog = ref<HTMLDialogElement>(), role = ref<Role>(props.member.role), saving = ref(false), failure = ref<ConsoleError>()
const en = computed(() => props.language === 'en')
const labels = computed(() => en.value ? { OWNER:'Owner', ADMIN:'Administrator', MEMBER:'Member', VIEWER:'Viewer' } : { OWNER:'所有者', ADMIN:'管理员', MEMBER:'成员', VIEWER:'只读成员' })
onMounted(() => dialog.value?.showModal())
function close() { if (!saving.value) { dialog.value?.close(); emit('close') } }
async function save() {
  if (saving.value || failure.value?.uncertain || role.value === props.member.role || !props.options.includes(role.value)) return
  saving.value = true; failure.value = undefined
  try {
    await spaceApi(props.auth, '/spaces/' + props.spaceId + '/members/' + props.member.id + '/role', 'PUT', { role: role.value })
    dialog.value?.close(); emit('saved')
  } catch (e) { failure.value = e instanceof ConsoleError ? e : new ConsoleError('AUTH_UNAVAILABLE', '', true) }
  finally { saving.value = false }
}
</script>
<template>
  <dialog ref="dialog" class="member-role-editor" aria-labelledby="role-editor-title" @cancel.prevent="close">
    <form @submit.prevent="save">
      <h2 id="role-editor-title">{{ en ? 'Change role' : '修改角色' }}</h2>
      <div class="role-editor-person"><strong>{{ member.displayName }}</strong><span v-for="email in member.emails" :key="email">{{ email }}</span></div>
      <label for="member-role-choice">{{ en ? 'Team role' : '团队角色' }}</label>
      <ElSelect id="member-role-choice" v-model="role" class="role-editor-select" :append-to="dialog" popper-class="role-editor-options" :show-arrow="false" :disabled="saving || failure?.uncertain"><ElOption v-for="option in options" :key="option" :value="option" :label="labels[option] + (option === member.role ? (en ? ' (current)' : '（当前）') : '')" /></ElSelect>
      <p v-if="failure" role="alert" class="role-editor-error">{{ failure.uncertain ? (en ? 'Result unknown. Close and refresh members before trying again.' : '结果尚未确认，请关闭并刷新成员列表后核实，勿重复提交。') : (en ? 'Could not save. Your selection is retained; check access and try again.' : '保存失败，已保留选择，请核实权限后重试。') }}</p>
      <footer><button type="button" :disabled="saving" @click="close">{{ en ? 'Cancel' : '取消' }}</button><button class="role-editor-save" type="submit" :disabled="saving || failure?.uncertain || role === member.role">{{ saving ? (en ? 'Saving…' : '正在保存…') : (en ? 'Save changes' : '保存修改') }}</button></footer>
    </form>
  </dialog>
</template>
<style>
.member-role-editor { width:min(460px,calc(100vw - 32px)); max-height:calc(100dvh - 48px); box-sizing:border-box; overflow:visible; padding:24px; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--ink); }
.member-role-editor::backdrop { background:#19191b55; }
.member-role-editor h2 { margin:0 0 20px; font-size:18px; font-weight:550; }
.role-editor-person { display:grid; gap:4px; margin-bottom:20px; overflow-wrap:anywhere; }.role-editor-person strong { font-size:14px; font-weight:500; }.role-editor-person span { color:var(--muted); font-size:12px; }
.member-role-editor label { display:block; margin-bottom:8px; font-size:13px; }.member-role-editor form { max-height:calc(100dvh - 100px); overflow-y:auto; padding:2px; }
.role-editor-select { width:100%; --el-color-primary:var(--accent); --el-text-color-regular:var(--ink); --el-fill-color-blank:var(--surface); --el-border-color:var(--line); }
.role-editor-select .el-select__wrapper { min-height:40px; border-radius:8px; font-size:14px; box-shadow:0 0 0 1px var(--line) inset; }
.role-editor-select .el-select__wrapper.is-focused { box-shadow:0 0 0 1px var(--accent) inset; }
.role-editor-options.el-popper { border:1px solid var(--line); border-radius:8px; background:var(--surface); box-shadow:0 8px 24px #19191b14; }
.role-editor-options .el-select-dropdown__item { font-size:13px; color:var(--ink); margin:2px 4px; border-radius:5px; padding:0 12px; }
.role-editor-options .el-select-dropdown__item.is-hovering { background:var(--sidebar); }
.role-editor-options .el-select-dropdown__item.is-selected { color:var(--accent); font-weight:500; background:var(--sidebar); }
.member-role-editor footer { display:flex; justify-content:flex-end; gap:8px; margin-top:24px; }.member-role-editor footer button { min-height:36px; padding:7px 14px; border:1px solid var(--line); border-radius:7px; background:var(--surface); color:var(--ink); font:inherit; font-size:13px; cursor:pointer; }.member-role-editor .role-editor-save { min-width:92px; background:var(--ink); color:var(--surface); }.member-role-editor footer button:disabled { opacity:.5; cursor:default; }.role-editor-error { font-size:12px; color:#b42318; line-height:1.6; }
@media(max-width:760px){.member-role-editor footer button,.role-editor-select .el-select__wrapper { min-height:44px; }}
</style>
