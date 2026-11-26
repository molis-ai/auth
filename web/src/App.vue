<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onBeforeUnmount, ref, shallowReactive, shallowRef, watch } from "vue";
import {
  AccountClient,
  AuthError,
  type AccountView,
} from "./lib/account-client.ts";
import type { AuthCompletion } from "./lib/auth-flow.ts";
import AuthEntry from "./components/AuthEntry.vue";
import AuthEntryShell from "./components/AuthEntryShell.vue";
import { entryText } from "./lib/entry-copy.ts";
import { entryLanguage, rememberEmail } from "./lib/entry-preferences.ts";
import { accountErrorMessage } from "./lib/errors.ts";
import { IdempotentSubmit, refreshAfterWrite, type WriteOptions } from "./lib/idempotent-submit.ts";
const ConsoleShell = defineAsyncComponent(() => import("./components/ConsoleShell.vue"));
const AccountProfile = defineAsyncComponent(() => import("./components/AccountProfile.vue"));
const AccountSecurityEditor = defineAsyncComponent(() => import("./components/AccountSecurityEditor.vue"));
const AccountPassword = defineAsyncComponent(() => import("./components/AccountPassword.vue"));
const AccountSessions = defineAsyncComponent(() => import("./components/AccountSessions.vue"));
const PlatformUsers = defineAsyncComponent(() => import("./components/PlatformUsers.vue"));
const PlatformClients = defineAsyncComponent(() => import("./components/PlatformClients.vue"));
const PendingPage = defineAsyncComponent(() => import("./components/PendingPage.vue"));
const TenantPage = defineAsyncComponent(() => import("./components/TenantPage.vue"));
const BillingCenterPage = defineAsyncComponent(() => import("./components/BillingCenterPage.vue"));
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
const endingSession = ref(false);
const startup = ref<'loading' | 'error' | 'ready'>('loading');
const starting = computed(() => !account.value || startup.value !== 'ready');
const onLoginEntry = location.pathname === '/login';
const prefetchedCapabilities = shallowRef<ReturnType<AccountClient['loginCapabilities']>>();
const SESSION_CHECK_COOLDOWN_MS = 30_000;
const OPEN_ACTIVITY_DELAY_MS = 150;
let lastSessionCheckAt: number | undefined;
let accountScope = 0;
let openReported = false;
let openActivityTimer: ReturnType<typeof setTimeout> | undefined;
let profileMethodsRequested = false;
let methodsRequest = 0;
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
  methods = ref<Method[]>([]),
  billingSubjectId = ref("personal");
const boundMethodCount = computed(() => {
  const types = new Set(methods.value.map(item => item.type));
  return ["EMAIL", "PHONE", "GOOGLE", "GITHUB"].filter(type => types.has(type)).length;
});
const newApplicationName = ref(""),
  appName = ref(""),
  appStatus = ref("ACTIVE");
const securityAction = ref(""),
  binding = ref<Method>(),
  reauth = ref(""),
  newIdentity = ref(false),
  securityIdentity = ref("");
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
watch([securityAction, () => binding.value?.bindingId, reauth, securityIdentity,
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
  clearAccount({ state: "EXPIRED" });
  return true;
}
function expireWithToast(error: unknown) {
  if (expireAccount(error)) showToast(accountErrorMessage(error));
}
async function run(task: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  clearToast();
  const scope = accountScope;
  try {
    await task();
  } catch (e) {
    if (scope !== accountScope || (e instanceof AuthError && e.code === "CANCELLED")) return;
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
  const scope = accountScope;
  let current: AccountView;
  try {
    current = await client.session();
  } finally {
    if (scope !== accountScope) throw new AuthError("CANCELLED");
  }
  if (account.value?.user && current.state !== "AUTHENTICATED") {
    throw new AuthError("SESSION_EXPIRED");
  }
  if (account.value?.user && account.value.user.userId !== current.user?.userId) {
    replaceSession();
    throw new AuthError("CANCELLED");
  }
  confirmAccount(current);
}
function confirmAccount(current: AccountView) {
  if (current.state !== account.value?.state || current.user?.userId !== account.value?.user?.userId) {
    accountScope++;
    cancelOpenActivity();
    openReported = false;
  }
  lastSessionCheckAt = Date.now();
  account.value = current;
  if (current.state === "AUTHENTICATED") {
    document.documentElement.lang = 'zh-CN';
    prefetchedCapabilities.value = undefined;
    scheduleOpenActivity();
  }
}
async function initializeSession() {
  if (busy.value || account.value || replacing) return;
  busy.value = true;
  startup.value = 'loading';
  const session = refreshAccount();
  const capabilities = onLoginEntry ? client.loginCapabilities() : undefined;
  // The session decides whether this request is needed. Handle rejection even when it is discarded.
  void capabilities?.catch(() => undefined);
  prefetchedCapabilities.value = capabilities;
  try {
    await session;
  } catch (error) {
    if (error instanceof AuthError && error.code === "CANCELLED") return;
    if (!expireAccount(error)) {
      prefetchedCapabilities.value = undefined;
      startup.value = 'error';
      return;
    }
    prefetchedCapabilities.value = capabilities;
  } finally {
    busy.value = false;
  }
  startup.value = 'ready';
}
function cancelOpenActivity() {
  clearTimeout(openActivityTimer);
  openActivityTimer = undefined;
}
function scheduleOpenActivity() {
  if (openReported || openActivityTimer !== undefined) return;
  const scope = accountScope;
  // Let the account watcher queue the initial login-methods read before this write.
  openActivityTimer = setTimeout(() => {
    openActivityTimer = undefined;
    if (scope !== accountScope || account.value?.state !== "AUTHENTICATED") return;
    openReported = true;
    void reportOpenActivity(scope);
  }, OPEN_ACTIVITY_DELAY_MS);
}
async function reportOpenActivity(scope: number) {
  try {
    await client.request("/activity", {
      eventId: crypto.randomUUID(),
      kind: "OPEN",
    });
  } catch (error) {
    if (scope === accountScope) expireWithToast(error);
  }
}
async function refreshLoginMethods() {
  const scope = accountScope;
  const request = ++methodsRequest;
  let data: { loginMethods: Method[] };
  try {
    data = await client.request("/login-methods");
  } finally {
    if (scope !== accountScope) throw new AuthError("CANCELLED");
  }
  if (request === methodsRequest) methods.value = data.loginMethods;
}
watch([() => account.value?.user?.userId, page], ([userId, target]) => {
  if (!userId || account.value?.state !== "AUTHENTICATED" || target !== "account" || profileMethodsRequested) return;
  profileMethodsRequested = true;
  const scope = accountScope;
  void refreshLoginMethods().catch(error => {
    if (scope === accountScope) expireWithToast(error);
  });
});
async function navigate(target: string, subjectId?: string) {
  await cancelSecurity();
  billingSubjectId.value = target === "subscriptions" ? (subjectId ?? "personal") : "personal";
  page.value = target;
  if (target === 'security') securityTab.value = 'methods';
  selectedApplication.value = undefined;
  securityAction.value = "";
  await run(async () => {
    if (target === "security") await refreshLoginMethods();
    else if (target === "applications") {
      applications.value = await list("/platform/applications");
      if (!selectedApplication.value && applications.value[0]) openApplication(applications.value[0]);
    }
  });
}
function openTeamBilling(tenantId: string) {
  void navigate("subscriptions", tenantId);
}
async function loggedIn({ account: current }: AuthCompletion) {
  clearToast();
  const user = current?.user;
  if (current?.state === "AUTHENTICATED" && user?.userId &&
    typeof user.displayName === "string" && typeof user.version === "number" &&
    (user.avatarUrl === null || typeof user.avatarUrl === "string") &&
    Array.isArray(current.capabilities)) {
    confirmAccount(current);
  } else await run(refreshAccount);
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
  const scope = accountScope;
  await refreshAfterWrite(
    () => submissions.send(action, method, path, editGeneration ?? body,
      key => client.request<T>(path, body, method, key)),
    result => {
      if (scope !== accountScope) throw new AuthError("CANCELLED");
      refreshIssues.delete(action);
      committed?.(result);
      showToast(success);
    },
    async result => {
      if (scope !== accountScope) throw new AuthError("CANCELLED");
      await after(result);
    },
    (error, retry) => {
      if (scope !== accountScope || expireAccount(error) || (error instanceof AuthError && error.code === "CANCELLED")) return;
      refreshIssues.set(action, { page: section, message: refreshMessage, retry });
    },
  );
}
function mutate<T>(path: string, body: unknown, options: WriteOptions<T>) {
  return run(() => submitWrite(path, body, options));
}
function discardPasswordWrite() {
  submissions.discard("change-password");
}
async function submitBusyWrite<T>(path: string, body: unknown, options: WriteOptions<T>) {
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
    const scope = accountScope;
    await issue.retry();
    if (scope !== accountScope || refreshIssues.get(action) !== issue) return;
    refreshIssues.delete(action);
    showToast("已刷新");
  });
}
function handleTenantError(error: unknown) {
  if (expireAccount(error)) showToast(accountErrorMessage(error));
}
function disposePageIssues(target: string) {
  for (const [action, issue] of refreshIssues) {
    if (issue.page === target) refreshIssues.delete(action);
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
  return securityAction.value === "BIND_METHOD"
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
async function refreshSecurityAccount() {
  await refreshAccount();
  await refreshLoginMethods();
}
async function finishSecurity(identityHandle?: string) {
  const operation = securityAction.value;
  if (identityHandle) {
    securityIdentity.value = identityHandle;
    newIdentity.value = false;
  }
  const path =
    operation === "BIND_METHOD" ? "/login-methods/bind"
      : "/login-methods/" + binding.value!.bindingId + "/unlink";
  await mutate(
    path,
    {
      reauthHandle: reauth.value,
      expectedVersion: account.value!.user!.version,
      ...(securityIdentity.value ? { identityHandle: securityIdentity.value } : {}),
    },
    {
      action: "security",
      editGeneration: securityEdits,
      refreshMessage: "安全操作已完成，但账号信息暂未刷新。",
      committed: () => {
        reauth.value = "";
        securityIdentity.value = "";
        securityAction.value = "";
      },
      after: refreshSecurityAccount,
    },
  );
}
async function logout(all = false) {
  await run(async () => {
    cancelOpenActivity();
    endingSession.value = true;
    let result: Awaited<ReturnType<AccountClient["logout"]>>;
    try {
      result = await client.logout(all);
    } finally {
      endingSession.value = false;
    }
    clearAccount();
    rememberEmail("");
    sessionChanges?.postMessage('changed');
    if (result.remoteRevocation === "CONFIRMED") {
      clearToast();
      showToast("已退出登录");
    } else showToast("本机已退出，远端撤销尚未确认");
  });
}
function clearAccount(next: AccountView = { state: "ANONYMOUS" }) {
  accountScope++;
  cancelOpenActivity();
  prefetchedCapabilities.value = undefined;
  lastSessionCheckAt = undefined;
  openReported = false;
  profileMethodsRequested = false;
  submissions.setAccount(undefined);
  refreshIssues.clear();
  account.value = next;
  page.value = 'account'; securityTab.value = 'methods';
  applicationSearch.value = '';
  applications.value = []; selectedApplication.value = undefined; methods.value = [];
  newApplicationName.value = ''; appName.value = ''; appStatus.value = 'ACTIVE';
  securityAction.value = ''; binding.value = undefined; reauth.value = '';
  newIdentity.value = false; securityIdentity.value = '';
  authorizationPopup.value?.close();
  authorizationPopup.value = null;
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
  if (!account.value || busy.value || authenticating.value || checking || replacing || document.visibilityState !== 'visible') return;
  if (lastSessionCheckAt !== undefined && Date.now() - lastSessionCheckAt < SESSION_CHECK_COOLDOWN_MS) return;
  checking = true;
  const scope = accountScope;
  try {
    const current = await client.session();
    if (scope !== accountScope || authenticating.value) return;
    lastSessionCheckAt = Date.now();
    if (current.state !== account.value?.state || current.user?.userId !== account.value?.user?.userId) replaceSession();
  } catch (error) {
    if (scope === accountScope && error instanceof AuthError &&
      ['SESSION_EXPIRED','SESSION_REVOKED','LOGIN_REQUIRED'].includes(error.code)) replaceSession();
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
  void initializeSession();
  window.addEventListener('focus', checkSession);
  document.addEventListener('visibilitychange', checkSession);
  window.addEventListener('pageshow', pageRestored);
  window.addEventListener('pagehide', pageLeaving);
});
onBeforeUnmount(() => {
  accountScope++;
  cancelOpenActivity();
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
  <AuthEntryShell v-if="account?.state !== 'AUTHENTICATED'" :show-chrome="onLoginEntry || !starting" v-slot="{ language, t }">
    <component :is="onLoginEntry ? 'section' : 'main'" v-if="starting" class="session-startup" :class="{ 'panel login-panel': onLoginEntry }" :aria-label="onLoginEntry ? t('登录') : undefined">
      <div v-if="onLoginEntry" class="login-welcome"><p>{{ t('欢迎回来') }}</p></div>
      <div v-if="startup === 'error'" :class="{ 'entry-content entry-load-error': onLoginEntry }">
        <p role="alert" :class="{ 'notice error': onLoginEntry }">{{ t('账号服务暂时不可用，请稍后再试。') }}</p>
        <button type="button" :class="{ 'entry-primary': onLoginEntry }" @click="initializeSession">{{ t('重试') }}</button>
      </div>
      <p v-else :class="{ 'entry-content entry-login-content': onLoginEntry }" role="status">
        <span :class="{ 'visually-hidden': onLoginEntry }">{{ t('正在检查登录状态…') }}</span>
      </p>
    </component>
    <AuthEntry v-else :key="accountScope" :client="client" :busy="busy" :language="language" :prefetched-capabilities="prefetchedCapabilities" @authenticating="authenticating = $event" @complete="loggedIn" />
  </AuthEntryShell>
  <ConsoleShell
    v-else
    :user="account.user"
    :capabilities="account.capabilities ?? []"
    :busy="busy"
    :current-page="page"
    @navigate="navigate"
    @logout="logout()"
  >
    <div class="workspace-body">
    <main>
      <template v-for="[action, issue] in refreshIssues" :key="action">
        <p v-if="issue.page === page" role="status">
          {{ issue.message }}
          <button type="button" :disabled="busy" @click="retryRefresh(action)">刷新</button>
        </p>
      </template>
      <AccountProfile
        v-if="page === 'account' && account.user"
        :key="account.user.userId"
        :user="account.user"
        :github-account="methods.find(item => item.type === 'GITHUB')?.maskedLabel"
        :phone-account="methods.find(item => item.type === 'PHONE')?.maskedLabel"
        :bound-method-count="boundMethodCount"
        :client="client"
        :on-saved="refreshAccount"
        @expired="expireWithToast"
        @navigate="navigate"
      />
      <section v-if="page === 'security'" class="console-card security-page">
        <div class="collection-layout security-layout">
          <aside class="collection-list security-nav" aria-label="账号安全分类">
            <h1>账号安全</h1>
            <div class="security-rail-list">
              <div
                v-for="[id,label,sub] in [
                  ['methods','登录方式',`${boundMethodCount}/4 已绑定`],
                  ['password','登录密码','密码安全管理'],
                  ['sessions','登录会话','多产品独立会话'],
                ]"
                :key="id"
                class="security-rail-item"
                :class="{ 'is-active': securityTab === id }"
                @click="!busy && selectSecurityTab(id)"
              >
                <svg class="security-rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path v-if="id === 'methods'" d="M4 5h16v14H4zM4 6l8 6 8-6"/>
                  <path v-else-if="id === 'password'" d="M6 10h12v11H6zM8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>
                  <path v-else d="M3 4h18v13H3zM8 21h8M12 17v4"/>
                </svg>
                <span class="security-rail-body">
                  <button
                    type="button"
                    class="security-rail-btn"
                    :aria-current="securityTab === id ? 'page' : undefined"
                    :disabled="busy"
                    @click.stop="selectSecurityTab(id)"
                  >{{ label }}</button>
                  <span class="security-rail-sub">{{ sub }}</span>
                </span>
              </div>
            </div>
          </aside>
          <div class="collection-detail">
            <div class="security-detail-inner">
              <template v-if="securityTab === 'sessions'">
                <header class="security-page-head">
                  <div>
                    <h2>登录会话</h2>
                    <p>每个 Molis 产品维护独立会话，你可随时一键注销全部设备</p>
                  </div>
                  <button ref="logoutTrigger" type="button" class="security-danger-btn" :disabled="busy" @click="logoutDialog?.showModal()">退出所有产品和设备</button>
                </header>
                <AccountSessions :client="client" @expired="expireWithToast" />
              </template>
              <dialog
                ref="logoutDialog"
                class="logout-confirm"
                aria-labelledby="logout-confirm-title"
                aria-describedby="logout-confirm-description"
                @close="logoutTrigger?.focus()"
              >
                <header class="logout-confirm-head">
                  <h2 id="logout-confirm-title">退出所有产品和设备？</h2>
                  <button type="button" class="logout-confirm-close" aria-label="关闭" @click="logoutDialog?.close()">×</button>
                </header>
                <p id="logout-confirm-description" class="logout-confirm-body">
                  将立即退出你在 Molis Auth、Molis Work 和 Molis Club 等产品上的所有会话，包括当前设备。
                </p>
                <footer class="logout-confirm-actions">
                  <button type="button" autofocus @click="logoutDialog?.close()">取消</button>
                  <button type="button" class="logout-confirm-submit" :disabled="busy" @click="logoutDialog?.close(); logout(true)">确认退出全部</button>
                </footer>
              </dialog>

              <template v-if="securityTab === 'password'">
                <header class="security-page-head">
                  <div>
                    <h2>登录密码</h2>
                    <p>定期更新高强度密码可提升账号安全性</p>
                  </div>
                </header>
                <AccountPassword
                  v-if="account.user"
                  :client="client"
                  :account-version="account.user.version"
                  :submit-write="submitBusyWrite"
                  :discard="discardPasswordWrite"
                  :on-saved="refreshSecurityAccount"
                  @expired="expireWithToast"
                />
              </template>

              <section v-if="securityTab === 'methods'">
                <header class="security-page-head">
                  <div>
                    <h2>登录方式</h2>
                    <p>绑定多种方式可避免账号失联，建议至少保留 2 种可用登录凭证</p>
                  </div>
                </header>
                <div v-for="[type,label,action] in [['EMAIL','邮箱','绑定邮箱'],['PHONE','手机号','绑定手机'],['GOOGLE','Google','绑定 Google'],['GITHUB','GitHub','绑定 GitHub']]" :key="type" class="security-method" :class="{ 'is-editing-phone': type === 'PHONE' && binding?.type === 'PHONE' && securityAction === 'BIND_METHOD' }">
                  <div class="security-method-head">
                    <span class="security-method-icon" aria-hidden="true">
                      <svg v-if="type === 'EMAIL'" viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/></svg>
                      <svg v-else-if="type === 'PHONE'" viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="6" y="3" width="12" height="18" rx="2.5"/><path d="M11 18h2"/></svg>
                      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
                    </span>
                    <div class="security-method-info">
                      <h3>{{ label }}<span v-if="type === 'EMAIL'" class="security-info"><button type="button" class="security-info-trigger" aria-label="邮箱维护说明" aria-describedby="email-management-tip"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7v4"/><circle cx="8" cy="4.8" r=".6" fill="currentColor" stroke="none"/></svg></button><span id="email-management-tip" role="tooltip" class="security-info-tip">邮箱由管理员维护，如需修改请联系管理员。</span></span></h3>
                      <p v-for="m in methods.filter(item => item.type === type)" :key="m.bindingId" class="security-method-account">{{ type === 'EMAIL' ? account.user?.email : m.maskedLabel }}</p>
                      <p v-if="!methods.some(item => item.type === type)" class="security-method-account">尚未绑定，绑定后可直接用于一键登录</p>
                    </div>
                  </div>
                  <div class="security-method-controls">
                    <span class="security-method-status" :class="{ 'is-bound': methods.some(item => item.type === type) }" role="status">
                      <span class="security-status-dot" aria-hidden="true"></span>
                      {{ methods.some(item => item.type === type) ? '已绑定' : '未绑定' }}
                    </span>
                    <template v-if="!(securityAction && binding?.type === type)">
                      <div v-for="m in methods.filter(item => item.type === type && type !== 'EMAIL')" :key="m.bindingId" class="security-method-actions">
                        <button type="button" :disabled="busy" @click="verify('UNLINK_METHOD',m)">解绑</button>
                      </div>
                      <div v-if="type !== 'EMAIL' && !methods.some(item => item.type === type)" class="security-method-actions">
                        <button type="button" class="is-bind-primary" :disabled="busy" @click="verify('BIND_METHOD',{bindingId:'',type,maskedLabel:'',verified:false,usableForLogin:false})">{{ action }}</button>
                      </div>
                    </template>
                  </div>
                  <AccountSecurityEditor v-if="securityAction && binding?.type === type" :key="securityAction + (binding?.bindingId ?? '') + (binding?.type ?? '')" :client="client" :authorization-popup="authorizationPopup" :security-action="securityAction" :reauth="reauth" :new-identity="newIdentity" :binding="binding" :target="target()" :busy="busy" @verified="verified" @cancel="cancelSecurity" @finish="finishSecurity" />
                </div>
              </section>
            </div>
          </div>
        </div>
      </section>
      <TenantPage
        v-if="page === 'tenants' && account.user"
        :key="accountScope"
        :client="client"
        :viewer-id="account.user.userId"
        :billing-enabled="!endingSession"
        :busy="busy"
        :mutate="mutate"
        :submit-write="submitBusyWrite"
        :discard="action => submissions.discard(action)"
        :refresh-pending="action => refreshIssues.has(action)"
        @expired="handleTenantError"
        @dispose="disposePageIssues('tenants')"
        @clear-toast="clearToast"
        @open-billing="openTeamBilling"
      />
      <PendingPage
        v-if="page === 'pending' && account.user"
        :key="accountScope"
        :client="client"
        :busy="busy"
        :mutate="mutate"
        @expired="handleTenantError"
        @dispose="disposePageIssues('pending')"
        @navigate="navigate"
      />
      <BillingCenterPage
        v-if="page === 'subscriptions' && account.user && !endingSession"
        :key="accountScope + ':' + billingSubjectId"
        :client="client"
        :viewer-id="account.user.userId"
        :viewer-name="account.user.displayName"
        :viewer-email="account.user.email"
        :initial-subject-id="billingSubjectId"
        @expired="expireWithToast"
      />
      <PlatformUsers
        v-if="page === 'users'"
        :client="client"
        :capabilities="account.capabilities ?? []"
      />
      <section v-if="page === 'applications'" class="console-card collection-page applications-page">
        <div class="collection-layout applications-layout">
          <aside class="collection-list applications-rail" aria-label="应用列表">
            <div class="apps-rail-head">
              <h1>应用管理</h1>
              <span class="apps-rail-count">{{ applications.length }}</span>
            </div>
            <input v-model="applicationSearch" type="search" aria-label="搜索应用" placeholder="搜索应用…" />
            <form
              v-if="can('APPLICATION_WRITE')"
              class="app-create-form"
              @submit.prevent="createApplication"
            >
              <label>
                应用名称
                <input
                  v-model="newApplicationName"
                  :disabled="busy"
                  required
                  maxlength="80"
                  placeholder="例如：Molis Studio"
                />
              </label>
              <button class="app-create-submit" :disabled="busy || !newApplicationName.trim()">创建应用</button>
            </form>
            <div class="apps-rail-list">
              <div
                v-for="a in applications.filter(a => a.name.toLowerCase().includes(applicationSearch.toLowerCase()))"
                :key="a.applicationId"
                class="v2-row collection-item app-rail-item"
                :class="{ selected: selectedApplication?.applicationId === a.applicationId }"
                @click="!busy && openApplication(a)"
              >
                <span class="app-avatar-sm" aria-hidden="true">{{ a.name.slice(0, 1) }}</span>
                <div class="app-rail-body">
                  <div class="app-rail-top">
                    <button type="button" class="app-rail-btn" :disabled="busy" @click.stop="openApplication(a)">{{ a.name }}</button>
                    <i class="app-dot" :class="a.status === 'ACTIVE' ? 'is-on' : 'is-off'" aria-hidden="true"></i>
                  </div>
                  <span class="app-rail-sub">{{ a.status }}</span>
                </div>
              </div>
            </div>
          </aside>
          <div class="collection-detail applications-detail">
            <p v-if="!selectedApplication" class="collection-empty">选择一个应用，管理资料与客户端</p>
            <div v-if="selectedApplication" class="applications-detail-inner">
              <header class="detail-heading app-page-head">
                <span class="detail-avatar">{{ selectedApplication.name.slice(0, 1) }}</span>
                <div>
                  <div class="app-head-row">
                    <h2>{{ selectedApplication.name }}</h2>
                    <span class="app-status-pill" :class="selectedApplication.status === 'ACTIVE' ? 'is-active' : 'is-disabled'">
                      <i class="app-status-dot" aria-hidden="true"></i>{{ selectedApplication.status }}
                    </span>
                  </div>
                  <p class="app-head-meta">{{ selectedApplication.applicationId }}</p>
                </div>
              </header>
              <section v-if="can('APPLICATION_WRITE')" class="app-settings-card">
                <div class="app-card-head">
                  <h3>应用基础设置</h3>
                  <p>修改应用显示名称或启停应用登录入口</p>
                </div>
                <form class="app-edit-card" @submit.prevent="editApplication">
                  <label>名称<input v-model="appName" :disabled="busy" required /></label>
                  <label class="app-status-field">
                    应用状态
                    <select v-model="appStatus" :disabled="busy" aria-label="应用状态">
                      <option>ACTIVE</option>
                      <option>DISABLED</option>
                    </select>
                  </label>
                  <button class="app-save-btn" :disabled="busy || (appName === selectedApplication.name && appStatus === selectedApplication.status)">保存应用</button>
                </form>
              </section>
              <PlatformClients
                v-if="can('CLIENT_READ') || can('CLIENT_WRITE')"
                :key="selectedApplication.applicationId"
                :application-id="selectedApplication.applicationId"
                :client="client"
                :capabilities="account.capabilities ?? []"
              />
            </div>
          </div>
        </div>
      </section>
    </main>
    </div>
  </ConsoleShell>
</template>
<style>
.v2-form {
  max-width: 520px;
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
