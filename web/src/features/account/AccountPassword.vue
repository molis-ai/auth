<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AuthError, type AccountClient } from '../../shared/api/account-client.ts';
import { AuthFlow, FlowCancelled } from '../auth-entry/index.ts';
import { accountErrorMessage } from '../../shared/api/errors.ts';
import type { WriteOptions } from '../../shared/api/idempotent-submit.ts';

const props = defineProps<{
  client: AccountClient;
  accountVersion: number;
  submitWrite: (path: string, body: unknown, options: WriteOptions<unknown>) => Promise<void>;
  discard: () => void;
  onSaved: () => Promise<void>;
}>();
const emit = defineEmits<{ expired: [error: unknown] }>();
const passwordEnabled = ref<boolean>();
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref('');
const loading = ref(true);
const saving = ref(false);
const flow = new AuthFlow();
const statusRequest = new AbortController();
let handle = '';
let proofReady = false;
let generation = 0;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const view = await props.client.request<{ passwordEnabled: boolean }>('/me', undefined, 'GET', undefined, statusRequest.signal);
    if (!statusRequest.signal.aborted) passwordEnabled.value = view.passwordEnabled;
  } catch (cause) {
    if (statusRequest.signal.aborted) return;
    error.value = accountErrorMessage(cause);
    emit('expired', cause);
  } finally {
    if (!statusRequest.signal.aborted) loading.value = false;
  }
}

function cancelHandle(id: string) {
  return props.client.request('/auth/transactions/' + id + '/cancel', {}).then(() => undefined, () => undefined);
}
function resetAuthorization() {
  if (handle) void cancelHandle(handle);
  handle = '';
  proofReady = false;
}
function discardDraft() {
  generation++;
  props.discard();
  resetAuthorization();
}

watch([currentPassword, newPassword, confirmPassword], discardDraft, { flush: 'sync' });
onMounted(load);
onBeforeUnmount(() => {
  flow.dispose();
  statusRequest.abort();
  // A password write already dispatched is allowed to finish for its original account.
  if (!saving.value || !proofReady) discardDraft();
});

async function save() {
  if (saving.value || passwordEnabled.value === undefined) return;
  const length = [...newPassword.value.normalize('NFC')].length;
  if (length < 8 || length > 128) {
    error.value = '请输入 8 到 128 个字符的密码。';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次密码不一致。';
    return;
  }
  const edit = generation;
  saving.value = true;
  error.value = '';
  try {
    if (!proofReady) {
      const authorization = await flow.request(
        () => props.client.request<{ handle: string }>('/reauthentications', {
          method: 'EMAIL_PASSWORD', operation: 'CHANGE_PASSWORD', target: { kind: 'PASSWORD' },
          useSession: true,
          ...(passwordEnabled.value ? { currentPassword: currentPassword.value } : {}),
        }),
        result => cancelHandle(result.handle),
      );
      handle = authorization.handle;
      await flow.request(() => props.client.request('/auth/transactions/' + handle + '/submit', { step: 'COMPLETE' }));
      proofReady = true;
    }
    await props.submitWrite('/password/change', {
      reauthHandle: handle,
      newPassword: newPassword.value,
      expectedVersion: props.accountVersion,
    }, {
      action: 'change-password',
      editGeneration: edit,
      success: '密码已更新',
      refreshMessage: '密码已更新，但账号信息暂未刷新。',
      committed: () => {
        handle = '';
        proofReady = false;
        passwordEnabled.value = true;
        currentPassword.value = '';
        newPassword.value = '';
        confirmPassword.value = '';
      },
      after: props.onSaved,
    });
  } catch (cause) {
    if (!proofReady || (cause instanceof AuthError && ['TRANSACTION_EXPIRED', 'FORBIDDEN'].includes(cause.code))) {
      resetAuthorization();
    }
    if (cause instanceof FlowCancelled || statusRequest.signal.aborted) return;
    error.value = !proofReady && cause instanceof AuthError && cause.code === 'INVALID_CREDENTIALS'
      ? '当前密码不正确。' : accountErrorMessage(cause);
    emit('expired', cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="security-panel-card password-panel" :aria-busy="loading || saving">
    <div class="security-card-head">
      <div>
        <h3>{{ passwordEnabled === false ? '设置密码' : '修改密码' }}</h3>
        <p id="password-rules">密码至少 8 个字符，建议使用较长且独特的密码。</p>
      </div>
      <span v-if="passwordEnabled !== undefined" class="security-method-status" :class="{ 'is-bound': passwordEnabled }">
        {{ passwordEnabled ? '已设置密码' : '未设置密码' }}
      </span>
    </div>
    <p v-if="loading" role="status">正在读取密码状态…</p>
    <p v-if="error" class="password-error" role="alert">{{ error }}</p>
    <button v-if="!loading && passwordEnabled === undefined" type="button" @click="load">重试</button>
    <form v-if="passwordEnabled !== undefined" class="password-form" @submit.prevent="save">
      <label v-if="passwordEnabled">
        当前密码
        <input v-model="currentPassword" :disabled="saving" type="password" autocomplete="current-password"
          placeholder="输入当前密码完成身份确认" maxlength="512" required>
      </label>
      <label>
        新密码
        <input v-model="newPassword" :disabled="saving" type="password" autocomplete="new-password"
          aria-describedby="password-rules" placeholder="输入新密码" maxlength="512" required>
      </label>
      <label>
        确认新密码
        <input v-model="confirmPassword" :disabled="saving" type="password" autocomplete="new-password"
          placeholder="再次输入新密码" maxlength="512" required>
      </label>
      <div><button class="security-primary-btn" type="submit" :disabled="saving">{{ saving ? '正在保存…' : '保存新密码' }}</button></div>
    </form>
  </section>
</template>

<style scoped>
.v2-console .password-panel .password-form {
  display: grid;
  gap: 14px;
  max-width: 440px;
  margin: 0;
}
.v2-console .password-form label {
  display: grid;
  gap: 5px;
  margin: 0;
  color: #3f3f46;
  font-size: 12.5px;
  font-weight: 500;
}
.v2-console .password-form input {
  height: 38px;
  min-height: 38px;
  padding: 0 11px;
  margin: 0;
  border: 1px solid #d5d5db;
  border-radius: 8px;
  background: var(--surface);
  font-size: 13.5px;
  font-weight: 400;
}
.v2-console .password-panel .password-error { margin: 0 0 14px; color: #a62b33; }

@media (max-width: 640px) {
  .v2-console .password-form input { height: 44px; font-size: 16px; }
}
</style>
