<script setup lang="ts">
import { lazyComponent } from "../../shared/components/lazy-component.ts";
import { onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type { AccountClient, AccountView } from "../../shared/api/account-client.ts";
import type { WriteOptions } from "../../shared/api/idempotent-submit.ts";
import type { LoginMethod } from "./login-method.ts";

const AccountSecurityEditor = lazyComponent(() => import("./AccountSecurityEditor.vue"));
const AccountPassword = lazyComponent(() => import("./AccountPassword.vue"));
const AccountSessions = lazyComponent(() => import("./AccountSessions.vue"));

const props = defineProps<{
  client: AccountClient;
  user?: AccountView["user"];
  methods: LoginMethod[];
  boundMethodCount: number;
  busy: boolean;
  run: (task: () => Promise<void>) => Promise<void>;
  mutate: <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;
  submitBusyWrite: <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;
  discard: (action: string) => void;
  refreshAccount: () => Promise<void>;
  refreshLoginMethods: () => Promise<void>;
  expireWithToast: (error: unknown) => void;
  logout: (all: boolean) => Promise<void>;
}>();
const securityTab = ref("methods");
const logoutDialog = ref<HTMLDialogElement>();
const logoutTrigger = ref<HTMLButtonElement>();
let disposed = false;

async function selectSecurityTab(value: string) {
  await props.run(async () => {
    await cancelSecurity();
    securityTab.value = value;
  });
}
function discardPasswordWrite() {
  props.discard("change-password");
}

const securityAction = ref(""),
  binding = ref<LoginMethod>(),
  reauth = ref(""),
  newIdentity = ref(false),
  securityIdentity = ref("");
let securityEdits = 0;
watch([securityAction, () => binding.value?.bindingId, reauth, securityIdentity,
  () => props.user?.version], () => {
  securityEdits++;
  props.discard("security");
}, { flush: "sync" });

const authorizationPopup = shallowRef<Window | null>(null);
async function verify(operation: string, item?: LoginMethod) {
  const reserved = operation === 'BIND_METHOD' && ['GOOGLE','GITHUB'].includes(item?.type ?? '') ? window.open('about:blank', '_blank') : null;
  if (reserved) reserved.opener = null;
  await cancelSecurity();
  if (disposed) {
    reserved?.close();
    return;
  }
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
function resetSecurity() {
  authorizationPopup.value?.close();
  authorizationPopup.value = null;
  const handle = reauth.value;
  reauth.value = "";
  securityIdentity.value = "";
  securityAction.value = "";
  newIdentity.value = false;
  return handle;
}
async function cancelSecurity() {
  const handle = resetSecurity();
  if (handle)
    await props.client
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
  await props.refreshAccount();
  await props.refreshLoginMethods();
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
  await props.mutate(
    path,
    {
      reauthHandle: reauth.value,
      expectedVersion: props.user!.version,
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

function resetPage() {
  disposed = true;
  resetSecurity();
}

onBeforeUnmount(resetPage);
defineExpose({ cancelSecurity, resetPage });
</script>

<template>
  <section class="console-card security-page">
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
              v-if="user"
              :client="client"
              :account-version="user.version"
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
                  <p v-for="m in methods.filter(item => item.type === type)" :key="m.bindingId" class="security-method-account">{{ type === 'EMAIL' ? user?.email : m.maskedLabel }}</p>
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
</template>

<style src="./security-page.css"></style>
