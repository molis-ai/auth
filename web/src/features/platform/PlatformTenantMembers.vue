<script setup lang="ts">
import type { PlatformTenantMember } from "./platform-tenants.ts";

defineProps<{
  members: readonly PlatformTenantMember[];
  count?: number;
  loading: boolean;
  canLoadMore: boolean;
}>();
const emit = defineEmits<{ more: [] }>();
const roleLabel: Record<PlatformTenantMember["role"], string> = {
  OWNER: "所有者", ADMIN: "管理员", MEMBER: "成员",
};
</script>

<template>
<section class="pt-card" aria-labelledby="pt-member-heading">
  <header class="pt-card-head">
    <div>
      <h3 id="pt-member-heading">团队成员<span v-if="count !== undefined"> · {{ count }} 人</span></h3>
      <p>查看当前成员与角色</p>
    </div>
    <span class="pt-pill is-neutral">只读</span>
  </header>
  <div v-if="members.length" class="pt-kv-list">
    <div v-for="member in members" :key="member.membershipId" class="pt-member-row">
      <div class="pt-member-identity">
        <strong class="pt-kv-strong">{{ member.displayName || member.userId }}</strong>
        <span v-if="member.email" class="pt-kv-sub">{{ member.email }}</span>
      </div>
      <div class="pt-member-role"><span class="pt-pill is-neutral">{{ roleLabel[member.role] }}</span></div>
    </div>
  </div>
  <div v-else class="pt-empty-state is-compact" role="status">
    {{ loading ? "正在加载成员…" : "暂无可显示的成员" }}
  </div>
  <div v-if="canLoadMore" class="pt-members-more">
    <button type="button" class="pt-btn pt-btn-secondary pt-btn-sm" :disabled="loading"
      @click="emit('more')">加载更多成员</button>
  </div>
</section>
</template>

<style scoped>
.pt-card {
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 1px 2px rgba(25, 25, 27, 0.04); overflow: hidden;
}
.pt-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 15px 20px; border-bottom: 1px solid var(--line);
}
.pt-card-head h3 { margin: 0; font-size: 14.5px; font-weight: 650; color: var(--ink); }
.pt-card-head p { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
.pt-member-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center;
  padding: 13px 20px; border-bottom: 1px solid var(--line);
}
.pt-member-row:last-child { border-bottom: 0; }
.pt-member-identity { display: grid; gap: 2px; overflow-wrap: anywhere; }
.pt-kv-strong { font-weight: 600; color: var(--ink); }
.pt-kv-sub { font-size: 12.5px; color: var(--muted); }
.pt-pill {
  display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; white-space: nowrap;
  background: #efeff2; color: var(--muted); border: 1px solid var(--line);
}
.pt-empty-state { padding: 22px 18px; text-align: center; font-size: 13px; color: var(--muted); }
.pt-members-more { padding: 12px 20px; border-top: 1px solid var(--line); }
.pt-members-more button {
  min-height: 30px; padding: 0 10px; font-size: 12px; font-weight: 600; border-radius: 7px;
  background: var(--surface); border: 1px solid #d5d5db; color: var(--ink);
}
.pt-members-more button:enabled:hover { background: #fafafb; border-color: #c2c2cb; }
</style>
