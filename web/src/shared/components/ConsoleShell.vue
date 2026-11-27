<script setup lang="ts">
import { computed } from "vue";
import type { AccountView } from "../api/account-client.ts";
import "../styles/workspace-console.css";
import "../styles/collection-feedback.css";

const props = defineProps<{
  user?: AccountView["user"];
  capabilities: readonly string[];
  busy: boolean;
  currentPage: string;
}>();
const emit = defineEmits<{ navigate: [page: string]; logout: [] }>();

const workbenchItems = [
  { id: "account", label: "个人资料" },
  { id: "security", label: "账号安全" },
  { id: "tenants", label: "团队" },
  { id: "subscriptions", label: "订阅与账单" },
  { id: "pending", label: "待处理" },
];
const platformItems = [
  { id: "users", label: "用户与权限", capability: "USER_READ" },
  { id: "platform-tenants", label: "团队管理", capability: "TENANT_READ" },
  { id: "applications", label: "应用管理", capability: "APPLICATION_READ" },
  { id: "audit", label: "审计日志", capability: "AUDIT_READ" },
];
const navigationGroups = computed(() => [
  { label: "工作台", items: workbenchItems },
  { label: "平台管理", items: platformItems.filter(item => props.capabilities.includes(item.capability)) },
].filter(group => group.items.length > 0));
</script>

<template>
  <div class="console-shell auth-console">
    <aside class="workspace-sidebar">
      <a href="/" class="console-brand sidebar-brand">
        <span class="sidebar-brand-mark">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16" rx="4.5" transform="rotate(45 12 12)" stroke="#1f2937" stroke-width="2.4" />
            <circle cx="15.5" cy="14.5" r="2.2" fill="#e59a45" />
          </svg>
        </span>
        <strong>Molis AI</strong>
      </a>

      <nav class="console-tabs" aria-label="主导航">
        <div v-for="group in navigationGroups" :key="group.label" class="sidebar-nav-group">
          <p class="nav-caption">{{ group.label }}</p>
          <div class="sidebar-nav-list">
            <button
              v-for="{ id, label } in group.items"
              :key="id"
              type="button"
              :aria-current="currentPage === id ? 'page' : undefined"
              :disabled="busy"
              @click="emit('navigate', id)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <template v-if="id === 'account'">
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <circle cx="12" cy="10" r="2.6" />
                  <path d="M7.5 17c1.2-2 7.8-2 9 0" />
                </template>
                <template v-else-if="id === 'security'">
                  <rect x="5" y="10" width="14" height="10" rx="2.5" />
                  <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
                </template>
                <template v-else-if="id === 'tenants'">
                  <circle cx="9" cy="7" r="3.5" />
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a3.5 3.5 0 0 1 0 6.75" />
                </template>
                <template v-else-if="id === 'subscriptions'">
                  <rect x="3" y="5" width="18" height="14" rx="3" />
                  <path d="M3 10h18M7 15h4" />
                </template>
                <template v-else-if="id === 'pending'">
                  <path d="M4 5h16l2 10v4H2v-4L4 5Z" stroke-linejoin="round" />
                  <path d="M2 15h6l2 2h4l2-2h6" stroke-linejoin="round" />
                </template>
                <template v-else-if="id === 'users'">
                  <circle cx="9" cy="8" r="3" />
                  <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5" />
                </template>
                <template v-else-if="id === 'platform-tenants'">
                  <rect x="3" y="4" width="7" height="16" rx="1.5" />
                  <rect x="14" y="8" width="7" height="12" rx="1.5" />
                  <path d="M6.5 8h.01M6.5 12h.01M6.5 16h.01M17.5 12h.01M17.5 16h.01" />
                </template>
                <template v-else-if="id === 'audit'">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                  <path d="M14 2v6h6M8 13h8M8 17h5" />
                </template>
                <template v-else>
                  <rect x="4" y="4" width="6" height="6" rx="1.5" />
                  <rect x="14" y="4" width="6" height="6" rx="1.5" />
                  <rect x="4" y="14" width="6" height="6" rx="1.5" />
                  <rect x="14" y="14" width="6" height="6" rx="1.5" />
                </template>
              </svg>{{ label }}
            </button>
          </div>
        </div>
      </nav>

      <div class="sidebar-bottom">
        <button type="button" class="account-menu-trigger" popovertarget="account-menu" aria-label="账号菜单">
          <span class="account-avatar">
            <img v-if="user?.avatarUrl" :src="user.avatarUrl" alt="">
            <template v-else>{{ user?.displayName?.slice(0,1) || 'M' }}</template>
          </span>
          <span class="account-menu-identity">
            <span class="account-menu-name" :title="user?.displayName">{{ user?.displayName }}</span>
            <span v-if="user?.email" class="account-menu-email" :title="user.email">{{ user.email }}</span>
          </span>
          <svg class="account-menu-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="m6 15 6-6 6 6" />
          </svg>
        </button>
        <div id="account-menu" popover class="account-menu">
          <button type="button" :disabled="busy" @click="emit('logout')">切换账号</button>
          <button type="button" class="account-menu-logout" :disabled="busy" @click="emit('logout')">退出登录</button>
        </div>
      </div>
    </aside>
    <slot />
  </div>
</template>
