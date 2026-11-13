<script setup lang="ts">
import { AuthFlow, FlowCancelled } from "./auth-flow.ts";
import { accountErrorMessage } from "./errors.ts";
import { onBeforeUnmount, onMounted, nextTick, ref, watch } from "vue";
import { entryText } from "./entry-copy.ts";
import { rememberedEmail, rememberEmail } from "./entry-preferences.ts";
import { AccountClient } from "../../sdk/browser/src/index.ts";
const props = defineProps<{
  client: AccountClient;
  authorizationPopup?: Window | null;
  purpose?: string;
  operation?: string;
  target?: Record<string, string>;
  parent?: string;
  bindingId?: string;
  identityType?: string;
  entry?: boolean;
  language?: string;
  blocked?: boolean;
}>();
const emit = defineEmits<{
  complete: [value: { handle: string; account?: unknown }];
  cancel: [];
  busy: [value: boolean];
}>();
interface Transaction {
  handle: string;
  status?: string;
  nextStep: string;
  challengeHandle?: string;
  retryAfterSeconds?: number;
  account?: unknown;
  operationReady?: boolean;
  browserStartUrl?: string;
}
const phoneBinding = props.identityType === "PHONE" && ["BIND", "REPLACE"].includes(props.purpose ?? "");
const phoneInput = ref<HTMLInputElement>(), codeInput = ref<HTMLInputElement>();
const method = ref("EMAIL_PASSWORD"),
  address = ref(props.entry ? rememberedEmail() : ""),
  password = ref(""),
  confirm = ref(""),
  code = ref(""),
  transaction = ref<Transaction>(),
  challenge = ref(""),
  busy = ref(false),
  failure = ref(""),
  retryAt = ref(0);
const t = (text: string) => props.entry ? entryText(props.language, text) : text;
const remember = ref(Boolean(address.value)), showPassword = ref(false), now = ref(Date.now()), providerPending = ref(false);
const countdown = setInterval(() => { now.value = Date.now(); }, 1000);
watch(busy, value => emit('busy', value));
watch(remember, value => { if (!value && props.entry) rememberEmail(''); });
async function chooseMethod(value: string) {
  if (busy.value || props.blocked || providerPending.value || method.value === value) return;
  busy.value = true;
  try {
    await cancel();
    if (!active) return;
    retryAt.value = 0;
    address.value = value === 'EMAIL_PASSWORD' ? rememberedEmail() : '';
    method.value = value; failure.value = ''; password.value = ''; confirm.value = ''; showPassword.value = false;
  } finally {
    busy.value = false;
  }
  await nextTick();
  if (active && ['GOOGLE', 'GITHUB'].includes(value)) void submit();
}
let active = true, finished = false;
const flow = new AuthFlow();
function request<T = Transaction>(path: string, body?: unknown): Promise<T> {
  return flow.request(() => props.client.request<T>(path, body), async (value) => {
    const handle = (value as { handle?: string })?.handle;
    if (handle) await props.client.request('/auth/transactions/' + handle + '/cancel', {}).catch(() => undefined);
  });
}
function clear() {
  password.value = "";
  confirm.value = "";
  code.value = "";
}
async function cancel() {
  providerPending.value = false;
  flow.cancel();
  const old = transaction.value;
  transaction.value = undefined;
  challenge.value = "";
  clear();
  if (old && !finished)
    await props.client
      .request("/auth/transactions/" + old.handle + "/cancel", {})
      .catch(() => undefined);
}
onBeforeUnmount(() => {
  active = false;
  flow.dispose();
  clearInterval(countdown);
  void cancel();
});
async function complete() {
  const t = transaction.value!;
  const result = await request<Transaction>(
    "/auth/transactions/" + t.handle + "/submit",
    { step: "COMPLETE" },
  );
  if (!active) return;
  clear();
  finished = true;
  emit("complete", { ...result, handle: t.handle });
}
async function progress(value: Transaction) {
  if (!active) return;
  transaction.value = { ...transaction.value, ...value };
  if (value.nextStep === "PHONE_LOGIN")
    await progress(
      await request(
        "/auth/transactions/" + value.handle + "/submit",
        { step: "PHONE_LOGIN" },
      ),
    );
  else if (value.nextStep === "COMPLETE") await complete();
}
async function submit() {
  if (busy.value || props.blocked || providerPending.value) return;
  if (phoneBinding && !challenge.value && !/^1[3-9]\d{9}$/.test(address.value.trim())) {
    failure.value = "请输入正确的 11 位手机号";
    phoneInput.value?.focus();
    return;
  }
  if (props.entry && method.value === 'EMAIL_PASSWORD') rememberEmail(remember.value ? address.value.trim() : '');
  if (["GOOGLE", "GITHUB"].includes(method.value) && !transaction.value) {
    if (!flow.open(props.authorizationPopup)) {
      failure.value = "请允许打开授权窗口";
      return;
    }
  }
  busy.value = true;
  failure.value = "";
  try {
    if (password.value && confirm.value && password.value !== confirm.value)
      throw Error("两次密码不一致");
    if (!transaction.value) {
      const purpose = props.purpose ?? "LOGIN";
      const input = {
        purpose,
        method: method.value,
        ...(props.parent ? { reauthHandle: props.parent } : {}),
        ...(props.bindingId ? { bindingId: props.bindingId } : {}),
      };
      transaction.value = await request<Transaction>(
        props.operation ? "/reauthentications" : "/auth/transactions",
        props.operation
          ? {
              method: method.value,
              operation: props.operation,
              target: props.target,
            }
          : input,
      );
    }
    const t = transaction.value!,
      path = "/auth/transactions/" + t.handle + "/submit";
    if (challenge.value) {
      const result = await request<Transaction>(path, {
        step: "VERIFY_CHALLENGE",
        challengeHandle: challenge.value,
        credential: code.value,
      });
      if (!phoneBinding) challenge.value = "";
      code.value = "";
      await progress(result);
    } else if (t.nextStep === "PASSWORD_LOGIN") {
      await progress(
        await request(path, {
          step: "PASSWORD_LOGIN",
          email: address.value.trim(),
          password: password.value,
        }),
      );
    } else if (t.nextStep === "EMAIL_SIGNUP") {
      if (password.value !== confirm.value) throw Error("两次密码不一致");
      await progress(
        await request(path, {
          step: "EMAIL_SIGNUP",
          email: address.value.trim(),
          password: password.value,
        }),
      );
    } else if (t.nextStep === "REQUEST_CHALLENGE") {
      const result = await request<Transaction>(path, {
        step: "REQUEST_CHALLENGE",
        address:
          method.value === "PHONE_OTP"
            ? "+86" + address.value.trim()
            : address.value.trim(),
      });
      challenge.value = result.challengeHandle!;
      retryAt.value = Date.now() + (result.retryAfterSeconds ?? 60) * 1000;

    } else if (t.nextStep === "START_PROVIDER") {
      const result = await request<Transaction>(path, {
        step: "START_PROVIDER",
      });
      if (!result.browserStartUrl) throw Error("授权地址不可用");
      const url = new URL(result.browserStartUrl);
      if (url.origin !== location.origin) throw Error("授权地址不匹配");
      flow.navigate(url.href);
      providerPending.value = true;
      const poll = async () => {
        if (!active || !transaction.value) return;
        try {
          const status = await request<Transaction>(
            "/auth/transactions/" + t.handle,
          );
          if (status.account || status.operationReady) {
            clear();
            flow.closeWindow();
            finished = true;
            emit("complete", { ...status, handle: t.handle });
            return;
          }
          if (
            status.status === "CANCELLED" ||
            status.status === "EXPIRED" ||
            flow.closed
          ) {
            await cancel();
            return;
          }
          flow.schedule(poll, 1000);
        } catch (error) {
          if (error instanceof FlowCancelled) return;
          providerPending.value = false;
          failure.value = accountErrorMessage(error);
        }
      };
      flow.schedule(poll, 500);
    }
  } catch (error) {
    if (error instanceof FlowCancelled) return;
    failure.value = accountErrorMessage(error);
  } finally {
    busy.value = false;
    if (phoneBinding && challenge.value) { await nextTick(); codeInput.value?.focus(); }
  }
}
async function changePhone() {
  if (busy.value || props.blocked) return;
  busy.value = true;
  await cancel();
  failure.value = "";
  busy.value = false;
  await nextTick();
  phoneInput.value?.focus();
}
async function resend() {
  if (!transaction.value || Date.now() < retryAt.value) return;
  busy.value = true;
  try {
    const reply = await request<Transaction>(
      "/auth/transactions/" + transaction.value.handle + "/resend",
      {},
    );
    challenge.value = reply.challengeHandle ?? challenge.value;
    retryAt.value = Date.now() + (reply.retryAfterSeconds ?? 60) * 1000;
  } catch (e) {
    if (e instanceof FlowCancelled) return;
    failure.value = accountErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
const checkingSession = ref(Boolean(props.operation));
async function prepareOperation() {
  if (!props.operation || busy.value) return;
  checkingSession.value = true;
  failure.value = "";
  busy.value = true;
  try {
    const recent = await request<Transaction>("/reauthentications", {
      method: "EMAIL_PASSWORD", operation: props.operation, target: props.target, useSession: true,
    });
    if (!active) {
      await request("/auth/transactions/" + recent.handle + "/cancel", {}).catch(() => undefined);
      return;
    }
    if (recent.nextStep === "COMPLETE") await progress(recent);
    else {
      await request("/auth/transactions/" + recent.handle + "/cancel", {});
      throw Error("无法开始操作，请重试");
    }
  } catch (error) {
    if (error instanceof FlowCancelled) return;
    if (active) failure.value = accountErrorMessage(error);
  } finally {
        checkingSession.value = false;
    busy.value = false;
  }
}
onMounted(() => {
  if (phoneBinding) phoneInput.value?.focus();
  if (['BIND', 'REPLACE'].includes(props.purpose ?? '') && ['GOOGLE', 'GITHUB'].includes(method.value)) void submit();
  else void prepareOperation();
});
const purposeMethods = () =>
  props.identityType
    ? [
        [
          props.identityType === "EMAIL"
            ? "EMAIL_CODE"
            : props.identityType === "PHONE"
              ? "PHONE_OTP"
              : props.identityType,
          props.identityType,
        ],
      ]
    : props.purpose === "EMAIL_SIGNUP" || props.purpose === "PASSWORD_RESET"
      ? [["EMAIL_CODE", "邮箱验证码"]]
      : props.purpose === "BIND" || props.purpose === "REPLACE"
        ? [
            ["EMAIL_CODE", "邮箱验证码"],
            ["PHONE_OTP", "手机验证码"],
            ["GOOGLE", "Google"],
            ["GITHUB", "GitHub"],
          ]
        : [
            ["EMAIL_PASSWORD", "邮箱密码"],
            ["PHONE_OTP", "手机验证码"],
            ["GOOGLE", "Google"],
            ["GITHUB", "GitHub"],
          ];
if (
  props.purpose === "EMAIL_SIGNUP" ||
  props.purpose === "PASSWORD_RESET" ||
  props.purpose === "BIND" ||
  props.purpose === "REPLACE"
)
  method.value =
    props.identityType === "PHONE"
      ? "PHONE_OTP"
      : props.identityType && props.identityType !== "EMAIL"
        ? props.identityType
        : "EMAIL_CODE";
</script>
<template>
  <form :class="entry ? 'entry-auth-form v2-form' : 'console-card v2-form'" :aria-busy="busy" @submit.prevent="submit">
    <template v-if="entry">
      <nav v-if="purpose === 'LOGIN'" class="login-methods" :aria-label="t('登录方式')">
        <button type="button" class="login-method" :class="{current: !['GOOGLE','GITHUB'].includes(method)}" :aria-current="!['GOOGLE','GITHUB'].includes(method) ? 'true' : undefined" :disabled="busy || blocked || providerPending" @click="chooseMethod('EMAIL_PASSWORD')">{{ t('账号登录') }}</button>
        <button v-for="provider in ['GOOGLE','GITHUB']" :key="provider" type="button" class="login-method" :class="{current: method === provider}" :disabled="busy || blocked || providerPending" @click="chooseMethod(provider)">{{ provider === 'GOOGLE' ? 'Google' : 'GitHub' }}</button>
        <button type="button" class="login-method" disabled>Apple<small>{{ t('暂不可用') }}</small></button>
      </nav>
      <div class="login-welcome"><p v-if="purpose === 'LOGIN'">{{ t('欢迎使用 molis AI') }}</p><div v-else class="panel-heading"><h2>{{ t(purpose === 'EMAIL_SIGNUP' ? '邮箱注册' : '找回密码') }}</h2><p>{{ t(purpose === 'EMAIL_SIGNUP' ? '输入邮箱，验证后设置密码。' : '验证邮箱后，重新设置你的密码。') }}</p></div></div>
    </template>
    <div v-if="checkingSession" class="session-check-placeholder" aria-busy="true"></div>
    <div v-else-if="operation && failure"><p v-if="failure" role="alert" class="notice error">{{ failure }}</p><div class="console-actions"><button type="button" @click="prepareOperation">重试</button><button type="button" @click="emit('cancel')">取消</button></div></div>
    <div v-else-if="operation" class="session-check-placeholder" aria-busy="true"></div>
    <div v-else-if="phoneBinding" class="phone-binding">
      <div v-if="challenge" class="phone-delivery">
        <span role="status">验证码已发送至 +86 {{ address.trim().slice(0,3) }}****{{ address.trim().slice(-4) }}</span>
        <button type="button" class="phone-text-action" :disabled="busy || blocked" @click="changePhone">更换号码</button>
      </div>
      <div class="phone-binding-line" :class="{'phone-verification-line':challenge}">
        <label v-if="!challenge" class="phone-number"><span class="visually-hidden">手机号</span><span aria-hidden="true" class="phone-prefix">+86</span><input ref="phoneInput" v-model="address" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="请输入手机号" maxlength="11" :disabled="busy || blocked" required></label>
        <label v-else class="phone-code"><span class="visually-hidden">验证码</span><input ref="codeInput" v-model="code" placeholder="输入 6 位验证码" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" :disabled="busy || blocked" required></label>
        <button v-if="!challenge" type="submit" :disabled="busy || blocked">{{ busy ? '发送中…' : '获取验证码' }}</button>
        <button v-else type="submit" class="phone-bind-submit" :disabled="busy || blocked || code.length !== 6">{{ busy || blocked ? '绑定中…' : purpose === 'REPLACE' ? '确认换绑' : '绑定' }}</button>
        <button type="button" class="phone-bind-cancel" :disabled="busy || blocked" @click="cancel().then(() => emit('cancel'))">取消</button>
      </div>
      <div v-if="challenge" class="phone-resend">
        <span v-if="now < retryAt">{{ Math.ceil((retryAt-now)/1000) }} 秒后可重新发送</span>
        <button v-else type="button" class="phone-text-action" :disabled="busy || blocked" @click="resend">重新发送验证码</button>
      </div>
      <p v-if="failure" class="notice error" role="alert">{{ failure }}</p>
    </div>
    <div v-else :class="{ 'entry-content': entry }">
      <label v-if="!entry && !identityType">登录方式<select v-model="method" :disabled="busy || !!transaction"><option v-for="[value,label] in purposeMethods()" :key="value" :value="value">{{ label }}</option></select></label>
      <div v-else-if="purpose === 'LOGIN' && !['GOOGLE','GITHUB'].includes(method)" class="account-methods" :aria-label="t('登录方式')">
        <button v-for="[value,label] in [['EMAIL_PASSWORD','邮箱密码'],['PHONE_OTP','手机验证码']]" :key="value" type="button" class="text-button" :aria-pressed="method === value" :disabled="busy || blocked || providerPending" @click="chooseMethod(value)">{{ t(label) }}</button>
      </div>
      <template v-if="!['GOOGLE', 'GITHUB'].includes(method)">
        <label class="field login-field"><span :class="{ 'visually-hidden': entry && purpose === 'LOGIN' }">{{ t(method === 'PHONE_OTP' ? '手机号（+86）' : '邮箱') }}</span><input v-model="address" :type="method === 'PHONE_OTP' ? 'tel' : 'email'" :autocomplete="method === 'PHONE_OTP' ? 'tel-national' : 'username'" :placeholder="method === 'PHONE_OTP' ? t('手机号（+86）') : t('邮箱')" :disabled="busy || blocked || !!challenge" required></label>
        <p v-if="method === 'PHONE_OTP' && !operation && !parent" class="field-hint">{{ t('未注册手机号验证后将自动注册。') }}</p>
        <template v-if="method === 'EMAIL_PASSWORD' || transaction?.nextStep === 'EMAIL_SIGNUP'">
          <label class="field login-field"><span :class="{ 'visually-hidden': entry && purpose === 'LOGIN' }">{{ t('密码') }}</span><span class="password-input"><input v-model="password" :placeholder="t('密码')" :type="showPassword ? 'text' : 'password'" :autocomplete="transaction?.nextStep === 'EMAIL_SIGNUP' ? 'new-password' : 'current-password'" :disabled="busy || blocked" required><button v-if="entry" type="button" class="password-toggle" :aria-label="t(showPassword ? '隐藏密码' : '显示密码')" :aria-pressed="showPassword" @click="showPassword = !showPassword"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path v-if="showPassword" d="m3 3 18 18"/></svg></button></span></label>
          <label v-if="transaction?.nextStep === 'EMAIL_SIGNUP'" class="field login-field">{{ t('确认密码') }}<input v-model="confirm" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" :disabled="busy || blocked" required></label>
        </template>
        <label v-if="challenge" class="field login-field">{{ t('验证码') }}<input v-model="code" autocomplete="one-time-code" inputmode="numeric" :disabled="busy || blocked" required></label>
      </template>

      <p v-if="failure" class="notice error" role="alert">{{ t(failure) }}</p>
      <div :class="entry ? 'entry-actions' : 'console-actions'">
        <button type="submit" :class="{'entry-primary':entry}" :disabled="busy || blocked || providerPending">{{ t(providerPending ? '正在等待授权…' : busy ? '正在处理…' : challenge ? '验证' : transaction?.nextStep === 'EMAIL_SIGNUP' ? '完成注册' : entry && purpose === 'LOGIN' && method === 'EMAIL_PASSWORD' ? '登录' : '继续') }}</button>
        <button v-if="challenge" type="button" :class="{'text-button':entry}" :disabled="busy || blocked || now < retryAt" @click="resend">{{ t('重新发送') }}<span v-if="now < retryAt"> ({{ Math.ceil((retryAt-now)/1000) }}s)</span></button>
        <button v-if="!entry || transaction" type="button" :class="{'text-button':entry}" :disabled="busy || blocked" @click="cancel().then(() => entry && purpose === 'LOGIN' ? chooseMethod('EMAIL_PASSWORD') : emit('cancel'))">{{ t(entry ? '使用其他方式' : '取消') }}</button>
      </div>
      <label v-if="entry && purpose === 'LOGIN' && method === 'EMAIL_PASSWORD'" class="remember-email"><input v-model="remember" type="checkbox" :disabled="busy || blocked">{{ t('记住邮箱') }}</label>
    </div>
  </form>
</template>
