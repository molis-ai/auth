<script setup lang="ts">
import { ref, watch } from "vue";
import { AuthError, type AccountClient } from "../lib/account-client.ts";
import { accountErrorMessage } from "../lib/errors.ts";
import type { PlatformDirectoryUser } from "../lib/platform-audit.ts";

const props = defineProps<{
  client: AccountClient;
  label: string;
  canSearch: boolean;
  disabled: boolean;
  exclude?: string;
}>();
const owner = defineModel<string>({ required: true });
const emit = defineEmits<{ expired: [error: unknown] }>();
const query = ref("");
const manual = ref(!props.canSearch);
const users = ref<PlatformDirectoryUser[]>([]);
const loading = ref(false);
const error = ref("");

function setManual() {
  owner.value = "";
  manual.value = !manual.value;
}

watch([query, manual], ([keyword, manualMode], previous, onCleanup) => {
  users.value = [];
  error.value = "";
  loading.value = false;
  if (manualMode) return;

  loading.value = true;
  let current = true;
  const timer = setTimeout(async () => {
    const params = new URLSearchParams({ status: "ACTIVE", limit: "20" });
    if (keyword.trim()) params.set("q", keyword.trim());
    try {
      const page = await props.client.request<{ items: PlatformDirectoryUser[] }>(`/platform/users?${params}`);
      if (current) users.value = page.items.filter(user => user.userId !== props.exclude);
    } catch (cause) {
      if (!current || (cause instanceof AuthError && cause.code === "CANCELLED")) return;
      error.value = accountErrorMessage(cause);
      emit("expired", cause);
    } finally {
      if (current) loading.value = false;
    }
  }, previous.length ? 250 : 0);
  onCleanup(() => {
    current = false;
    clearTimeout(timer);
  });
}, { immediate: true });
</script>

<template>
  <div class="platform-owner-picker">
    <div class="owner-heading">
      <strong>{{ label }}</strong>
      <button v-if="canSearch" type="button" class="owner-mode" :disabled="disabled" @click="setManual">
        {{ manual ? "从用户目录选择" : "输入用户 ID" }}
      </button>
    </div>
    <input
      v-if="manual"
      v-model="owner"
      type="text"
      maxlength="160"
      :aria-label="label"
      :disabled="disabled"
      placeholder="输入活跃账号的用户 ID"
      required
    />
    <template v-else>
      <input
        v-model="query"
        type="search"
        maxlength="128"
        :disabled="disabled"
        aria-label="搜索活跃用户"
        placeholder="按姓名、邮箱或用户 ID 搜索"
        @input="owner = ''"
      />
      <select v-model="owner" :aria-label="label" :disabled="disabled || loading" required>
        <option value="" disabled>{{ loading ? "正在搜索…" : "选择活跃账号" }}</option>
        <option v-for="user in users" :key="user.userId" :value="user.userId">
          {{ user.displayName }}（{{ user.email ?? user.userId }}）
        </option>
      </select>
      <small v-if="error" role="alert">{{ error }}</small>
      <small v-else-if="!loading && users.length === 0">没有找到可选账号</small>
    </template>
  </div>
</template>

<style scoped>
.platform-owner-picker { display: grid; gap: 7px; font-size: 13px; }
.owner-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.platform-owner-picker input, .platform-owner-picker select {
  width: 100%; min-height: 36px; margin: 0; padding: 7px 9px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface);
  color: var(--ink); font: inherit;
}
.platform-owner-picker button.owner-mode {
  min-height: 0; padding: 0; border: 0; background: transparent;
  color: var(--accent); font-size: 12px;
}
.platform-owner-picker small { color: var(--muted); }
</style>
