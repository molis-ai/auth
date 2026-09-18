<script setup lang="ts">
import { restoreConsoleSession } from './console-restore'
import StatusTag from './StatusTag.vue'
import UserMenu from './UserMenu.vue'
import Profile from './Profile.vue'
import TeamCreate from './TeamCreate.vue'
import molisLogo from './assets/molis-logo.png'
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { ElButton } from 'element-plus'
import 'element-plus/es/components/button/style/css'
import { AuthClient, AuthError, type CurrentUser } from '../../sdk/browser/src/index.ts'
import { api } from './protocol'
import { platform, ConsoleError, checkedConsole, callbackLines, listPath, takeConsoleArrival, type ConsoleConfiguration, type Application, type LoginClient, type ServiceClient, type User, type Audit, type Page } from './console-api'
import { consoleCopy } from './console-copy'
import './console.css'
import Spaces from './Spaces.vue'
import Pending from './Pending.vue'
import Security from './Security.vue'
import Mail from './Mail.vue'
import PermissionConfiguration from './PermissionConfiguration.vue'
import WorkspaceIcon from './WorkspaceIcon.vue'
import { workspacePage, workspaceTeam, rememberedTeam, clearAccountWorkspace, isPlatformPage, type WorkspacePage } from './workspace'

const arrival = takeConsoleArrival(location, history)
let sdkArrival = arrival, restoringInPlace = false
const page = ref<WorkspacePage>(workspacePage(location.hash)), collapsed = ref(false)
const drawer = ref<HTMLDialogElement>()
const pendingPage = ref<InstanceType<typeof Pending>>(), spacesPage = ref<InstanceType<typeof Spaces>>()
const pendingCount = ref<number>()
function refreshPending() { void pendingPage.value?.refresh() }
function invitationResolved() { void spacesPage.value?.refresh() }
const navigationDialog = ref<HTMLDialogElement>()
const navigationTarget = ref<{ page: WorkspacePage; push: boolean; teamId?: string }>()
const spaceDraft = ref(false), profileDraft = ref(false), createDraft = ref(false), createBusy = ref(false)
const spaceBusy = ref(false), permissionDraft = ref(false), permissionBusy = ref(false)
const navLabels = computed(() => language.value === 'en' ? { 'team-create': 'Create team', account: 'Personal profile', pending: 'Pending', security: 'Account security', spaces: 'Team management', permissions: 'Permissions', applications: 'Applications', users: 'Users', audit: 'Audit log', mail: 'Mail delivery' } : { 'team-create': '创建团队', account: '个人资料', pending: '待处理', security: '账号安全', spaces: '团队管理', permissions: '权限配置', applications: '应用管理', users: '用户管理', audit: '审计日志', mail: '邮件投递' })
const pageDescription = computed(() => page.value === 'team-create' ? '' : language.value === 'en' ? { account: 'Your identity and workspace access, in one place.', pending: 'Review and manage your pending items.', security: 'Review sign-in methods, sessions and security activity.', spaces: 'Manage your teams, members and roles.', permissions: 'Review resource access by application and role.', applications: 'Configure applications and their access clients.', users: 'Review accounts and manage their availability.', audit: 'Review recorded platform changes and their outcomes.', mail: 'Inspect delivery results and retry eligible notifications.' }[page.value] : { account: '查看你的身份信息和工作空间访问入口。', pending: '查看和处理待办事项。', security: '管理登录方式、登录会话与安全事件。', spaces: '管理团队、成员与角色。', permissions: '按应用查看各角色的资源访问权限。', applications: '配置应用及其登录客户端和服务身份。', users: '查看用户账号并管理可用状态。', audit: '查看已记录的平台变更及操作结果。', mail: '查看邮件投递结果，按需重发符合条件的通知。' }[page.value])
const navigation = computed(() => (administrator.value ? ['spaces', 'permissions', 'applications', 'users', 'audit', 'mail'] : ['spaces']) as WorkspacePage[])
function rememberPage() { try { sessionStorage.setItem('molis.auth.workspace-page', page.value) } catch { /* Optional non-secret navigation hint. */ } }
async function navigatePage(value: WorkspacePage, push = true, confirmed = false, teamId?: string) {
  if (busy.value || createBusy.value || spaceBusy.value || permissionBusy.value || (isPlatformPage(value) && !administrator.value)) return
  if (!confirmed && value !== page.value && (hasDraft.value || createDraft.value)) { navigationTarget.value = { page: value, push, teamId }; history.replaceState(null, '', '/console#/' + page.value); await nextTick(); navigationDialog.value?.showModal(); return }
  clearSecret(); drawer.value?.close()
  if (confirmed && value === 'team-create') { spacesPage.value?.discardDraft() }
  if (isPlatformPage(value)) await switchTab(value as typeof tab.value)
  page.value = value; rememberPage()
  const route = value === 'spaces' && teamId ? '/console#/spaces/' + teamId : value === 'spaces' && workspaceTeam(location.hash) ? '/console' + location.hash : '/console#/' + value
  if (push) history.pushState(null, '', route)
  else history.replaceState(null, '', route)
  if (value === 'spaces') { await nextTick(); spacesPage.value?.syncRoute() }
}
function cancelNavigation() { navigationDialog.value?.close(); navigationTarget.value = undefined }
async function teamCreated(id: string) {
  createDraft.value = false; createBusy.value = false
  history.replaceState(null, '', '/console#/spaces/' + id)
  await navigatePage('spaces', false, true)
  await spacesPage.value?.refresh()
}
async function confirmNavigation() { const target = navigationTarget.value; cancelNavigation(); if (target) await navigatePage(target.page, target.push, true, target.teamId) }
function locationChanged() { if (location.hash.startsWith('#/')) void navigatePage(workspacePage(location.hash), false) }
function openDrawer() { drawer.value?.showModal() }
function leaving(event: BeforeUnloadEvent) { if (hasDraft.value || createDraft.value || createBusy.value || spaceBusy.value || permissionBusy.value) { event.preventDefault(); event.returnValue = '' } }
const hasDraft = computed(() => permissionDraft.value || spaceDraft.value || profileDraft.value || !!newName.value || !!serviceName.value || clientId.value !== (editingClient.value?.clientId ?? '') || redirects.value !== (editingClient.value?.redirects.join('\n') ?? '') || clientStatus.value !== (editingClient.value?.status ?? 'ACTIVE') || JSON.stringify(clientScopes.value) !== JSON.stringify(editingClient.value?.scopes ?? ['account', 'profile']) || (!!selected.value && (appName.value !== selected.value.name || appStatus.value !== selected.value.status || JSON.stringify(appActions.value) !== JSON.stringify(selected.value.actions))))
const language = ref<'en' | 'zh-CN'>(navigator.language.startsWith('zh') ? 'zh-CN' : 'en')
try { const saved = localStorage.getItem('molis.auth.locale'); if (saved === 'en' || saved === 'zh-CN') language.value = saved } catch { /* Optional locale only. */ }
watch(language, value => { document.documentElement.lang = value; try { localStorage.setItem('molis.auth.locale', value) } catch { /* Optional only. */ } }, { immediate: true })
const t = computed(() => consoleCopy[language.value]), busy = ref(true), enabled = ref(false), administrator = ref(false)
let auth: AuthClient | undefined
const me = ref<CurrentUser>(), failure = ref<{ code: string; request: string; uncertain: boolean }>(), notice = ref('')
watch(() => me.value?.userId, () => { pendingCount.value = undefined })
const tab = ref<'permissions' | 'applications' | 'users' | 'audit' | 'mail'>('applications'), apps = ref<Page<Application>>(), users = ref<Page<User>>(), events = ref<Page<Audit>>()
const selected = ref<Application>(), selectedUser = ref<User>(), catalog = ref<string[]>([]), clients = ref<Page<LoginClient>>(), services = ref<Page<ServiceClient>>()
const appName = ref(''), appStatus = ref('ACTIVE'), appActions = ref<string[]>([]), newName = ref(''), serviceName = ref('')
const editingClient = ref<LoginClient>(), clientId = ref(''), clientType = ref('WEB'), clientStatus = ref('ACTIVE'), clientScopes = ref(['account', 'profile']), redirects = ref('')
const secret = shallowRef<{ clientId: string; value: string }>(), showSecret = ref(false)
const pending = shallowRef<{ label: string; run: () => Promise<void> }>()
const confirmation = ref<HTMLDialogElement>()
watch(pending, async value => { await nextTick(); if (value && !confirmation.value?.open) confirmation.value?.showModal(); else if (!value) confirmation.value?.close() })
function clearSecret() { secret.value = undefined; showSecret.value = false }
function fail(error: unknown) {
  failure.value = error instanceof ConsoleError ? { code: error.code, request: error.requestId, uncertain: error.uncertain }
    : error instanceof AuthError ? { code: error.code, request: error.requestId, uncertain: false } : { code: 'AUTH_UNAVAILABLE', request: '', uncertain: false }
  if (['UNAUTHENTICATED', 'LOGIN_REQUIRED', 'PLATFORM_ADMIN_REQUIRED'].includes(failure.value.code)) administrator.value = false
}
async function work(task: () => Promise<void>) { if (busy.value) return; busy.value = true; failure.value = undefined; notice.value = ''; try { await task() } catch (error) { fail(error) } finally { busy.value = false } }
function ask(label: string, task: () => Promise<void>) { if (!busy.value) { clearSecret(); pending.value = { label, run: task } } }
async function confirm() { const action = pending.value; pending.value = undefined; if (action) await work(async () => { await action.run(); if (!notice.value) notice.value = t.value.success }) }
async function signIn() { await work(async () => { rememberPage(); clearSecret(); await auth?.signIn() }) }
function clearAccountState() {
  let cleared = false
  try { cleared = clearAccountWorkspace(sessionStorage, me.value?.userId) } catch { /* Storage can be denied. */ }
  clearSecret(); pending.value = undefined; navigationTarget.value = undefined
  drawer.value?.close(); navigationDialog.value?.close(); confirmation.value?.close()
  me.value = undefined; administrator.value = false; pendingCount.value = undefined
  selected.value = undefined; selectedUser.value = undefined; editingClient.value = undefined
  apps.value = undefined; users.value = undefined; events.value = undefined; clients.value = undefined; services.value = undefined; catalog.value = []
  appName.value = ''; appStatus.value = 'ACTIVE'; appActions.value = []; newName.value = ''; serviceName.value = ''
  clientId.value = ''; clientType.value = 'WEB'; clientStatus.value = 'ACTIVE'; clientScopes.value = ['account', 'profile']; redirects.value = ''
  spaceDraft.value = false; profileDraft.value = false; createDraft.value = false; permissionDraft.value = false
  createBusy.value = false; spaceBusy.value = false; permissionBusy.value = false
  failure.value = undefined; notice.value = ''; tab.value = 'applications'; page.value = 'account'
  history.replaceState(null, '', '/console#/account')
  return cleared
}
async function finishLogout(all = false) {
  clearSecret(); pending.value = undefined
  let result: Awaited<ReturnType<AuthClient['logout']>> | undefined
  let cleared = false
  try { result = await auth!.logout({ all }) } finally { cleared = clearAccountState() }
  notice.value = result?.serverRevoked && result.restorePaused && cleared ? t.value.signedOut : t.value.unconfirmed
  if (result?.serverRevoked && result.restorePaused && cleared) location.replace('/login')
}
async function logout() { await work(() => finishLogout()) }
function sessionEnded(restorePaused: boolean) { const cleared = clearAccountState(); notice.value = restorePaused && cleared ? t.value.signedOut : (language.value === 'en' ? 'Session revoked. Browser state could not be fully cleared; close this page.' : '会话已撤销，但浏览器状态未能完全清理，请关闭本页面。'); if (restorePaused && cleared) location.replace('/login') }
async function loadApps(cursor: string | null = null) { apps.value = await platform(auth!, listPath('/applications', cursor)) }
async function loadUsers(cursor: string | null = null) { users.value = await platform(auth!, listPath('/users', cursor)); selectedUser.value = undefined }
async function loadAudit(cursor: string | null = null) { events.value = await platform(auth!, listPath('/audit', cursor)) }
async function switchTab(value: typeof tab.value) { await work(async () => { clearSecret(); tab.value = value; selected.value = undefined; if (value === 'applications') await loadApps(); else if (value === 'users') await loadUsers(); else if (value === 'audit') await loadAudit() }) }
async function openApplication(id: string) {
  clearSecret(); selected.value = await platform<Application>(auth!, '/applications/' + id)
  appName.value = selected.value.name; appStatus.value = selected.value.status; appActions.value = [...selected.value.actions]; resetClient()
  await Promise.all([loadClients(), loadServices()])
}
async function loadClients(cursor: string | null = null) { clients.value = await platform(auth!, listPath('/applications/' + selected.value!.id + '/clients', cursor)) }
async function loadServices(cursor: string | null = null) { services.value = await platform(auth!, listPath('/applications/' + selected.value!.id + '/services', cursor)) }
function createApp() { const name = newName.value; ask(t.value.newApp, async () => { const app = await platform<Application>(auth!, '/applications', 'POST', { name, actions: [] }); newName.value = ''; await openApplication(app.id) }) }
function saveApp() { const app = selected.value!, body = { name: appName.value, status: appStatus.value, actions: [...appActions.value], version: app.version }; ask(t.value.save + ': ' + app.name, async () => { await platform(auth!, '/applications/' + app.id, 'PUT', body); await openApplication(app.id) }) }
function resetClient() { editingClient.value = undefined; clientId.value = ''; clientType.value = 'WEB'; clientStatus.value = 'ACTIVE'; clientScopes.value = ['account', 'profile']; redirects.value = '' }
async function editClient(value: LoginClient) { clearSecret(); const client = await platform<LoginClient>(auth!, '/clients/' + encodeURIComponent(value.clientId)); editingClient.value = client;
  clientId.value = client.clientId; clientType.value = client.clientType; clientStatus.value = client.status; clientScopes.value = [...client.scopes]; redirects.value = client.redirects.join('\n') }
function saveClient() {
  try { const current = editingClient.value, body = { scopes: [...clientScopes.value], redirects: callbackLines(redirects.value) }, id = clientId.value, type = clientType.value, status = clientStatus.value;
    ask(current ? t.value.save : t.value.newClient, async () => { if (current) await platform(auth!, '/clients/' + encodeURIComponent(current.clientId), 'PUT', { ...body, status, version: current.version });
      else await platform(auth!, '/applications/' + selected.value!.id + '/clients', 'POST', { ...body, clientId: id, clientType: type }); resetClient(); await loadClients() })
  } catch (error) { fail(error) }
}
function keepSecret(client: string, value: string) { if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new ConsoleError('INVALID_RESPONSE', '', true); secret.value = { clientId: client, value }; showSecret.value = false }
function createService() { const name = serviceName.value, app = selected.value!.id; ask(t.value.newService, async () => {
  const result = await platform<{ clientId: string; secret: string }>(auth!, '/applications/' + app + '/services', 'POST', { name }); keepSecret(result.clientId, result.secret); serviceName.value = ''; await loadServices() }) }
function rotate(client: ServiceClient) { ask(t.value.rotate + ': ' + client.name, async () => { const result = await platform<{ secret: string }>(auth!, '/services/' + client.clientId + '/rotate', 'POST', {}); keepSecret(client.clientId, result.secret); await loadServices() }) }
function disable(client: ServiceClient) { ask(t.value.disable + ': ' + client.name, async () => { await platform(auth!, '/services/' + client.clientId + '/disable', 'POST', {}); await loadServices() }) }
function changeUser(user: User) { const status = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'; ask((status === 'ACTIVE' ? t.value.enable : t.value.disable) + ': ' + user.displayName,
  async () => { await platform(auth!, '/users/' + user.id + '/status', 'PUT', { status }); await loadUsers() }) }
onMounted(async () => {
  window.addEventListener('pagehide', clearSecret)
  if (location.hash.startsWith('#/')) rememberPage()
  try {
    const options = checkedConsole(await api<ConsoleConfiguration>('/ui-configuration'), location.origin)
    enabled.value = !!options; if (!options) return
    // The SDK sees the original callback only in memory, after its URL was synchronously cleared.
    auth = new AuthClient({ ...options, environment: { storage: sessionStorage, crypto: window.crypto, fetch: window.fetch.bind(window), now: () => Date.now(),
      currentUrl: () => sdkArrival, navigate: url => window.location.assign(url), replaceUrl: url => { if (!restoringInPlace) history.replaceState(null, '', url) } } })
    if (!await auth.handleRedirect()) {
      restoringInPlace = true
      try {
        if (!await restoreConsoleSession(auth, options.issuer, options.clientId, options.redirectUri, async url => {
          sdkArrival = url
          return await auth!.handleRedirect()
        })) return
      } finally { restoringInPlace = false; sdkArrival = arrival }
    }
    me.value = await auth.currentUser()
    try { await platform(auth, '/me'); administrator.value = true }
    catch (error) { if (!(error instanceof ConsoleError) || error.code !== 'PLATFORM_ADMIN_REQUIRED') throw error }
    if (administrator.value) { catalog.value = await platform(auth, '/permission-catalog') }
    let requested = page.value
    try { if (!location.hash) requested = workspacePage('#/' + sessionStorage.getItem('molis.auth.workspace-page')) } catch { /* Optional navigation hint. */ }
    if (isPlatformPage(requested) && !administrator.value) requested = 'account'
    page.value = requested
    if (isPlatformPage(requested)) { tab.value = requested as typeof tab.value; if (requested === 'applications') await loadApps(); else if (requested === 'users') await loadUsers(); else if (requested === 'audit') await loadAudit() }
    let restoredRoute = '/console#/' + requested
    if (requested === 'spaces') { try { const team = workspaceTeam(location.hash) || rememberedTeam(sessionStorage, me.value.userId); if (team) restoredRoute += '/' + team } catch { /* Optional selection. */ } }
    history.replaceState(null, '', restoredRoute)
  } catch (error) { fail(error) } finally { busy.value = false }
})
onMounted(() => { window.addEventListener('popstate', locationChanged); window.addEventListener('hashchange', locationChanged); window.addEventListener('beforeunload', leaving) })
onUnmounted(() => { window.removeEventListener('pagehide', clearSecret); window.removeEventListener('popstate', locationChanged); window.removeEventListener('hashchange', locationChanged); window.removeEventListener('beforeunload', leaving); clearSecret() })
</script>

<template>
  <div class="console-shell" :class="{ 'sidebar-collapsed': collapsed, 'workspace-teams-shell': ['spaces', 'team-create'].includes(page) && !!me }">
    <a class="skip-link" href="#workspace-main">{{ language === 'en' ? 'Skip to content' : '跳到主内容' }}</a>
    <aside class="workspace-sidebar">
      <div class="sidebar-brand-row"><a class="wordmark" href="/console" aria-label="molis AI"><img class="brand-logo" :src="molisLogo" alt="" width="32" height="32" /><span class="sidebar-label">molis AI</span></a><button class="icon-button sidebar-collapse-control" :aria-label="collapsed ? (language === 'en' ? 'Expand sidebar' : '展开导航') : (language === 'en' ? 'Collapse sidebar' : '收起导航')" :title="collapsed ? (language === 'en' ? 'Expand sidebar' : '展开导航') : (language === 'en' ? 'Collapse sidebar' : '收起导航')" :aria-expanded="!collapsed" @click="collapsed = !collapsed"><WorkspaceIcon :name="collapsed ? 'expand' : 'collapse'" /></button></div>
      <p class="nav-caption sidebar-label">{{ language === 'en' ? 'WORKSPACE' : '工作台' }}</p>
      <nav :aria-label="language === 'en' ? 'Main navigation' : '主导航'"><button v-for="key in navigation" :key="key" :title="navLabels[key]" :aria-label="navLabels[key]" :aria-current="page === key ? 'page' : undefined" :disabled="busy || !me" @click="navigatePage(key)"><WorkspaceIcon :name="key" /><span class="sidebar-label">{{ navLabels[key] }}</span></button></nav>
      <UserMenu :pending-count="pendingCount" @refresh-pending="refreshPending" :avatar="me?.avatarUrl" :name="me?.displayName" :email="me?.emails[0]" :busy="busy" :language="language" :collapsed="collapsed" @navigate="navigatePage" @language="language = $event" @logout="logout()" @logout-all="ask(t.allOut, () => finishLogout(true))" @sign-in="signIn" />
    </aside>
    <dialog ref="drawer" class="workspace-drawer" :aria-label="language === 'en' ? 'Navigation menu' : '导航菜单'" @click="event => { if (event.target === drawer) drawer?.close() }"><header><strong>Molis Auth</strong><button class="icon-button" :aria-label="language === 'en' ? 'Close navigation' : '关闭导航'" @click="drawer?.close()"><WorkspaceIcon name="close" /></button></header><nav><button v-for="key in navigation" :key="key" :aria-current="page === key ? 'page' : undefined" :disabled="busy || !me" @click="navigatePage(key)"><WorkspaceIcon :name="key" />{{ navLabels[key] }}</button></nav><UserMenu :pending-count="pendingCount" @refresh-pending="refreshPending" :avatar="me?.avatarUrl" :name="me?.displayName" :email="me?.emails[0]" :busy="busy" :language="language" @navigate="navigatePage" @language="language = $event" @logout="drawer?.close(); logout()" @logout-all="drawer?.close(); ask(t.allOut, () => finishLogout(true))" @sign-in="drawer?.close(); signIn()" /></dialog>
    <dialog ref="navigationDialog" class="console-modal" aria-labelledby="navigation-title" @cancel="cancelNavigation"><section class="console-card"><h2 id="navigation-title">{{ language === 'en' ? 'Unsaved changes' : '有未保存的修改' }}</h2><p>{{ language === 'en' ? 'Changes have not been saved. Stay on this page to finish editing, or continue to another page.' : '修改尚未保存。你可以留在当前页面继续编辑，或确认切换到其他页面。' }}</p><div class="console-actions"><ElButton autofocus @click="cancelNavigation">{{ language === 'en' ? 'Keep editing' : '继续编辑' }}</ElButton><ElButton type="primary" @click="confirmNavigation">{{ language === 'en' ? 'Leave page' : '离开页面' }}</ElButton></div></section></dialog>
    <div class="workspace-body">
    <div class="workspace-mobile-navigation"><button class="icon-button mobile-menu" :aria-label="language === 'en' ? 'Open navigation' : '打开导航'" @click="openDrawer"><WorkspaceIcon name="menu" /></button></div>
    <main id="workspace-main" tabindex="-1" :aria-busy="busy">
      <section v-if="page !== 'account' || !me" class="console-heading" :class="{ 'console-heading-quiet': ['spaces', 'team-create'].includes(page) }"><div><h1>{{ navLabels[page === 'team-create' ? 'spaces' : page] }}</h1><p v-if="!['spaces', 'team-create'].includes(page)">{{ pageDescription }}</p></div>
      </section>
      <p v-if="busy" class="console-muted" role="status">{{ t.checking }}</p>
      <div v-if="failure" class="notice error" role="alert"><p>{{ t.errors[failure.code] ?? t.failed }}</p><small>{{ failure.code }}</small><p v-if="failure.uncertain">{{ t.uncertain }}</p><small v-if="failure.request">{{ t.request }}: {{ failure.request }}</small></div>
      <div v-if="notice" class="notice success" role="status">{{ notice }}</div>
      <section v-if="!enabled && !busy" class="console-card"><p>{{ t.disabled }}</p></section>
      <section v-else-if="!me && !busy" class="console-card console-signin"><h2>{{ t.account }}</h2><ElButton type="primary" :disabled="busy" @click="signIn">{{ t.login }}</ElButton></section>
      <Profile v-if="me && auth && page === 'account'" :user="me" :auth="auth" :language="language" @saved="me = $event" @draft="profileDraft = $event" />
      <Security v-if="me && auth" v-show="page === 'security'" :auth="auth" :language="language" @ended="sessionEnded" />
      <Spaces :key="me?.userId" :user-id="me!.userId" ref="spacesPage" v-if="me && auth" v-show="['spaces', 'team-create'].includes(page)" :creation-page="page === 'team-create'" :creation-busy="createBusy" :auth="auth" :language="language" :personal-avatar="me.avatarUrl" @draft="spaceDraft = $event" @busy="spaceBusy = $event" @create="navigatePage('team-create')" @open-team="id => navigatePage('spaces', true, false, id)">
        <TeamCreate v-if="page === 'team-create'" :auth="auth" :language="language" @draft="createDraft = $event" @busy="createBusy = $event" @back="navigatePage('spaces')" @created="teamCreated" />
      </Spaces>
      <Pending v-if="me && auth" ref="pendingPage" v-show="page === 'pending'" :auth="auth" :language="language" :active="page === 'pending'" @count="pendingCount = $event" @resolved="invitationResolved" />
      <template v-if="administrator && isPlatformPage(page)">
        <PermissionConfiguration v-if="tab === 'permissions' && auth" :auth="auth" :language="language" @draft="permissionDraft = $event" @busy="permissionBusy = $event" />
        <Mail v-if="tab === 'mail' && auth" :auth="auth" :language="language" />
        <template v-if="tab === 'applications' && !selected">
          <section class="console-card"><form class="console-inline" @submit.prevent="createApp"><label>{{ t.newApp }}<input v-model="newName" required maxlength="120" :disabled="busy"></label><ElButton native-type="submit" type="primary" :disabled="busy || !newName.trim()">{{ t.create }}</ElButton></form></section>
          <section class="console-card"><div class="console-actions"><ElButton :disabled="busy" @click="work(() => loadApps())">{{ t.reload }}</ElButton></div>
            <div class="console-table"><table><thead><tr><th>{{ t.name }}</th><th>{{ t.status }}</th><th>{{ t.version }}</th><th></th></tr></thead><tbody><tr v-for="app in apps?.items" :key="app.id"><td>{{ app.name }}<small>{{ app.id }}</small></td><td><StatusTag :value="app.status" /></td><td>{{ app.version }}</td><td><ElButton :disabled="busy" @click="work(() => openApplication(app.id))">{{ t.edit }}</ElButton></td></tr></tbody></table></div>
            <p v-if="!apps?.items.length">{{ t.empty }}</p><div class="console-actions"><ElButton :disabled="busy" @click="work(() => loadApps())">{{ t.first }}</ElButton><ElButton :disabled="busy || !apps?.nextCursor" @click="work(() => loadApps(apps!.nextCursor))">{{ t.next }}</ElButton></div></section>
        </template>
        <template v-if="tab === 'applications' && selected">
          <div class="console-actions"><ElButton :disabled="busy" @click="switchTab('applications')">← {{ t.back }}</ElButton><ElButton :disabled="busy" @click="work(() => openApplication(selected!.id))">{{ t.reload }}</ElButton></div>
          <section class="console-card"><h2>{{ selected.name }}</h2><code>{{ selected.id }}</code><form @submit.prevent="saveApp"><fieldset :disabled="busy"><div class="console-grid"><label>{{ t.name }}<input v-model="appName" required maxlength="120"></label><label>{{ t.status }}<select v-model="appStatus"><option>ACTIVE</option><option>DISABLED</option></select></label></div>
            <h3>{{ t.permissions }}</h3><p class="console-muted">{{ t.fixed }}</p><div class="console-checks"><label v-for="action in catalog" :key="action"><input v-model="appActions" type="checkbox" :value="action">{{ action }}</label></div><ElButton native-type="submit" type="primary" :disabled="busy">{{ t.save }} · v{{ selected.version }}</ElButton></fieldset></form></section>
          <section class="console-card"><h2>{{ t.clients }}</h2><p class="console-muted">{{ t.clientWarning }}</p><div class="console-table"><table><thead><tr><th>{{ t.clientId }}</th><th>{{ t.type }}</th><th>{{ t.status }}</th><th></th></tr></thead><tbody><tr v-for="client in clients?.items" :key="client.id"><td>{{ client.clientId }}</td><td>{{ client.clientType }}</td><td><StatusTag :value="client.status" /></td><td><ElButton :disabled="busy" @click="work(() => editClient(client))">{{ t.edit }}</ElButton></td></tr></tbody></table></div>
            <div class="console-actions"><ElButton :disabled="busy" @click="work(() => loadClients())">{{ t.first }}</ElButton><ElButton :disabled="busy || !clients?.nextCursor" @click="work(() => loadClients(clients!.nextCursor))">{{ t.next }}</ElButton><ElButton :disabled="busy" @click="resetClient">{{ t.newClient }}</ElButton></div>
            <form @submit.prevent="saveClient"><fieldset :disabled="busy"><h3>{{ editingClient ? t.save : t.newClient }}</h3><div class="console-grid"><label>{{ t.clientId }}<input v-model="clientId" required maxlength="100" :disabled="!!editingClient"></label><label>{{ t.type }}<select v-model="clientType" :disabled="!!editingClient"><option>WEB</option><option>MACOS</option><option>CLI</option></select></label><label v-if="editingClient">{{ t.status }}<select v-model="clientStatus"><option>ACTIVE</option><option>DISABLED</option></select></label></div>
              <div class="console-checks"><label v-for="scope in ['account', 'profile']" :key="scope"><input v-model="clientScopes" type="checkbox" :value="scope">{{ scope }}</label></div><label>{{ t.callbacks }}<textarea v-model="redirects" rows="3" required maxlength="21000" placeholder="https://product.example/callback"></textarea></label><ElButton native-type="submit" type="primary" :disabled="busy">{{ editingClient ? t.save : t.create }}</ElButton></fieldset></form></section>
          <section class="console-card"><h2>{{ t.services }}</h2><p class="console-muted">{{ t.serviceWarning }}</p>
            <section v-if="secret" class="console-secret" role="status"><h3>{{ t.once }}</h3><label>{{ t.identity }}<code>{{ secret.clientId }}</code></label><label>{{ t.secret }}<input :type="showSecret ? 'text' : 'password'" :value="secret.value" readonly autocomplete="off" spellcheck="false"></label><label class="console-check"><input v-model="showSecret" type="checkbox">{{ t.show }}</label><ElButton @click="clearSecret">{{ t.dismiss }}</ElButton></section>
            <div class="console-table"><table><thead><tr><th>{{ t.name }}</th><th>{{ t.identity }}</th><th>{{ t.status }}</th><th>{{ t.credential }}</th><th></th></tr></thead><tbody><tr v-for="service in services?.items" :key="service.id"><td>{{ service.name }}</td><td>{{ service.clientId }}</td><td><StatusTag :value="service.status" /></td><td>{{ service.activeCredentialId ?? '—' }}</td><td class="console-actions"><ElButton :disabled="busy || service.status !== 'ACTIVE' || selected.status !== 'ACTIVE'" @click="rotate(service)">{{ t.rotate }}</ElButton><ElButton :disabled="busy || service.status !== 'ACTIVE' || selected.status !== 'ACTIVE'" @click="disable(service)">{{ t.disable }}</ElButton></td></tr></tbody></table></div>
            <div class="console-actions"><ElButton :disabled="busy" @click="work(() => loadServices())">{{ t.first }}</ElButton><ElButton :disabled="busy || !services?.nextCursor" @click="work(() => loadServices(services!.nextCursor))">{{ t.next }}</ElButton></div>
            <form class="console-inline" @submit.prevent="createService"><label>{{ t.newService }}<input v-model="serviceName" required maxlength="200" :disabled="busy"></label><ElButton native-type="submit" type="primary" :disabled="busy || !serviceName.trim() || selected.status !== 'ACTIVE'">{{ t.create }}</ElButton></form></section>
        </template>
        <section v-if="tab === 'users'" class="console-card"><h2>{{ t.users }}</h2><div v-if="selectedUser" class="notice info"><strong>{{ selectedUser.displayName }}</strong><p>{{ t.email }}: {{ selectedUser.emails?.join(', ') || '—' }}</p><code>{{ selectedUser.id }}</code></div>
          <div class="console-table"><table><thead><tr><th>{{ t.name }}</th><th>{{ t.userId }}</th><th>{{ t.status }}</th><th></th></tr></thead><tbody><tr v-for="user in users?.items" :key="user.id"><td>{{ user.displayName }}</td><td>{{ user.id }}</td><td><StatusTag :value="user.status" /></td><td class="console-actions"><ElButton :disabled="busy" @click="work(async () => { selectedUser = await platform(auth!, '/users/' + user.id) })">{{ t.details }}</ElButton><ElButton :disabled="busy" @click="changeUser(user)">{{ user.status === 'ACTIVE' ? t.disable : t.enable }}</ElButton></td></tr></tbody></table></div>
          <div class="console-actions"><ElButton :disabled="busy" @click="work(() => loadUsers())">{{ t.first }}</ElButton><ElButton :disabled="busy || !users?.nextCursor" @click="work(() => loadUsers(users!.nextCursor))">{{ t.next }}</ElButton></div></section>
        <section v-if="tab === 'audit'" class="console-card"><h2>{{ t.audit }}</h2><div class="console-table"><table><thead><tr><th>{{ t.time }}</th><th>{{ t.event }}</th><th>{{ t.outcome }}</th><th>{{ t.actor }}</th><th>{{ t.request }}</th></tr></thead><tbody><tr v-for="event in events?.items" :key="event.id"><td>{{ event.occurredAt }}</td><td>{{ event.action }}<small>{{ event.changeSummary }}</small></td><td><StatusTag :value="event.outcome" /></td><td>{{ event.actorUserId ?? '—' }}</td><td>{{ event.requestId }}</td></tr></tbody></table></div><p v-if="!events?.items.length">{{ t.empty }}</p>
          <div class="console-actions"><ElButton :disabled="busy" @click="work(() => loadAudit())">{{ t.first }}</ElButton><ElButton :disabled="busy || !events?.nextCursor" @click="work(() => loadAudit(events!.nextCursor))">{{ t.next }}</ElButton></div></section>
      </template>
    </main>
    </div>
    <dialog ref="confirmation" class="console-modal" aria-labelledby="confirm-title" @cancel="pending = undefined"><section v-if="pending" class="console-card"><h2 id="confirm-title">{{ pending.label }}</h2><p>{{ t.confirmWarning }}</p><div class="console-actions"><ElButton autofocus @click="pending = undefined">{{ t.cancel }}</ElButton><ElButton type="primary" @click="confirm">{{ t.confirm }}</ElButton></div></section></dialog>
  </div>
</template>
