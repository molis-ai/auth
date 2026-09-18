<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElButton } from 'element-plus'
import ConnectionState from './ConnectionState.vue'
import { AuthError, type AuthClient, type AuthProvider } from '../../sdk/browser/src/index.ts'
import { ConsoleError, spaceApi } from './console-api'
import { unlinkIdentity } from './security-api'
const props = defineProps<{ auth: AuthClient; language: 'en' | 'zh-CN' }>()
const emit = defineEmits<{ ended: [restorePaused: boolean] }>()
type Method = { id: string; provider: string; available: boolean }
const en = computed(() => props.language === 'en'), busy = ref(false), failure = ref(''), selected = ref<Method>()
const methods = ref<{ userId: string; availableProviders: AuthProvider[]; password: boolean; external: Method[] }>()
const binding = ref<AuthProvider>()
async function work(action: () => Promise<void>) { if (busy.value) return; busy.value = true; failure.value = ''; try { await action() } catch (error) { failure.value = error instanceof ConsoleError || error instanceof AuthError ? error.code : 'AUTH_UNAVAILABLE' } finally { busy.value = false } }
const providers: { id: AuthProvider; name: string }[] = [{ id: 'google', name: 'Google' }, { id: 'apple', name: 'Apple' }]
const loadFailed = ref(false)
let disposed = false
function linked(provider: AuthProvider) { return methods.value?.external.filter(method => method.provider.toLowerCase() === provider) ?? [] }
function providerName(provider: string) { return providers.find(item => item.id === provider.toLowerCase())?.name ?? provider }
async function load() {
  await work(async () => {
    loadFailed.value = false
    try { const result = await spaceApi<NonNullable<typeof methods.value>>(props.auth, '/sessions/login-methods'); if (!disposed) methods.value = result }
    catch (error) { if (!disposed) loadFailed.value = true; throw error }
  })
}
onMounted(() => void load())
onUnmounted(() => { disposed = true })
async function bind() { const provider = binding.value; binding.value = undefined; if (provider && methods.value) await work(() => props.auth.bindProvider(provider, methods.value!.userId)) }
function removable(method: Method) { return methods.value?.password || methods.value?.external.some(other => other.id !== method.id && other.available) }
async function unlink() { const target = selected.value; selected.value = undefined; if (target) await work(async () => { const local = await unlinkIdentity(props.auth, target.id); emit('ended', local.restorePaused) }) }
</script>
<template>
  <section class="account-connections" :aria-busy="busy"><h3>{{ en ? 'Connected accounts' : '关联账号' }}</h3>
    <div v-if="failure" class="notice error" role="alert"><p>{{ loadFailed ? (en ? 'Could not load account connections.' : '暂时无法读取关联状态。') : (en ? 'Could not complete this action. Please try again after signing in.' : '操作未完成，请重新登录后再试。') }}</p><ElButton v-if="loadFailed" :disabled="busy" @click="load">{{ en ? 'Retry' : '重试' }}</ElButton><ElButton v-if="failure === 'REAUTHENTICATION_REQUIRED' || failure === 'LOGIN_REQUIRED' || failure === 'ACCOUNT_CHANGED'" :disabled="busy" @click="work(() => auth.signIn({ forceLogin: true }))">{{ en ? 'Sign in again' : '重新登录' }}</ElButton></div>
    <div class="connection-row"><div class="connection-name"><strong>molis AI</strong><span>{{ en ? 'Email and password' : '邮箱与密码' }}</span></div><ConnectionState :connected="methods?.password" :failed="loadFailed" :language="language" /></div>
    <div v-for="provider in providers" :key="provider.id" class="connection-row"><div class="connection-name"><strong>{{ provider.name }}</strong><span v-if="methods && !methods.availableProviders.includes(provider.id)">{{ en ? 'Currently unavailable' : '暂未开放' }}</span></div><div class="connection-status-actions"><ConnectionState :connected="methods ? linked(provider.id).length > 0 : undefined" :failed="loadFailed" :language="language" /><ElButton v-if="methods?.availableProviders.includes(provider.id) && !linked(provider.id).length" :disabled="busy" @click="binding = provider.id">{{ en ? 'Connect' : '关联' }}</ElButton><ElButton v-for="method in linked(provider.id)" :key="method.id" text :disabled="busy || !removable(method)" :title="!removable(method) ? (en ? 'Keep at least one usable sign-in method.' : '需保留至少一种可用的登录方式。') : undefined" @click="selected = method">{{ en ? 'Disconnect' : '解除关联' }}</ElButton></div></div>
    <div v-if="binding && methods" class="notice info"><p>{{ en ? 'Connect ' + providerName(binding) + ' to your molis AI account? Recent sign-in and provider verification are required.' : '将 ' + providerName(binding) + ' 关联到当前 molis AI 账号？需近期登录并完成第三方账号验证。' }}</p><div class="connection-confirm"><ElButton type="primary" :disabled="busy" @click="bind">{{ en ? 'Continue' : '继续' }}</ElButton><ElButton :disabled="busy" @click="binding = undefined">{{ en ? 'Cancel' : '取消' }}</ElButton></div></div>
    <div v-if="selected" class="notice info"><p>{{ en ? 'Disconnect ' + providerName(selected.provider) + '? This signs you out of all molis AI sessions, but not your Google or Apple account. Recent sign-in is required.' : '解除 ' + providerName(selected.provider) + ' 关联？需近期登录，解除后将退出所有 molis AI 会话，不影响 Google 或 Apple 自身的登录。' }}</p><div class="connection-confirm"><ElButton type="primary" :disabled="busy" @click="unlink">{{ en ? 'Confirm' : '确认' }}</ElButton><ElButton :disabled="busy" @click="selected = undefined">{{ en ? 'Cancel' : '取消' }}</ElButton></div></div>
  </section>
</template>
<style>
.account-connections { margin-bottom:24px; }
.connection-row { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:16px 0; border-bottom:1px solid var(--line); }
.connection-name { display:flex; flex-direction:column; gap:4px; min-width:0; }
.connection-name strong { font-size:14px; font-weight:500; color:var(--ink); }
.connection-name>span { font-size:12px; color:var(--muted); }
.connection-status-actions { display:flex; align-items:center; justify-content:flex-end; gap:16px; flex-wrap:wrap; }
.connection-confirm { display:flex; gap:8px; }
.connection-confirm .el-button + .el-button { margin-left:0; }
@media(max-width:600px) { .connection-row { gap:12px; } .connection-status-actions { gap:8px; } .account-connections .el-button { min-height:44px; } }
</style>
