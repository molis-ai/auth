<script setup lang="ts">
import { accountErrorMessage } from "./errors.ts";
import { onBeforeUnmount, ref } from "vue";
import { AccountClient } from "../../sdk/browser/src/index.ts";
const props = defineProps<{
  client: AccountClient;
  purpose?: string;
  operation?: string;
  target?: Record<string, string>;
  parent?: string;
  bindingId?: string;
  identityType?: string;
}>();
const emit = defineEmits<{
  complete: [value: { handle: string; account?: unknown }];
  cancel: [];
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
const method = ref("EMAIL_PASSWORD"),
  address = ref(""),
  password = ref(""),
  confirm = ref(""),
  code = ref(""),
  transaction = ref<Transaction>(),
  challenge = ref(""),
  busy = ref(false),
  failure = ref(""),
  retryAt = ref(0);
let active = true,
  finished = false,
  popup: Window | null = null,
  timer: ReturnType<typeof setTimeout> | undefined;
function clear() {
  password.value = "";
  confirm.value = "";
  code.value = "";
}
async function cancel() {
  clearTimeout(timer);
  popup?.close();
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
  void cancel();
});
async function complete() {
  const t = transaction.value!;
  const result = await props.client.request<Transaction>(
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
      await props.client.request(
        "/auth/transactions/" + value.handle + "/submit",
        { step: "PHONE_LOGIN" },
      ),
    );
  else if (value.nextStep === "COMPLETE") await complete();
}
async function submit() {
  if (busy.value) return;
  if (["GOOGLE", "GITHUB"].includes(method.value) && !transaction.value) {
    popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    if (!popup) {
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
      transaction.value = await props.client.request<Transaction>(
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
      const result = await props.client.request<Transaction>(path, {
        step: "VERIFY_CHALLENGE",
        challengeHandle: challenge.value,
        credential: code.value,
      });
      challenge.value = "";
      code.value = "";
      await progress(result);
    } else if (t.nextStep === "PASSWORD_LOGIN") {
      await progress(
        await props.client.request(path, {
          step: "PASSWORD_LOGIN",
          email: address.value.trim(),
          password: password.value,
        }),
      );
    } else if (t.nextStep === "EMAIL_SIGNUP") {
      if (password.value !== confirm.value) throw Error("两次密码不一致");
      await progress(
        await props.client.request(path, {
          step: "EMAIL_SIGNUP",
          email: address.value.trim(),
          password: password.value,
        }),
      );
    } else if (t.nextStep === "REQUEST_CHALLENGE") {
      const result = await props.client.request<Transaction>(path, {
        step: "REQUEST_CHALLENGE",
        address:
          method.value === "PHONE_OTP"
            ? "+86" + address.value.trim()
            : address.value.trim(),
      });
      challenge.value = result.challengeHandle!;
      retryAt.value = Date.now() + (result.retryAfterSeconds ?? 60) * 1000;
    } else if (t.nextStep === "START_PROVIDER") {
      const result = await props.client.request<Transaction>(path, {
        step: "START_PROVIDER",
      });
      if (!result.browserStartUrl) throw Error("授权地址不可用");
      const url = new URL(result.browserStartUrl);
      if (url.origin !== location.origin) throw Error("授权地址不匹配");
      if (!popup) throw Error("授权窗口不可用");
      popup.location.replace(url.href);
      const poll = async () => {
        if (!active || !transaction.value) return;
        try {
          const status = await props.client.request<Transaction>(
            "/auth/transactions/" + t.handle,
          );
          if (status.account || status.operationReady) {
            clear();
            popup?.close();
            finished = true;
            emit("complete", { ...status, handle: t.handle });
            return;
          }
          if (
            status.status === "CANCELLED" ||
            status.status === "EXPIRED" ||
            popup?.closed
          ) {
            await cancel();
            return;
          }
          timer = setTimeout(() => void poll(), 1000);
        } catch (error) {
          failure.value = accountErrorMessage(error);
        }
      };
      timer = setTimeout(() => void poll(), 500);
    }
  } catch (error) {
    failure.value = accountErrorMessage(error);
  } finally {
    busy.value = false;
  }
}
async function resend() {
  if (!transaction.value || Date.now() < retryAt.value) return;
  busy.value = true;
  try {
    const reply = await props.client.request<Transaction>(
      "/auth/transactions/" + transaction.value.handle + "/resend",
      {},
    );
    challenge.value = reply.challengeHandle ?? challenge.value;
    retryAt.value = Date.now() + (reply.retryAfterSeconds ?? 60) * 1000;
  } catch (e) {
    failure.value = String(e);
  } finally {
    busy.value = false;
  }
}
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
  <form class="console-card v2-form" @submit.prevent="submit">
    <label
      >登录方式<select v-model="method" :disabled="busy || !!transaction">
        <option
          v-for="[value, label] in purposeMethods()"
          :key="value"
          :value="value"
        >
          {{ label }}
        </option>
      </select></label
    >
    <template v-if="!['GOOGLE', 'GITHUB'].includes(method)">
      <label
        >{{ method === "PHONE_OTP" ? "手机号（+86）" : "邮箱"
        }}<input
          v-model="address"
          :type="method === 'PHONE_OTP' ? 'tel' : 'email'"
          :autocomplete="method === 'PHONE_OTP' ? 'tel-national' : 'username'"
          :disabled="busy || !!challenge"
          required
      /></label>
      <p
        v-if="method === 'PHONE_OTP' && !operation && !parent"
        class="console-muted"
      >
        未注册手机号验证后将自动注册。
      </p>
      <template
        v-if="
          method === 'EMAIL_PASSWORD' ||
          transaction?.nextStep === 'EMAIL_SIGNUP'
        "
        ><label
          >密码<input
            v-model="password"
            type="password"
            :autocomplete="
              transaction?.nextStep === 'EMAIL_SIGNUP'
                ? 'new-password'
                : 'current-password'
            "
            required /></label
        ><label v-if="transaction?.nextStep === 'EMAIL_SIGNUP'"
          >确认密码<input
            v-model="confirm"
            type="password"
            autocomplete="new-password"
            required /></label
      ></template>
      <label v-if="challenge"
        >验证码<input
          v-model="code"
          autocomplete="one-time-code"
          inputmode="numeric"
          required
      /></label>
    </template>
    <p v-if="failure" role="alert">{{ failure }}</p>
    <div class="console-actions">
      <button type="submit" :disabled="busy">
        {{
          busy
            ? "正在处理…"
            : challenge
              ? "验证"
              : transaction?.nextStep === "EMAIL_SIGNUP"
                ? "完成注册"
                : "继续"
        }}</button
      ><button v-if="challenge" type="button" :disabled="busy" @click="resend">
        重新发送</button
      ><button
        type="button"
        :disabled="busy"
        @click="cancel().then(() => emit('cancel'))"
      >
        取消
      </button>
    </div>
  </form>
</template>
