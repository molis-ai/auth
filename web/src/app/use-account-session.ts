import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, shallowRef, watch, type Ref } from "vue";
import { AccountClient, AuthError, type AccountView } from "../shared/api/account-client.ts";
import { accountErrorMessage } from "../shared/api/errors.ts";
import { IdempotentSubmit, refreshAfterWrite, type WriteOptions } from "../shared/api/idempotent-submit.ts";
import type { AuthCompletion } from "../features/auth-entry/auth-flow.ts";
import { rememberEmail } from "../features/auth-entry/entry-preferences.ts";
import type { LoginMethod } from "../features/account/login-method.ts";

export function useAccountSession(
  page: Ref<string>,
  { clearToast, showToast, resetConsole }: {
    clearToast: () => void;
    showToast: (message: string) => void;
    resetConsole: () => void;
  },
) {
  const client = new AccountClient(),
    account = ref<AccountView>(),
    busy = ref(false);
  const endingSession = ref(false);
  const startup = ref<'loading' | 'error' | 'ready'>('loading');
  const starting = computed(() => !account.value || startup.value !== 'ready');
  const onLoginEntry = location.pathname === '/login';
  const prefetchedCapabilities = shallowRef<ReturnType<AccountClient['loginCapabilities']>>();
  const SESSION_CHECK_COOLDOWN_MS = 30_000;
  let lastSessionCheckAt: number | undefined;
  const accountGeneration = ref(0);
  let openReported = false;
  let profileMethodsRequested = false;
  let methodsRequest = 0;
  const methods = ref<LoginMethod[]>([]);
  const boundMethodCount = computed(() => {
    const types = new Set(methods.value.map(item => item.type));
    return ["EMAIL", "PHONE", "GOOGLE", "GITHUB"].filter(type => types.has(type)).length;
  });
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
    const scope = accountGeneration.value;
    try {
      await task();
    } catch (e) {
      if (scope !== accountGeneration.value || (e instanceof AuthError && e.code === "CANCELLED")) return;
      expireAccount(e);
      showToast(accountErrorMessage(e));
    } finally {
      busy.value = false;
    }
  }
  async function refreshAccount() {
    const scope = accountGeneration.value;
    let current: AccountView;
    try {
      current = await client.session();
    } finally {
      if (scope !== accountGeneration.value) throw new AuthError("CANCELLED");
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
      accountGeneration.value++;
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
  function scheduleOpenActivity() {
    if (openReported) return;
    const scope = accountGeneration.value;
    openReported = true;
    // Let the profile watcher enqueue its initial read before reporting activity.
    void nextTick(() => {
      if (scope === accountGeneration.value && account.value?.state === "AUTHENTICATED") {
        return reportOpenActivity(scope);
      }
    });
  }
  async function reportOpenActivity(scope: number) {
    try {
      await client.request("/activity", {
        eventId: crypto.randomUUID(),
        kind: "OPEN",
      });
    } catch (error) {
      if (scope === accountGeneration.value) expireWithToast(error);
    }
  }
  async function refreshLoginMethods() {
    const scope = accountGeneration.value;
    const request = ++methodsRequest;
    let data: { loginMethods: LoginMethod[] };
    try {
      data = await client.request("/login-methods");
    } finally {
      if (scope !== accountGeneration.value) throw new AuthError("CANCELLED");
    }
    if (request === methodsRequest) methods.value = data.loginMethods;
  }
  watch([() => account.value?.user?.userId, page], ([userId, target]) => {
    if (!userId || account.value?.state !== "AUTHENTICATED" || target !== "account" || profileMethodsRequested) return;
    profileMethodsRequested = true;
    const scope = accountGeneration.value;
    void refreshLoginMethods().catch(error => {
      if (scope === accountGeneration.value) expireWithToast(error);
    });
  });
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
    const scope = accountGeneration.value;
    await refreshAfterWrite(
      () => submissions.send(action, method, path, editGeneration ?? body,
        key => client.request<T>(path, body, method, key)),
      result => {
        if (scope !== accountGeneration.value) throw new AuthError("CANCELLED");
        refreshIssues.delete(action);
        committed?.(result);
        showToast(success);
      },
      async result => {
        if (scope !== accountGeneration.value) throw new AuthError("CANCELLED");
        await after(result);
      },
      (error, retry) => {
        if (scope !== accountGeneration.value || expireAccount(error) || (error instanceof AuthError && error.code === "CANCELLED")) return;
        refreshIssues.set(action, { page: section, message: refreshMessage, retry });
      },
    );
  }
  function mutate<T>(path: string, body: unknown, options: WriteOptions<T>) {
    return run(() => submitWrite(path, body, options));
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
      const scope = accountGeneration.value;
      await issue.retry();
      if (scope !== accountGeneration.value || refreshIssues.get(action) !== issue) return;
      refreshIssues.delete(action);
      showToast("已刷新");
    });
  }
  function disposePageIssues(target: string) {
    for (const [action, issue] of refreshIssues) {
      if (issue.page === target) refreshIssues.delete(action);
    }
  }
  async function logout(all = false) {
    await run(async () => {
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
    accountGeneration.value++;
    prefetchedCapabilities.value = undefined;
    lastSessionCheckAt = undefined;
    openReported = false;
    profileMethodsRequested = false;
    submissions.setAccount(undefined);
    refreshIssues.clear();
    account.value = next;
    resetConsole();
    methods.value = [];
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
    const scope = accountGeneration.value;
    try {
      const current = await client.session();
      if (scope !== accountGeneration.value || authenticating.value) return;
      lastSessionCheckAt = Date.now();
      if (current.state !== account.value?.state || current.user?.userId !== account.value?.user?.userId) replaceSession();
    } catch (error) {
      if (scope === accountGeneration.value && error instanceof AuthError &&
        ['SESSION_EXPIRED','SESSION_REVOKED','LOGIN_REQUIRED'].includes(error.code)) replaceSession();
    } finally { checking = false; }
  }
  function pageRestored(event: PageTransitionEvent) {
    if (event.persisted) {
      lastSessionCheckAt = undefined;
      void checkSession();
    }
  }
  onMounted(() => {
    void initializeSession();
    window.addEventListener('focus', checkSession);
    document.addEventListener('visibilitychange', checkSession);
    window.addEventListener('pageshow', pageRestored);
  });
  onBeforeUnmount(() => {
    accountGeneration.value++;
    clearToast();
    client.close(); sessionChanges?.close();
    window.removeEventListener('focus', checkSession);
    document.removeEventListener('visibilitychange', checkSession);
    window.removeEventListener('pageshow', pageRestored);
  });

  return {
    client, account, busy, endingSession, startup, starting, onLoginEntry, prefetchedCapabilities,
    accountScope: accountGeneration, authenticating, methods, boundMethodCount,
    refreshIssues, refreshAccount, expireAccount, expireWithToast, run, initializeSession,
    refreshLoginMethods, loggedIn, submitWrite, mutate, submitBusyWrite, retryRefresh,
    discard: (action: string) => submissions.discard(action), disposePageIssues, logout,
  };
}
