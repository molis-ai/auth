<script setup lang="ts">
import { defineAsyncComponent, ref } from "vue";
import AuthEntry from "./features/auth-entry/AuthEntry.vue";
import AuthEntryShell from "./features/auth-entry/AuthEntryShell.vue";
import { entryText } from "./features/auth-entry/entry-copy.ts";
import { entryLanguage } from "./features/auth-entry/entry-preferences.ts";
import { useAccountSession } from "./app/use-account-session.ts";
const ConsoleShell = defineAsyncComponent(() => import("./shared/components/ConsoleShell.vue"));
const AccountProfile = defineAsyncComponent(() => import("./features/account/AccountProfile.vue"));
const AccountSecurityPage = defineAsyncComponent(() => import("./features/account/AccountSecurityPage.vue"));
const PlatformUsers = defineAsyncComponent(() => import("./features/platform/PlatformUsers.vue"));
const PlatformTenants = defineAsyncComponent(() => import("./features/platform/PlatformTenants.vue"));
const PlatformAudit = defineAsyncComponent(() => import("./features/platform/PlatformAudit.vue"));
const PlatformApplicationsPage = defineAsyncComponent(() => import("./features/platform/PlatformApplicationsPage.vue"));
const PendingPage = defineAsyncComponent(() => import("./features/team/PendingPage.vue"));
const TenantPage = defineAsyncComponent(() => import("./features/team/TenantPage.vue"));
const BillingCenterPage = defineAsyncComponent(() => import("./features/billing/BillingCenterPage.vue"));
const environmentLabel = document.querySelector<HTMLMetaElement>('meta[name="molis-environment"]')?.content;
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function clearToast() { clearTimeout(toastTimer); toast.value = ""; }
function showToast(text: string) {
  clearToast();
  toast.value = entryText(entryLanguage(), text);
  toastTimer = setTimeout(clearToast, 5000);
}

const page = ref("account");
const billingSubjectId = ref("personal");
const platformTenantFocus = ref<string>();
const auditTenantScope = ref<string | null>(null);
const applicationVisit = ref(0);
const securityVisit = ref(0);
const securityPage = ref<{ cancelSecurity: () => Promise<void>; resetPage: () => void }>();

const {
  account, accountScope, authenticating, boundMethodCount, busy, client, discard, disposePageIssues,
  endingSession, expireAccount, expireWithToast, initializeSession, loggedIn, logout, methods,
  mutate, onLoginEntry, prefetchedCapabilities, refreshAccount, refreshIssues, refreshLoginMethods,
  retryRefresh, run, starting, startup, submitBusyWrite, submitWrite,
} = useAccountSession(page, { clearToast, showToast, resetConsole });

function resetConsole() {
  securityPage.value?.resetPage();
  page.value = "account";
  platformTenantFocus.value = undefined;
  auditTenantScope.value = null;
}

async function navigate(target: string, subjectId?: string) {
  await securityPage.value?.cancelSecurity();
  billingSubjectId.value = target === "subscriptions" ? (subjectId ?? "personal") : "personal";
  platformTenantFocus.value = target === "platform-tenants" ? subjectId : undefined;
  auditTenantScope.value = target === "audit" ? (subjectId ?? null) : null;
  page.value = target;
  if (target === "security") {
    securityVisit.value++;
    await run(refreshLoginMethods);
  } else if (target === "applications") {
    applicationVisit.value++;
  } else {
    clearToast();
  }
}
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
        :client="client"
        :on-saved="refreshAccount"
        @expired="expireWithToast"
        @navigate="navigate"
      />
      <AccountSecurityPage
        v-if="page === 'security'"
        :key="accountScope + ':' + securityVisit"
        ref="securityPage"
        :client="client"
        :user="account.user"
        :methods="methods"
        :bound-method-count="boundMethodCount"
        :busy="busy"
        :run="run"
        :mutate="mutate"
        :submit-busy-write="submitBusyWrite"
        :discard="discard"
        :refresh-account="refreshAccount"
        :refresh-login-methods="refreshLoginMethods"
        :expire-with-toast="expireWithToast"
        :logout="logout"
      />
      <TenantPage
        v-if="page === 'tenants' && account.user"
        :key="accountScope"
        :client="client"
        :viewer-id="account.user.userId"
        :billing-enabled="!endingSession"
        :busy="busy"
        :mutate="mutate"
        :submit-write="submitBusyWrite"
        :discard="discard"
        :refresh-pending="action => refreshIssues.has(action)"
        @expired="expireWithToast"
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
        @expired="expireWithToast"
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
        :submit-write="submitWrite"
        @expired="expireWithToast"
      />
      <PlatformTenants
        v-if="page === 'platform-tenants'"
        :key="accountScope"
        :client="client"
        :capabilities="account.capabilities ?? []"
        :submit-write="submitWrite"
        :initial-tenant-id="platformTenantFocus"
        @expired="expireWithToast"
        @notify="showToast"
        @open-audit="openPlatformAudit"
      />
      <PlatformAudit
        v-if="page === 'audit'"
        :key="accountScope"
        :client="client"
        :capabilities="account.capabilities ?? []"
        :initial-tenant-scope="auditTenantScope"
        @expired="expireWithToast"
        @notify="showToast"
        @open-tenant="openPlatformTenant"
      />
      <KeepAlive>
        <PlatformApplicationsPage
          v-if="page === 'applications'"
          :key="accountScope"
          :visit="applicationVisit"
          :client="client"
          :capabilities="account.capabilities ?? []"
          :busy="busy"
          :run="run"
          :submit-write="submitWrite"
          :submit-busy-write="submitBusyWrite"
          :mutate="mutate"
          :discard="discard"
          :expire-account="expireAccount"
          :expire-with-toast="expireWithToast"
        />
      </KeepAlive>
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
