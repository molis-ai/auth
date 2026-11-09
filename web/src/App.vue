<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import {
  AccountClient,
  AuthError,
  type AccountView,
} from "../../sdk/browser/src/index.ts";
import AuthenticationPanel from "./AuthenticationPanel.vue";
import PlatformUsers from "./PlatformUsers.vue";
import PlatformClients from "./PlatformClients.vue";
import { accountErrorMessage } from "./errors.ts";
import logo from "./assets/molis-logo.png";
const client = new AccountClient(),
  account = ref<AccountView>(),
  busy = ref(false),
  message = ref(""),
  page = ref("account"),
  loginMode = ref("LOGIN"),
  loginOpen = ref(false);
interface Tenant {
  tenantId: string;
  name: string;
  status: string;
  myRole: string;
  membershipId: string;
  version: number;
}
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
interface Member {
  membershipId: string;
  userId: string;
  role: string;
  status: string;
  version: number;
}
const tenants = ref<Tenant[]>([]),
  selectedTenant = ref<Tenant>(),
  members = ref<Member[]>([]),
  applications = ref<Application[]>([]),
  selectedApplication = ref<Application>(),
  methods = ref<Method[]>([]),
  invitations = ref<
    {
      invitationId: string;
      tenantId: string;
      targetSummary: string;
      status: string;
      version: number;
    }[]
  >([]);
const avatar = ref<string | null>(null),
  transfers = ref<
    {
      transferId: string;
      tenantId: string;
      fromMembershipId: string;
      toMembershipId: string;
      status: string;
      version: number;
    }[]
  >([]);
const name = ref(""),
  inviteTarget = ref(""),
  creationMode = ref(""),
  tenantName = ref(""),
  newApplicationName = ref(""),
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
  newPassword = ref(""),
  confirmPassword = ref(""),
  resetHandle = ref("");
function can(capability: string) {
  return account.value?.capabilities?.includes(capability);
}
async function run(task: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    await task();
  } catch (e) {
    if (
      e instanceof AuthError &&
      ["SESSION_EXPIRED", "SESSION_REVOKED", "LOGIN_REQUIRED"].includes(e.code)
    ) {
      account.value = { state: "EXPIRED" };
      page.value = "account";
      securityAction.value = "";
      reauth.value = "";
      newPassword.value = "";
      confirmPassword.value = "";
    }
    message.value = accountErrorMessage(e);
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
async function refresh() {
  account.value = await client.session();
  if (account.value.state === "AUTHENTICATED") {
    name.value = account.value.user!.displayName;
    avatar.value = account.value.user!.avatarUrl;
    loginOpen.value = false;
    await client.request("/activity", {
      eventId: crypto.randomUUID(),
      kind: "OPEN",
    });
  }
}
async function navigate(target: string) {
  await cancelSecurity();
  page.value = target;
  selectedTenant.value = undefined;
  selectedApplication.value = undefined;
  securityAction.value = "";
  await run(async () => {
    if (target === "security") {
      const data = await client.request<{ loginMethods: Method[] }>(
        "/login-methods",
      );
      methods.value = data.loginMethods;
    } else if (target === "tenants") {
      const policy = await client.request<{ mode: string }>(
        "/tenant-creation-policy",
      );
      creationMode.value = policy.mode;
      tenants.value = await list("/tenants");
      invitations.value = await list("/invitations");
      transfers.value = await list("/ownership-transfers");
    } else if (target === "applications")
      applications.value = await list("/platform/applications");
    else if (target === "subscriptions")
      subscriptions.value = await list("/subscriptions");
  });
}
async function loggedIn(value: { handle: string; account?: unknown }) {
  if (loginMode.value === "PASSWORD_RESET" && !value.account) {
    resetHandle.value = value.handle;
    loginOpen.value = false;
    return;
  }
  await run(refresh);
}
async function chooseAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.type !== "image/png" || file.size > 100000) {
    message.value = "请选择小于 100 KB 的 PNG 图片";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    avatar.value = String(reader.result);
  };
  reader.readAsDataURL(file);
}
async function saveProfile() {
  await run(async () => {
    await client.request(
      "/profile",
      {
        displayName: name.value,
        avatarDataUrl: avatar.value,
        expectedVersion: account.value!.user!.version,
      },
      "PATCH",
      crypto.randomUUID(),
    );
    await refresh();
    message.value = "资料已更新";
  });
}
async function selectTenant(t: Tenant) {
  selectedTenant.value = t;
  members.value = [];
  if (t.status === "ACTIVE")
    members.value = await list("/tenants/" + t.tenantId + "/members");
}
async function mutate(
  path: string,
  body: unknown,
  after: () => Promise<void>,
  method = "POST",
) {
  await run(async () => {
    await client.request(path, body, method, crypto.randomUUID());
    await after();
    message.value = "已完成";
  });
}
async function createTenant() {
  await mutate("/tenants", { name: tenantName.value }, async () => {
    tenants.value = await list("/tenants");
    tenantName.value = "";
  });
}
async function openApplication(a: Application) {
  selectedApplication.value = a;
  appName.value = a.name;
  appStatus.value = a.status;
}
async function verify(operation: string, item?: Method) {
  await cancelSecurity();
  binding.value = item;
  securityAction.value = operation;
  reauth.value = "";
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
  const handle = reauth.value;
  reauth.value = "";
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
  if (
    securityAction.value === "BIND_METHOD" ||
    securityAction.value === "REPLACE_METHOD"
  )
    newIdentity.value = true;
  else if (securityAction.value === "UNLINK_METHOD") await finishSecurity();
}
async function finishSecurity(identityHandle?: string) {
  const operation = securityAction.value;
  const path =
    operation === "CHANGE_PASSWORD"
      ? "/password/change"
      : operation === "BIND_METHOD"
        ? "/login-methods/bind"
        : "/login-methods/" +
          binding.value!.bindingId +
          "/" +
          (operation === "REPLACE_METHOD" ? "replace" : "unlink");
  await mutate(
    path,
    {
      reauthHandle: reauth.value,
      expectedVersion: account.value!.user!.version,
      ...(identityHandle ? { identityHandle } : {}),
      ...(operation === "CHANGE_PASSWORD"
        ? { newPassword: newPassword.value }
        : {}),
    },
    async () => {
      newPassword.value = "";
      confirmPassword.value = "";
      securityAction.value = "";
      await refresh();
      methods.value = (
        await client.request<{ loginMethods: Method[] }>("/login-methods")
      ).loginMethods;
    },
  );
}
async function logout(all = false) {
  await run(async () => {
    const result = await client.logout(all);
    account.value = { state: "ANONYMOUS" };
    tenants.value = [];
    members.value = [];
    methods.value = [];
    applications.value = [];
    securityAction.value = "";
    message.value =
      result.remoteRevocation === "CONFIRMED"
        ? "已退出登录"
        : "本机已退出，远端撤销尚未确认";
  });
}
onMounted(() => void run(refresh));
onBeforeUnmount(() => client.close());
</script>
<template>
  <div class="console-shell v2-console">
    <header class="console-header">
      <a href="/" class="v2-brand"
        ><img :src="logo" class="brand-logo" alt="" /><strong class="wordmark"
          >molis 账号</strong
        ></a
      ><span v-if="account?.user">{{ account.user.displayName }}</span>
    </header>
    <p v-if="message" role="status" aria-live="polite" class="console-card">
      {{ message }}
    </p>
    <main v-if="account?.state !== 'AUTHENTICATED'">
      <section class="console-heading">
        <div>
          <h1>一个账号，连接你的工作</h1>
          <p>登录 Molis 账号，管理个人资料、租户与订阅。</p>
        </div>
      </section>
      <nav class="console-actions">
        <button
          :disabled="busy"
          @click="
            loginMode = 'LOGIN';
            loginOpen = true;
          "
        >
          登录</button
        ><button
          :disabled="busy"
          @click="
            loginMode = 'EMAIL_SIGNUP';
            loginOpen = true;
          "
        >
          邮箱注册</button
        ><button
          :disabled="busy"
          @click="
            loginMode = 'PASSWORD_RESET';
            loginOpen = true;
          "
        >
          找回密码
        </button>
      </nav>
      <AuthenticationPanel
        v-if="loginOpen"
        :key="loginMode"
        :client="client"
        :purpose="loginMode"
        @complete="loggedIn"
        @cancel="loginOpen = false"
      />
      <form
        v-if="resetHandle"
        class="console-card"
        @submit.prevent="
          run(async () => {
            if (newPassword !== confirmPassword) throw Error('两次密码不一致');
            await client.request('/password/reset', {
              resetHandle,
              newPassword,
            });
            newPassword = '';
            confirmPassword = '';
            resetHandle = '';
            message = '密码已重设，请登录';
          })
        "
      >
        <label
          >新密码<input
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            required /></label
        ><label
          >确认新密码<input
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            required /></label
        ><button :disabled="busy">重设密码</button>
      </form>
    </main>
    <main v-else>
      <nav class="console-tabs">
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
          {{ label }}</button
        ><button
          v-if="can('USER_READ')"
          :disabled="busy"
          @click="navigate('users')"
        >
          用户与权限</button
        ><button
          v-if="can('APPLICATION_READ')"
          :disabled="busy"
          @click="navigate('applications')"
        >
          应用管理
        </button>
      </nav>
      <section v-if="page === 'account'" class="console-card">
        <h1>个人资料</h1>
        <form @submit.prevent="saveProfile">
          <label>昵称<input v-model="name" maxlength="80" required /></label
          ><label
            >头像（PNG，100 KB 内）<input
              type="file"
              accept="image/png"
              @change="chooseAvatar" /></label
          ><img
            v-if="avatar"
            :src="avatar"
            width="64"
            height="64"
            alt="头像预览"
          /><button v-if="avatar" type="button" @click="avatar = null">
            移除头像</button
          ><button :disabled="busy">保存资料</button>
        </form>
        <div class="console-actions">
          <button :disabled="busy" @click="logout()">退出登录</button
          ><button :disabled="busy" @click="logout(true)">
            退出所有产品和设备
          </button>
        </div>
      </section>
      <section v-if="page === 'security'" class="console-card">
        <h1>账号安全</h1>
        <div v-for="m in methods" :key="m.bindingId" class="v2-row">
          <span>{{ m.type }} · {{ m.maskedLabel }}</span
          ><button :disabled="busy" @click="verify('REPLACE_METHOD', m)">
            换绑</button
          ><button :disabled="busy" @click="verify('UNLINK_METHOD', m)">
            解绑
          </button>
        </div>
        <div class="console-actions">
          <button :disabled="busy" @click="verify('CHANGE_PASSWORD')">
            设置或修改密码</button
          ><button
            :disabled="busy"
            @click="
              verify('BIND_METHOD', {
                bindingId: '',
                type: 'EMAIL',
                maskedLabel: '',
                verified: false,
                usableForLogin: false,
              })
            "
          >
            绑定邮箱</button
          ><button
            :disabled="busy"
            @click="
              verify('BIND_METHOD', {
                bindingId: '',
                type: 'PHONE',
                maskedLabel: '',
                verified: false,
                usableForLogin: false,
              })
            "
          >
            绑定手机</button
          ><button
            :disabled="busy"
            @click="
              verify('BIND_METHOD', {
                bindingId: '',
                type: 'GOOGLE',
                maskedLabel: '',
                verified: false,
                usableForLogin: false,
              })
            "
          >
            绑定 Google</button
          ><button
            :disabled="busy"
            @click="
              verify('BIND_METHOD', {
                bindingId: '',
                type: 'GITHUB',
                maskedLabel: '',
                verified: false,
                usableForLogin: false,
              })
            "
          >
            绑定 GitHub
          </button>
        </div>
        <template v-if="securityAction"
          ><h2>验证当前账号</h2>
          <AuthenticationPanel
            v-if="!reauth"
            :key="
              securityAction +
              (binding?.bindingId ?? '') +
              (binding?.type ?? '')
            "
            :client="client"
            :operation="securityAction"
            :target="target()"
            @complete="verified"
            @cancel="cancelSecurity"
          /><AuthenticationPanel
            v-else-if="newIdentity"
            :key="reauth"
            :client="client"
            :purpose="securityAction === 'BIND_METHOD' ? 'BIND' : 'REPLACE'"
            :parent="reauth"
            :identity-type="binding?.type"
            :binding-id="
              securityAction === 'REPLACE_METHOD'
                ? binding?.bindingId
                : undefined
            "
            @complete="(v) => finishSecurity(v.handle)"
            @cancel="cancelSecurity"
          />
          <form
            v-else-if="securityAction === 'CHANGE_PASSWORD'"
            @submit.prevent="
              newPassword === confirmPassword
                ? finishSecurity()
                : (message = '两次密码不一致')
            "
          >
            <label
              >新密码<input
                v-model="newPassword"
                type="password"
                autocomplete="new-password"
                required /></label
            ><label
              >确认密码<input
                v-model="confirmPassword"
                type="password"
                autocomplete="new-password"
                required /></label
            ><button :disabled="busy">确认修改密码</button>
          </form></template
        >
      </section>
      <section v-if="page === 'tenants'" class="console-card">
        <h1>我的租户</h1>
        <form
          v-if="creationMode === 'SELF_SERVICE'"
          @submit.prevent="createTenant"
        >
          <label
            >租户名称<input
              v-model="tenantName"
              maxlength="80"
              required /></label
          ><button :disabled="busy">创建租户</button>
        </form>
        <p v-else>租户由平台创建并分配。</p>
        <div v-for="t in tenants" :key="t.tenantId" class="v2-row">
          <button :disabled="busy" @click="run(() => selectTenant(t))">
            {{ t.name }}</button
          ><span>{{ t.myRole }} · {{ t.status }}</span>
        </div>
        <template v-if="selectedTenant"
          ><h2>{{ selectedTenant.name }}</h2>
          <button
            v-if="selectedTenant.myRole !== 'OWNER'"
            :disabled="busy"
            @click="
              mutate(
                '/tenants/' + selectedTenant!.tenantId + '/leave',
                {
                  expectedVersion: members.find(
                    (m) => m.membershipId === selectedTenant!.membershipId,
                  )?.version,
                },
                async () => {
                  selectedTenant = undefined;
                  tenants = await list('/tenants');
                },
              )
            "
          >
            退出租户
          </button>
          <div v-for="m in members" :key="m.membershipId" class="v2-row">
            <span>{{ m.userId }} · {{ m.role }}</span
            ><button
              v-if="selectedTenant.myRole === 'OWNER' && m.role !== 'OWNER'"
              :disabled="busy"
              @click="
                mutate(
                  '/tenants/' +
                    selectedTenant!.tenantId +
                    '/ownership-transfers',
                  {
                    targetMembershipId: m.membershipId,
                    expectedVersion: selectedTenant!.version,
                  },
                  async () => {
                    transfers = await list('/ownership-transfers');
                  },
                )
              "
            >
              交接所有权</button
            ><button
              v-if="selectedTenant.myRole === 'OWNER' && m.role !== 'OWNER'"
              :disabled="busy"
              @click="
                mutate(
                  '/tenants/' +
                    selectedTenant!.tenantId +
                    '/members/' +
                    m.membershipId +
                    '/role',
                  {
                    role: m.role === 'ADMIN' ? 'MEMBER' : 'ADMIN',
                    expectedVersion: m.version,
                  },
                  () => selectTenant(selectedTenant!),
                  'PATCH',
                )
              "
            >
              {{ m.role === "ADMIN" ? "设为成员" : "设为管理员" }}</button
            ><button
              v-if="
                ['OWNER', 'ADMIN'].includes(selectedTenant.myRole) &&
                m.role === 'MEMBER'
              "
              :disabled="busy"
              @click="
                mutate(
                  '/tenants/' +
                    selectedTenant!.tenantId +
                    '/members/' +
                    m.membershipId +
                    '/remove',
                  { expectedVersion: m.version },
                  () => selectTenant(selectedTenant!),
                )
              "
            >
              移除
            </button>
          </div>
          <form
            v-if="
              ['OWNER', 'ADMIN'].includes(selectedTenant.myRole) &&
              selectedTenant.status === 'ACTIVE'
            "
            @submit.prevent="
              mutate(
                '/tenants/' + selectedTenant!.tenantId + '/invitations',
                { target: { kind: 'USER', value: inviteTarget } },
                async () => {
                  inviteTarget = '';
                  message = '邀请已发送';
                },
              )
            "
          >
            <label>受邀账号 ID<input v-model="inviteTarget" required /></label
            ><button :disabled="busy">发送邀请</button>
          </form></template
        >
        <div
          v-for="t in transfers.filter((t) => t.status === 'PENDING')"
          :key="t.transferId"
          class="v2-row"
        >
          <span>租户 {{ t.tenantId }} 所有权交接</span
          ><button
            :disabled="busy"
            @click="
              mutate(
                '/ownership-transfers/' +
                  t.transferId +
                  (tenants.find((x) => x.tenantId === t.tenantId)
                    ?.membershipId === t.toMembershipId
                    ? '/accept'
                    : '/cancel'),
                { expectedVersion: t.version },
                async () => {
                  transfers = await list('/ownership-transfers');
                  tenants = await list('/tenants');
                  selectedTenant = undefined;
                },
              )
            "
          >
            {{
              tenants.find((x) => x.tenantId === t.tenantId)?.membershipId ===
              t.toMembershipId
                ? "接受交接"
                : "取消交接"
            }}
          </button>
        </div>
        <h2 v-if="invitations.some((i) => i.status === 'PENDING')">
          收到的邀请
        </h2>
        <div
          v-for="i in invitations.filter((i) => i.status === 'PENDING')"
          :key="i.invitationId"
          class="v2-row"
        >
          <span>{{ i.targetSummary }}</span
          ><button
            :disabled="busy"
            @click="
              mutate(
                '/invitations/' + i.invitationId + '/accept',
                { expectedVersion: i.version },
                async () => {
                  tenants = await list('/tenants');
                  invitations = await list('/invitations');
                },
              )
            "
          >
            加入</button
          ><button
            :disabled="busy"
            @click="
              mutate(
                '/invitations/' + i.invitationId + '/decline',
                { expectedVersion: i.version },
                async () => {
                  invitations = await list('/invitations');
                },
              )
            "
          >
            拒绝
          </button>
        </div>
      </section>
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
      <section v-if="page === 'applications'" class="console-card">
        <h1>应用管理</h1>
        <form
          v-if="can('APPLICATION_WRITE')"
          @submit.prevent="
            mutate(
              '/platform/applications',
              { name: newApplicationName },
              async () => {
                applications = await list('/platform/applications');
                newApplicationName = '';
              },
            )
          "
        >
          <label
            >应用名称<input
              v-model="newApplicationName"
              required
              maxlength="80" /></label
          ><button :disabled="busy">创建应用</button>
        </form>
        <div v-for="a in applications" :key="a.applicationId" class="v2-row">
          <button :disabled="busy" @click="run(() => openApplication(a))">
            {{ a.name }}</button
          ><span>{{ a.status }}</span>
        </div>
        <template v-if="selectedApplication"
          ><h2>{{ selectedApplication.name }}</h2>
          <form
            v-if="can('APPLICATION_WRITE')"
            @submit.prevent="
              mutate(
                '/platform/applications/' + selectedApplication!.applicationId,
                {
                  name: appName,
                  status: appStatus,
                  expectedVersion: selectedApplication!.version,
                },
                async () => {
                  applications = await list('/platform/applications');
                  await openApplication(
                    applications.find(
                      (a) =>
                        a.applicationId === selectedApplication!.applicationId,
                    )!,
                  );
                },
                'PATCH',
              )
            "
          >
            <label>名称<input v-model="appName" required /></label
            ><label
              >应用状态<select v-model="appStatus" aria-label="应用状态">
                <option>ACTIVE</option>
                <option>DISABLED</option>
              </select></label
            ><button :disabled="busy">保存应用</button>
          </form>
          <PlatformClients
            v-if="can('CLIENT_READ') || can('CLIENT_WRITE')"
            :key="selectedApplication.applicationId"
            :application-id="selectedApplication.applicationId"
            :client="client"
            :capabilities="account.capabilities ?? []"
          />
        </template>
      </section>
    </main>
    <footer class="console-muted">Molis · 统一账号</footer>
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
.console-shell button:hover {
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
