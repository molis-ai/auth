<script setup lang="ts">
import { lazyComponent } from "./shared/components/lazy-component.ts";
import { onBeforeUnmount, onErrorCaptured, onMounted, ref, watch } from "vue";
import { reportBrowserError } from "./shared/telemetry.ts";
import AuthEntry from "./features/auth-entry/AuthEntry.vue";
import AuthEntryShell from "./features/auth-entry/AuthEntryShell.vue";
import { entryText } from "./features/auth-entry/entry-copy.ts";
import { entryLanguage } from "./features/auth-entry/entry-preferences.ts";
import { useAccountSession } from "./app/use-account-session.ts";
import { provideAccountContext } from "./shared/api/account-context.ts";
const ConsoleShell = lazyComponent(() => import("./shared/components/ConsoleShell.vue"));
const AccountProfile = lazyComponent(() => import("./features/account/AccountProfile.vue"));
const AccountSecurityPage = lazyComponent(() => import("./features/account/AccountSecurityPage.vue"));
const PlatformUsers = lazyComponent(() => import("./features/platform/PlatformUsers.vue"));
const PlatformTenants = lazyComponent(() => import("./features/platform/PlatformTenants.vue"));
const PlatformAudit = lazyComponent(() => import("./features/platform/PlatformAudit.vue"));
const PlatformApplicationsPage = lazyComponent(() => import("./features/platform/PlatformApplicationsPage.vue"));
const PendingPage = lazyComponent(() => import("./features/team/PendingPage.vue"));
const TenantPage = lazyComponent(() => import("./features/team/TenantPage.vue"));
const BillingCenterPage = lazyComponent(() => import("./features/billing/BillingCenterPage.vue"));
const environmentLabel = document.querySelector<HTMLMetaElement>('meta[name="molis-environment"]')?.content;
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function clearToast() { clearTimeout(toastTimer); toast.value = ""; }
function showToast(text: string) {
  clearToast();
  toast.value = entryText(entryLanguage(), text);
  toastTimer = setTimeout(clearToast, 5000);
}

const consolePages = new Set([
  "account", "security", "tenants", "pending", "subscriptions", "users",
  "platform-tenants", "audit", "applications",
]);
function readLocation() {
  const url = new URL(location.href);
  const target = url.pathname === "/console" ? url.searchParams.get("page") : null;
  return {
    target: target && consolePages.has(target) ? target : "account",
    subjectId: url.searchParams.get("subject") ?? undefined,
  };
}
const initial = readLocation();
const page = ref(initial.target);
const billingSubjectId = ref(initial.target === "subscriptions" ? (initial.subjectId ?? "personal") : "personal");
const platformTenantFocus = ref(initial.target === "platform-tenants" ? initial.subjectId : undefined);
const auditTenantScope = ref<string | null>(initial.target === "audit" ? (initial.subjectId ?? null) : null);
let navigationVersion = 0;
const securityPage = ref<{ cancelSecurity: () => Promise<void>; resetPage: () => void }>();

const {
  account, accountScope, authenticating, boundMethodCount, busy, client, discard, disposePageIssues,
  endingSession, expireAccount, expireWithToast, initializeSession, loggedIn, logout, methods,
  mutate, onLoginEntry, prefetchedCapabilities, refreshAccount, refreshIssues, refreshLoginMethods,
  retryRefresh, run, starting, startup, submitBusyWrite, submitWrite,
} = useAccountSession(page, { clearToast, showToast, resetConsole });

provideAccountContext({
  client, mutate, submitWrite, submitBusyWrite, discard, run, expireAccount, expireWithToast,
});

watch(() => account.value?.user?.userId, (id, previous) => {
  if (id && id !== previous && page.value === "security") void run(refreshLoginMethods);
});

function setPage(target: string, subjectId?: string) {
  billingSubjectId.value = target === "subscriptions" ? (subjectId ?? "personal") : "personal";
  platformTenantFocus.value = target === "platform-tenants" ? subjectId : undefined;
  auditTenantScope.value = target === "audit" ? (subjectId ?? null) : null;
  page.value = target;
}

function resetConsole() {
  navigationVersion++;
  securityPage.value?.resetPage();
  setPage("account");
  if (location.pathname === "/console" && location.search) history.replaceState(null, "", "/console");
}

async function navigate(target: string, subjectId?: string, updateHistory = true) {
  if (!consolePages.has(target)) return;
  const version = ++navigationVersion;
  await securityPage.value?.cancelSecurity();
  if (version !== navigationVersion) return;
  setPage(target, subjectId);
  if (updateHistory) {
    const params = new URLSearchParams({ page: target });
    if (subjectId) params.set("subject", subjectId);
    const path = "/console?" + params;
    if (location.pathname + location.search !== path) history.pushState(null, "", path);
  }
  if (target === "security") {
    securityPage.value?.resetPage();
    await run(refreshLoginMethods);
  } else {
    clearToast();
  }
}

function restoreNavigation() {
  const { target, subjectId } = readLocation();
  void navigate(target, subjectId, false);
}
onErrorCaptured(error => { reportBrowserError("vue_error", error); });
onMounted(() => window.addEventListener("popstate", restoreNavigation));
onBeforeUnmount(() => window.removeEventListener("popstate", restoreNavigation));
function openTeamBilling(tenantId: string) {
  void navigate("subscriptions", tenantId);
}
function openPlatformAudit(tenantId?: string) {
  void navigate("audit", tenantId);
}
function openPlatformTenant(tenantId: string) {
  void navigate("platform-tenants", tenantId);
}
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
        :on-saved="refreshAccount"
        @expired="expireWithToast"
        @navigate="navigate"
      />
      <AccountSecurityPage
        v-if="page === 'security'"
        :key="accountScope"
        ref="securityPage"
        :user="account.user"
        :methods="methods"
        :bound-method-count="boundMethodCount"
        :busy="busy"
        :refresh-account="refreshAccount"
        :refresh-login-methods="refreshLoginMethods"
        :logout="logout"
      />
      <TenantPage
        v-if="page === 'tenants' && account.user"
        :key="accountScope"
        :viewer-id="account.user.userId"
        :billing-enabled="!endingSession"
        :busy="busy"
        :refresh-pending="action => refreshIssues.has(action)"
        @expired="expireWithToast"
        @dispose="disposePageIssues('tenants')"
        @clear-toast="clearToast"
        @open-billing="openTeamBilling"
      />
      <PendingPage
        v-if="page === 'pending' && account.user"
        :key="accountScope"
        :busy="busy"

        @expired="expireWithToast"
        @dispose="disposePageIssues('pending')"
        @navigate="navigate"
      />
      <BillingCenterPage
        v-if="page === 'subscriptions' && account.user && !endingSession"
        :key="accountScope + ':' + billingSubjectId"
        :viewer-id="account.user.userId"
        :viewer-name="account.user.displayName"
        :viewer-email="account.user.email"
        :initial-subject-id="billingSubjectId"
        @expired="expireWithToast"
      />
      <PlatformUsers
        v-if="page === 'users'"
        :capabilities="account.capabilities ?? []"

        @expired="expireWithToast"
      />
      <PlatformTenants
        v-if="page === 'platform-tenants'"
        :key="accountScope"
        :capabilities="account.capabilities ?? []"
        :initial-tenant-id="platformTenantFocus"
        @expired="expireWithToast"
        @notify="showToast"
        @open-audit="openPlatformAudit"
      />
      <PlatformAudit
        v-if="page === 'audit'"
        :key="accountScope"
        :capabilities="account.capabilities ?? []"
        :initial-tenant-scope="auditTenantScope"
        @expired="expireWithToast"
        @notify="showToast"
        @open-tenant="openPlatformTenant"
      />
        <PlatformApplicationsPage
          v-if="page === 'applications'"
          :key="accountScope"
          :capabilities="account.capabilities ?? []"
          :busy="busy"

        />
    </main>
    </div>
  </ConsoleShell>
</template>
<style>
.account-form {
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
