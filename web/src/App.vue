<script setup lang="ts">
import { defineAsyncComponent, onMounted, onBeforeUnmount, ref, shallowReactive, shallowRef, watch } from "vue";
import {
  AccountClient,
  AuthError,
  type AccountView,
} from "./account-client.ts";
import AccountSecurityEditor from "./AccountSecurityEditor.vue";
import AuthEntry from "./AuthEntry.vue";
import AccountProfile from "./AccountProfile.vue";
import { entryText } from "./entry-copy.ts";
import { entryLanguage, rememberEmail } from "./entry-preferences.ts";
import { accountErrorMessage } from "./errors.ts";
import { IdempotentSubmit, refreshAfterWrite, type WriteOptions } from "./idempotent-submit.ts";
import logo from "./assets/molis-logo.png";
const PlatformUsers = defineAsyncComponent(() => import("./PlatformUsers.vue"));
const PlatformClients = defineAsyncComponent(() => import("./PlatformClients.vue"));
const TenantPage = defineAsyncComponent(() => import("./TenantPage.vue"));
const environmentLabel = document.querySelector<HTMLMetaElement>('meta[name="molis-environment"]')?.content;
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function clearToast() { clearTimeout(toastTimer); toast.value = ""; }
function showToast(text: string) {
  clearToast();
  toast.value = entryText(entryLanguage(), text);
  toastTimer = setTimeout(clearToast, 5000);
}
const securityTab = ref('methods');
async function selectSecurityTab(value: string) { await run(async () => { await cancelSecurity(); securityTab.value = value; }); }
const logoutDialog = ref<HTMLDialogElement>();
const logoutTrigger = ref<HTMLButtonElement>();
const applicationSearch = ref("");
const client = new AccountClient(),
  account = ref<AccountView>(),
  busy = ref(false),
  page = ref("account");
interface Application {
  applicationId: string;
  name: string;
  status: string;
  version: number;
}
interface Method {
  bindingId: string;
  type: string;
  maskedLabel: string;
  verified: boolean;
  usableForLogin: boolean;
}
const applications = ref<Application[]>([]),
  selectedApplication = ref<Application>(),
  methods = ref<Method[]>([]);
const newApplicationName = ref(""),
  appName = ref(""),
  appStatus = ref("ACTIVE"),
  subscriptions = ref<
    {
      subscriptionId: string;
      status: string;
      startsAt: string;
      expiresAt: string;
      planId: string;
    }[]
  >([]);
const securityAction = ref(""),
  binding = ref<Method>(),
  reauth = ref(""),
  newIdentity = ref(false),
  securityIdentity = ref(""),
  newPassword = ref(""),
  confirmPassword = ref("");
const submissions = new IdempotentSubmit();
const refreshIssues = shallowReactive(new Map<string, {
  page: string;
  message: string;
  retry: () => Promise<void>;
}>());
watch(() => account.value?.user?.userId, userId => {
  submissions.setAccount(userId);
  refreshIssues.clear();
}, { flush: "sync" });
watch(newApplicationName, () => submissions.discard("create-application"), { flush: "sync" });
watch([appName, appStatus, () => selectedApplication.value?.applicationId, () => selectedApplication.value?.version],
  () => submissions.discard("edit-application"), { flush: "sync" });
let securityEdits = 0;
watch([securityAction, () => binding.value?.bindingId, reauth, securityIdentity, newPassword,
  () => account.value?.user?.version], () => {
  securityEdits++;
  submissions.discard("security");
}, { flush: "sync" });
function can(capability: string) {
  return account.value?.capabilities?.includes(capability);
}
function expireAccount(error: unknown): boolean {
  if (!(error instanceof AuthError) ||
    !["SESSION_EXPIRED", "SESSION_REVOKED", "LOGIN_REQUIRED"].includes(error.code)) return false;
  clearAccount();
  account.value = { state: "EXPIRED" };
  return true;
}
async function run(task: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  clearToast();
  try {
    await task();
  } catch (e) {
    expireAccount(e);
    showToast(accountErrorMessage(e));
  } finally {
    busy.value = false;
  }
}
async function list<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: { items: T[]; nextCursor: string | null } =
      await client.request<{ items: T[]; nextCursor: string | null }>(
        path +
          "?limit=100" +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
    result.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw Error("分页状态发生变化，请刷新");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}
async function refreshAccount() {
  const current = await client.session();
  if (account.value?.user && current.state !== "AUTHENTICATED") {
    throw new AuthError("SESSION_EXPIRED");
  }
  if (account.value?.user && account.value.user.userId !== current.user?.userId) {
    replaceSession();
    throw new AuthError("CANCELLED");
  }
  account.value = current;
  if (current.state === "AUTHENTICATED") {
    methods.value = (await client.request<{ loginMethods: Method[] }>("/login-methods")).loginMethods;
  }
}
async function refresh() {
  await refreshAccount();
  if (account.value?.state === "AUTHENTICATED") {
    await client.request("/activity", {
      eventId: crypto.randomUUID(),
      kind: "OPEN",
    });
  }
}
async function navigate(target: string) {
  await cancelSecurity();
  page.value = target;
  if (target === 'security') securityTab.value = 'methods';
  selectedApplication.value = undefined;
  securityAction.value = "";
  await run(async () => {
    if (target === "security") {
      const data = await client.request<{ loginMethods: Method[] }>(
        "/login-methods",
      );
      methods.value = data.loginMethods;
    } else if (target === "applications")
      applications.value = await list("/platform/applications");
    else if (target === "subscriptions")
      subscriptions.value = await list("/subscriptions");
  });
}
async function loggedIn() {
  clearToast();
  await run(refresh);
  if (account.value?.state === 'AUTHENTICATED') sessionChanges?.postMessage('changed');
}
async function submitWrite<T>(
  path: string,
  body: unknown,
  options: WriteOptions<T>,
) {
  const {
    method = "POST", action = method + " " + path, editGeneration, committed, after,
    success = "已完成", refreshMessage = "操作已完成，但相关数据暂未刷新。",
  } = options;
  const section = page.value;
  await refreshAfterWrite(
    () => submissions.send(action, method, path, editGeneration ?? body,
      key => client.request<T>(path, body, method, key)),
    result => {
      refreshIssues.delete(action);
      committed?.(result);
      showToast(success);
    },
    after,
    (error, retry) => {
      if (expireAccount(error) || (error instanceof AuthError && error.code === "CANCELLED")) return;
      refreshIssues.set(action, { page: section, message: refreshMessage, retry });
    },
  );
}
function mutate<T>(path: string, body: unknown, options: WriteOptions<T>) {
  return run(() => submitWrite(path, body, options));
}
async function submitMemberWrite<T>(path: string, body: unknown, options: WriteOptions<T>) {
  busy.value = true;
  clearToast();
  try {
    await submitWrite(path, body, options);
  } finally {
    busy.value = false;
  }
}
function retryRefresh(action: string) {
  return run(async () => {
    const issue = refreshIssues.get(action);
    if (!issue) return;
    await issue.retry();
    refreshIssues.delete(action);
    showToast("已刷新");
  });
}
function handleTenantError(error: unknown) {
  if (expireAccount(error)) showToast(accountErrorMessage(error));
}
function disposeTenantPage() {
  for (const [action, issue] of refreshIssues) {
    if (issue.page === "tenants") refreshIssues.delete(action);
  }
}
function openApplication(a: Application) {
  selectedApplication.value = a;
  appName.value = a.name;
  appStatus.value = a.status;
}
function createApplication() {
  return mutate<Application>("/platform/applications", { name: newApplicationName.value }, {
    action: "create-application",
    success: "应用已创建",
    refreshMessage: "应用已创建，但应用列表暂未刷新。",
    committed: created => {
      newApplicationName.value = "";
      applications.value = [...applications.value.filter(a => a.applicationId !== created.applicationId), created];
    },
    after: async () => { applications.value = await list("/platform/applications"); },
  });
}
function editApplication() {
  const application = selectedApplication.value;
  if (!application) return;
  return mutate<Application>("/platform/applications/" + application.applicationId, {
    name: appName.value, status: appStatus.value, expectedVersion: application.version,
  }, {
    method: "PATCH",
    action: "edit-application",
    success: "应用已保存",
    refreshMessage: "应用已保存，但应用列表暂未刷新。",
    committed: saved => {
      applications.value = applications.value.map(a => a.applicationId === saved.applicationId ? saved : a);
      openApplication(saved);
    },
    after: async saved => {
      applications.value = await list("/platform/applications");
      const latest = applications.value.find(a => a.applicationId === saved.applicationId);
      if (latest && selectedApplication.value?.applicationId === saved.applicationId &&
        selectedApplication.value.version === saved.version &&
        appName.value === saved.name && appStatus.value === saved.status) openApplication(latest);
    },
  });
}
const authorizationPopup = shallowRef<Window | null>(null);
async function verify(operation: string, item?: Method) {
  const reserved = operation === 'BIND_METHOD' && ['GOOGLE','GITHUB'].includes(item?.type ?? '') ? window.open('about:blank', '_blank') : null;
  if (reserved) reserved.opener = null;
  await cancelSecurity();
  authorizationPopup.value = reserved;
  binding.value = item;
  securityAction.value = operation;
  reauth.value = "";
  securityIdentity.value = "";
  newIdentity.value = false;
}
function target(): Record<string, string> {
  return securityAction.value === "CHANGE_PASSWORD"
    ? { kind: "PASSWORD" }
    : securityAction.value === "BIND_METHOD"
      ? { method: binding.value?.type ?? "EMAIL" }
      : { bindingId: binding.value!.bindingId };
}
async function cancelSecurity() {
  authorizationPopup.value?.close();
  authorizationPopup.value = null;
  const handle = reauth.value;
  reauth.value = "";
  securityIdentity.value = "";
  securityAction.value = "";
  newIdentity.value = false;
  newPassword.value = "";
  confirmPassword.value = "";
  if (handle)
    await client
      .request("/auth/transactions/" + handle + "/cancel", {})
      .catch(() => undefined);
}
async function verified(value: { handle: string }) {
  reauth.value = value.handle;
  if (securityAction.value === "BIND_METHOD")
    newIdentity.value = true;
  else if (securityAction.value === "UNLINK_METHOD") await finishSecurity();
}
async function finishSecurity(identityHandle?: string) {
  const operation = securityAction.value;
  if (identityHandle) {
    securityIdentity.value = identityHandle;
    newIdentity.value = false;
  }
  const path =
    operation === "CHANGE_PASSWORD"
      ? "/password/change"
      : operation === "BIND_METHOD"
        ? "/login-methods/bind"
        : "/login-methods/" +
          binding.value!.bindingId +
          "/" +
          "unlink";
  await mutate(
    path,
    {
      reauthHandle: reauth.value,
      expectedVersion: account.value!.user!.version,
      ...(securityIdentity.value ? { identityHandle: securityIdentity.value } : {}),
      ...(operation === "CHANGE_PASSWORD"
        ? { newPassword: newPassword.value }
        : {}),
    },
    {
      action: "security",
      editGeneration: securityEdits,
      refreshMessage: "安全操作已完成，但账号信息暂未刷新。",
      committed: () => {
        reauth.value = "";
        securityIdentity.value = "";
        newPassword.value = "";
        confirmPassword.value = "";
        securityAction.value = "";
      },
      after: refreshAccount,
    },
  );
}
async function logout(all = false) {
  await run(async () => {
    const result = await client.logout(all);
    clearAccount();
    rememberEmail("");
    sessionChanges?.postMessage('changed');
    if (result.remoteRevocation === "CONFIRMED") {
      clearToast();
      showToast("已退出登录");
    } else showToast("本机已退出，远端撤销尚未确认");
  });
}
function clearAccount() {
  submissions.setAccount(undefined);
  refreshIssues.clear();
  account.value = { state: 'ANONYMOUS' };
  page.value = 'account'; securityTab.value = 'methods';
  applicationSearch.value = '';
  applications.value = []; selectedApplication.value = undefined; methods.value = [];
  subscriptions.value = [];
  newApplicationName.value = ''; appName.value = ''; appStatus.value = 'ACTIVE';
  securityAction.value = ''; binding.value = undefined; reauth.value = '';
  newIdentity.value = false; securityIdentity.value = ''; newPassword.value = ''; confirmPassword.value = '';
}
const sessionChanges = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('molis.auth.session');
const authenticating = ref(false);
let replacing = false, checking = false;
function replaceSession() {
  if (replacing) return;
  replacing = true;
  client.close();
  clearAccount();
  document.getElementById('app')?.setAttribute('inert', '');
  location.replace('/login');
}
if (sessionChanges) sessionChanges.onmessage = () => replaceSession();
async function checkSession() {
  if (busy.value || authenticating.value || checking || replacing || document.visibilityState !== 'visible') return;
  checking = true;
  try {
    const current = await client.session();
    if (authenticating.value) return;
    if (current.state !== account.value?.state || current.user?.userId !== account.value?.user?.userId) replaceSession();
  } catch (error) {
    if (error instanceof AuthError && ['SESSION_EXPIRED','SESSION_REVOKED','LOGIN_REQUIRED'].includes(error.code)) replaceSession();
  } finally { checking = false; }
}
function pageRestored(event: PageTransitionEvent) { if (event.persisted) replaceSession(); }
function pageLeaving() {
  client.close();
  clearAccount();
  const root = document.getElementById('app');
  if (root) root.style.visibility = 'hidden';
}
onMounted(() => {
  void run(refresh);
  window.addEventListener('focus', checkSession);
  document.addEventListener('visibilitychange', checkSession);
  window.addEventListener('pageshow', pageRestored);
  window.addEventListener('pagehide', pageLeaving);
});
onBeforeUnmount(() => {
  clearToast();
  client.close(); sessionChanges?.close();
  window.removeEventListener('focus', checkSession);
  document.removeEventListener('visibilitychange', checkSession);
  window.removeEventListener('pageshow', pageRestored);
  window.removeEventListener('pagehide', pageLeaving);
});
</script>
<template>
  <p v-if="environmentLabel" class="environment-label" role="status">{{ environmentLabel }}</p>
  <Teleport to="body"><div v-if="toast" class="account-toast" role="status" aria-live="polite"><span>{{ toast }}</span><button type="button" class="account-toast-close" :aria-label="entryLanguage() === 'en' ? 'Dismiss notification' : '关闭提示'" @click="clearToast">×</button></div></Teleport>
  <AuthEntry v-if="account?.state !== 'AUTHENTICATED'" :client="client" :busy="busy" @authenticating="authenticating = $event" @complete="loggedIn" />
  <div v-else class="console-shell v2-console">
    <aside class="workspace-sidebar">
      <header class="sidebar-brand-row">
        <a href="/" class="v2-brand"><img :src="logo" class="brand-logo" alt="" /><strong class="wordmark">molis AI</strong></a>
        <span class="sidebar-current-user">{{ account.user?.displayName }}</span>
      </header>
      <p class="nav-caption">工作台</p>
      <nav class="console-tabs" aria-label="账号管理">
        <button
          v-for="[id, label] in [
            ['account', '个人资料'],
            ['security', '账号安全'],
            ['tenants', '租户'],
            ['subscriptions', '订阅'],
          ]"
          :key="id"
          :aria-current="page === id ? 'page' : undefined"
          :disabled="busy"
          @click="navigate(id)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path :d="id === 'tenants' ? 'M4 10h16M10 10v10' : id === 'security' ? 'M9 11V9a3 3 0 0 1 6 0v2M9 11h6v5H9z' : id === 'subscriptions' ? 'M8 9h8M8 13h8M8 17h5' : 'M8 17c0-5 8-5 8 0M12 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4'"/></svg>{{ label }}</button
        ><button
          v-if="can('USER_READ')"
          :aria-current="page === 'users' ? 'page' : undefined"
          :disabled="busy"
          @click="navigate('users')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/></svg>用户与权限</button
        ><button
          v-if="can('APPLICATION_READ')"
          :aria-current="page === 'applications' ? 'page' : undefined"
          :disabled="busy"
          @click="navigate('applications')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>应用管理
        </button>
      </nav>
      <div class="sidebar-bottom">      <button type="button" class="account-menu-trigger" popovertarget="account-menu" aria-label="账号菜单"><span class="account-avatar"><img v-if="account.user?.avatarUrl" :src="account.user.avatarUrl" alt=""><template v-else>{{ account.user?.displayName?.slice(0,1) || 'M' }}</template></span><span class="account-menu-identity"><span class="account-menu-name" :title="account.user?.displayName">{{ account.user?.displayName }}</span><span v-if="account.user?.email" class="account-menu-email" :title="account.user.email">{{ account.user.email }}</span></span><svg class="account-menu-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg></button><div id="account-menu" popover class="account-menu"><button :disabled="busy" @click="logout()">切换账号</button><button :disabled="busy" @click="logout()">退出登录</button></div></div>
    </aside>
    <div class="workspace-body">
    <main>
      <template v-for="[action, issue] in refreshIssues" :key="action">
        <p v-if="issue.page === page" role="status">
          {{ issue.message }}
          <button type="button" :disabled="busy" @click="retryRefresh(action)">刷新</button>
        </p>
      </template>
      <AccountProfile v-if="page === 'account' && account.user" :key="account.user.userId" :user="account.user" :github-account="methods.find(item => item.type === 'GITHUB')?.maskedLabel" :client="client" :on-saved="refresh" @expired="error => { clearAccount(); showToast(accountErrorMessage(error)); }">
      </AccountProfile>
      <section v-if="page === 'security'" class="console-card security-page">
        <div class="collection-layout security-layout">
          <nav class="collection-list security-nav" aria-label="账号安全分类">
            <h1>账号安全</h1>
            <button v-for="[id,label] in [['methods','登录方式'],['password','登录密码'],['sessions','登录会话']]" :key="id" :aria-current="securityTab === id ? 'page' : undefined" :disabled="busy" @click="selectSecurityTab(id)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path v-if="id === 'methods'" d="M4 5h16v14H4zM4 6l8 6 8-6"/><path v-else-if="id === 'password'" d="M6 10h12v11H6zM8 10V7a4 4 0 0 1 8 0v3M12 14v3"/><path v-else d="M3 4h18v13H3zM8 21h8M12 17v4"/></svg>{{ label }}</button>
          </nav>
          <div class="collection-detail">
            <section v-if="securityTab === 'sessions'" class="session-actions"><h2>登录会话</h2><p>退出当前账号在所有产品和设备上的登录。</p><button ref="logoutTrigger" :disabled="busy" @click="logoutDialog?.showModal()">退出所有产品和设备</button></section>
            <dialog ref="logoutDialog" class="logout-confirm" aria-labelledby="logout-confirm-title" @close="logoutTrigger?.focus()"><h2 id="logout-confirm-title">退出所有产品和设备？</h2><p>包括当前设备，之后需要重新登录。</p><div class="console-actions"><button autofocus @click="logoutDialog?.close()">取消</button><button :disabled="busy" @click="logoutDialog?.close(); logout(true)">确认退出</button></div></dialog>
            <section v-if="securityTab === 'password'"><h2>登录密码</h2><p>设置或修改用于账号登录的密码。</p><button :disabled="busy" @click="verify('CHANGE_PASSWORD')">设置或修改密码</button></section>
            <section v-if="securityTab === 'methods'"><h2>登录方式</h2>
              <div v-for="[type,label,action] in [['EMAIL','邮箱','绑定邮箱'],['PHONE','手机号','绑定手机'],['GOOGLE','Google','绑定 Google'],['GITHUB','GitHub','绑定 GitHub']]" :key="type" class="security-method" :class="{ 'is-editing-phone': type === 'PHONE' && binding?.type === 'PHONE' && securityAction === 'BIND_METHOD' }">
                <div class="security-method-info">
                <h3>{{ label }}<span v-if="type === 'EMAIL'" class="security-info"><button type="button" class="security-info-trigger" aria-label="邮箱维护说明" aria-describedby="email-management-tip"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7v4"/><circle cx="8" cy="4.8" r=".6" fill="currentColor" stroke="none"/></svg></button><span id="email-management-tip" role="tooltip" class="security-info-tip">邮箱由管理员维护，如需修改请联系管理员。</span></span></h3>
                  <p v-for="m in methods.filter(item => item.type === type)" :key="m.bindingId" class="security-method-account">{{ type === 'EMAIL' ? account.user?.email : m.maskedLabel }}</p>
                  <p v-if="!methods.some(item => item.type === type)" class="security-method-account">-</p>
                </div>
                <div class="security-method-controls">
                <template v-if="!(securityAction && binding?.type === type)">
                  <div v-for="m in methods.filter(item => item.type === type && type !== 'EMAIL')" :key="m.bindingId" class="security-method-actions">
                    <button :disabled="busy" @click="verify('UNLINK_METHOD',m)">解绑</button>
                  </div>
                  <div v-if="type !== 'EMAIL' && !methods.some(item => item.type === type)" class="security-method-actions">
                    <button :disabled="busy" @click="verify('BIND_METHOD',{bindingId:'',type,maskedLabel:'',verified:false,usableForLogin:false})">{{ action }}</button>
                  </div>
                </template>
                  <span class="security-method-status" :class="{ 'is-bound': methods.some(item => item.type === type) }" role="status">
                    <span class="security-status-dot" aria-hidden="true"></span>
                    {{ methods.some(item => item.type === type) ? '已绑定' : '未绑定' }}
                  </span>
                </div>
                <AccountSecurityEditor v-if="securityAction && binding?.type === type" :key="securityAction + (binding?.bindingId ?? '') + (binding?.type ?? '')" :client="client" :authorization-popup="authorizationPopup" :security-action="securityAction" :reauth="reauth" :new-identity="newIdentity" :binding="binding" :target="target()" :busy="busy" v-model:new-password="newPassword" v-model:confirm-password="confirmPassword" @verified="verified" @cancel="cancelSecurity" @finish="finishSecurity" />
              </div>
            </section>
<AccountSecurityEditor v-if="securityAction === 'CHANGE_PASSWORD' && securityTab === 'password'" :key="securityAction + (binding?.bindingId ?? '') + (binding?.type ?? '')" :client="client" :authorization-popup="authorizationPopup" :security-action="securityAction" :reauth="reauth" :new-identity="newIdentity" :binding="binding" :target="target()" :busy="busy" v-model:new-password="newPassword" v-model:confirm-password="confirmPassword" @verified="verified" @cancel="cancelSecurity" @finish="finishSecurity" />
          </div>
        </div>
      </section>
      <TenantPage
        v-if="page === 'tenants'"
        :client="client"
        :busy="busy"
        :mutate="mutate"
        :submit-write="submitMemberWrite"
        :discard="action => submissions.discard(action)"
        :refresh-pending="action => refreshIssues.has(action)"
        @expired="handleTenantError"
        @dispose="disposeTenantPage"
        @clear-toast="clearToast"
      />
      <section v-if="page === 'subscriptions'" class="console-card">
        <h1>个人订阅</h1>
        <p v-if="!subscriptions.length">暂无订阅。</p>
        <article
          v-for="s in subscriptions"
          :key="s.subscriptionId"
          class="v2-row"
        >
          <strong>{{ s.planId }}</strong
          ><span>{{ s.status }}</span
          ><span>{{ s.startsAt }} — {{ s.expiresAt }}</span>
        </article>
      </section>
      <PlatformUsers
        v-if="page === 'users'"
        :client="client"
        :capabilities="account.capabilities ?? []"
      />
      <section v-if="page === 'applications'" class="console-card collection-page">
        <h1>应用管理</h1>
        <div class="collection-layout"><aside class="collection-list" aria-label="应用列表">
        <input v-model="applicationSearch" type="search" aria-label="搜索应用" placeholder="搜索应用" />
        <form
          v-if="can('APPLICATION_WRITE')"
          @submit.prevent="createApplication"
        >
          <label
            >应用名称<input
              v-model="newApplicationName"
              :disabled="busy"
              required
              maxlength="80" /></label
          ><button :disabled="busy">创建应用</button>
        </form>
        <div v-for="a in applications.filter(a => a.name.toLowerCase().includes(applicationSearch.toLowerCase()))" :key="a.applicationId" class="v2-row collection-item" :class="{ selected: selectedApplication?.applicationId === a.applicationId }">
          <button :disabled="busy" @click="openApplication(a)">
            {{ a.name }}</button
          ><span>{{ a.status }}</span>
        </div>
        </aside><div class="collection-detail">
        <p v-if="!selectedApplication" class="collection-empty">选择一个应用，管理资料与客户端</p>
        <template v-if="selectedApplication">
          <div class="detail-heading"><span class="detail-avatar">{{ selectedApplication.name.slice(0,1) }}</span><div><h2>{{ selectedApplication.name }}</h2><p>{{ selectedApplication.status }}</p></div></div>
          <form
            v-if="can('APPLICATION_WRITE')"
            @submit.prevent="editApplication"
          >
            <label>名称<input v-model="appName" :disabled="busy" required /></label
            ><label
              >应用状态<select v-model="appStatus" :disabled="busy" aria-label="应用状态">
                <option>ACTIVE</option>
                <option>DISABLED</option>
              </select></label
            ><button :disabled="busy || (appName === selectedApplication.name && appStatus === selectedApplication.status)">保存应用</button>
          </form>
          <PlatformClients
            v-if="can('CLIENT_READ') || can('CLIENT_WRITE')"
            :key="selectedApplication.applicationId"
            :application-id="selectedApplication.applicationId"
            :client="client"
            :capabilities="account.capabilities ?? []"
          />
        </template>
        </div></div>
      </section>
    </main>
    </div>
  </div>
</template>
<style>
.console-shell.v2-console {
  display: block;
  min-height: 100svh;
}
.v2-console,
.v2-console * {
  box-sizing: border-box;
}
.v2-console > .console-header {
  flex-wrap: wrap;
}
.v2-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  text-decoration: none;
}
.v2-row {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
}
.console-shell button {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 14px;
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
  min-height: 40px;
}
.console-shell button:enabled:hover {
  background: var(--accent-soft);
}
.console-shell button:disabled {
  cursor: wait;
  opacity: 0.55;
}
.v2-form {
  max-width: 520px;
}
.console-tabs {
  flex-wrap: wrap;
}
.console-shell footer {
  margin-top: 30px;
}
</style>

<style scoped>
.environment-label {
  position: fixed;
  right: max(12px, env(safe-area-inset-right));
  bottom: max(12px, env(safe-area-inset-bottom));
  z-index: 1000;
  margin: 0;
  padding: 3px 9px;
  border: 1px solid rgba(255, 255, 255, .28);
  border-radius: 999px;
  background: #343943;
  color: #fff;
  font: 500 11px/16px system-ui, sans-serif;
  letter-spacing: .02em;
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}
</style>
