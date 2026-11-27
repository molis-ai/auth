<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { AuthError, type AccountClient } from '../../shared/api/account-client.ts';
import { accountErrorMessage } from '../../shared/api/errors.ts';

interface LoginSession {
  productName: string;
  clientType: 'WEB' | 'MACOS' | 'CLI';
  lastActiveAt: string;
  current: boolean;
}
interface SessionList {
  items: LoginSession[];
  hasMore: boolean;
}

const props = defineProps<{ client: AccountClient }>();
const emit = defineEmits<{ expired: [error: unknown] }>();
const controller = new AbortController();
const sessions = ref<SessionList>();
const loading = ref(true);
const error = ref('');
const relative = new Intl.RelativeTimeFormat('zh-CN');
const absolute = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const clientLabels = { WEB: '浏览器', MACOS: 'macOS · 桌面端', CLI: '命令行客户端' };
const userAgent = navigator.userAgent;
const os = userAgent.match(/iPhone|iPad|Android|Macintosh|Windows|Linux/)?.[0];
const systems: Record<string, string> = { iPhone: 'iOS', iPad: 'iPadOS', Macintosh: 'macOS' };
const browser = /(?:Edg|Edge)\/(\d+)/.exec(userAgent) ??
  /(?:Firefox|Chrome|Version)\/(\d+)/.exec(userAgent);
const browserNames: Record<string, string> = { Edg: 'Edge', Version: 'Safari' };
const browserKey = browser?.[0].split('/')[0] ?? '';
const browserLabel = browser ? (browserNames[browserKey] ?? browserKey) + ' ' + browser[1] : '浏览器';
const currentDevice = [os && (systems[os] ?? os), browserLabel].filter(Boolean).join(' · ');

function activityLabel(timestamp: string) {
  const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
  if (elapsed < 60_000) return '刚刚活跃';
  if (elapsed < 3_600_000) return relative.format(-Math.floor(elapsed / 60_000), 'minute') + '活跃';
  if (elapsed < 86_400_000) return relative.format(-Math.floor(elapsed / 3_600_000), 'hour') + '活跃';
  return relative.format(-Math.floor(elapsed / 86_400_000), 'day') + '活跃';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const result = await props.client.request<SessionList>('/login-sessions', undefined, 'GET', undefined, controller.signal);
    if (!controller.signal.aborted) sessions.value = result;
  } catch (cause) {
    if (controller.signal.aborted || (cause instanceof AuthError && cause.code === 'CANCELLED')) return;
    error.value = accountErrorMessage(cause);
    emit('expired', cause);
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <section class="login-session-card security-panel-card" :aria-busy="loading">
    <div class="login-session-table-wrap">
      <table class="login-session-table" aria-label="登录会话">
        <thead>
          <tr>
            <th scope="col">产品</th>
            <th scope="col">设备与客户端</th>
            <th scope="col">位置</th>
            <th scope="col">状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="4" role="status">正在加载会话…</td></tr>
          <tr v-else-if="error"><td colspan="4"><span role="alert">{{ error }}</span> <button type="button" @click="load">重试</button></td></tr>
          <tr v-else-if="!sessions?.items.length"><td colspan="4">暂无有效会话</td></tr>
          <tr v-for="(session, index) in sessions?.items ?? []" v-else :key="index">
            <td class="login-session-product">{{ session.productName }}</td>
            <td class="login-session-client">{{ session.current ? currentDevice : clientLabels[session.clientType] }}</td>
            <td class="login-session-location">未知</td>
            <td>
              <span v-if="session.current" class="security-method-status is-bound">当前会话</span>
              <time v-else class="security-method-status" :datetime="session.lastActiveAt" :title="absolute.format(new Date(session.lastActiveAt))">
                {{ activityLabel(session.lastActiveAt) }}
              </time>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="sessions?.hasMore" class="login-session-note">仅显示最近的 100 条会话。</p>
  </section>
</template>

<style scoped>
.login-session-card { padding: 0; overflow: hidden; }
.login-session-table-wrap { overflow-x: auto; }
.login-session-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.login-session-table th {
  padding: 10px 18px; border-block: 1px solid var(--line);
  background: #fafafb; color: var(--muted); text-align: left;
  font-size: 12px; font-weight: 500; white-space: nowrap;
}
.login-session-table td { padding: 13px 18px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.login-session-table tr:last-child td { border-bottom: 0; }
.login-session-table tbody tr:hover td { background: #fafafc; }
.login-session-product { font-weight: 550; }
.login-session-client { color: #3f3f46; }
.login-session-location { color: var(--muted); white-space: nowrap; }
.login-session-note { margin: 0; padding: 0 18px 12px; }
@media (min-width: 1180px) {
  .login-session-table th:nth-child(1) { width: 29%; }
  .login-session-table th:nth-child(2) { width: 33%; }
  .login-session-table th:nth-child(3) { width: 12%; }
}
@media (max-width: 640px) {
  .login-session-table th, .login-session-table td { padding-inline: 8px; }
}
</style>
