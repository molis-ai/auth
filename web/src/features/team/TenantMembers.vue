<script setup lang="ts">
import { lazyComponent } from "../../shared/components/lazy-component.ts";
const BillingPanel = lazyComponent(() => import('../billing/index.ts'));
import TenantMemberDialog from "./TenantMemberDialog.vue";
import TenantMemberTable from "./TenantMemberTable.vue";
import { tenantMembersContext, useTenantMembers, type Props, type Events } from "./use-tenant-members.ts";

const props = defineProps<Props>();
const emit = defineEmits<Events>();
const tab = defineModel<"members" | "billing">("tab", { required: true });
const state = useTenantMembers(props, emit, tab);
tenantMembersContext.provide(state);
const { saving, active, manager, billingScope, roleLabel, query, open, role, invite } = state;
</script>
<template>
  <section class="tenant-members" :aria-busy="tab === 'members' && (loading || saving)">
    <header class="tm-heading">
      <div class="tm-heading-left">
        <div class="tm-team-avatar">{{ tenant.name.slice(0,1) }}</div>
        <div class="tm-heading-copy">
          <div class="tm-heading-row">
            <h2>{{ tenant.name }}</h2>
            <span class="tm-pill" :class="active ? 'is-success' : 'is-neutral'"><i class="tm-pill-dot" aria-hidden="true"></i>{{ active ? '正常' : '已停用' }}</span>
          </div>
          <p>{{ roleLabel(tenant.myRole) }} · 本页 {{ members.length }} 位成员</p>
        </div>
      </div>
      <div class="tm-heading-actions">
        <button v-if="manager" type="button" class="tm-primary" :disabled="saving || busy || loading || refreshPending" @click="open('invite')">＋ 邀请成员</button>
        <button v-if="active && tenant.myRole !== 'OWNER'" type="button" class="tm-quiet tm-danger-soft" :disabled="saving || busy || loading || refreshPending" @click="open('leave')">退出团队</button>
      </div>
    </header>

    <div class="tm-card">
      <div class="tm-card-topbar">
        <nav class="tm-tabs" aria-label="团队管理">
          <div class="tm-tab-item" :class="{ 'is-active': tab === 'members' }">
            <button type="button" :aria-current="tab === 'members' ? 'page' : undefined" @click="tab = 'members'">成员管理</button>
            <span class="tm-tab-badge" aria-hidden="true" @click="tab = 'members'">{{ members.length }}</span>
          </div>
          <div class="tm-tab-item" :class="{ 'is-active': tab === 'billing' }">
            <button type="button" :aria-current="tab === 'billing' ? 'page' : undefined" @click="tab = 'billing'">套餐与账单</button>
          </div>
        </nav>

        <div v-if="tab === 'members'" class="tm-search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input v-model="query" type="search" placeholder="搜索本页名称或邮箱" aria-label="搜索本页名称或邮箱" />
        </div>
        <button v-else-if="billingEnabled" type="button" class="tm-topbar-action" :disabled="busy" @click="emit('openBilling', tenant.tenantId)">
          账单中心全屏查看 →
        </button>
      </div>

      <div v-if="tab === 'billing' && billingEnabled" class="tm-billing-body">
        <BillingPanel
          :key="billingScope"
          :client="client"
          :viewer-id="viewerId"
          :tenant-id="tenant.tenantId"
          :owner-name="tenant.name"
          :can-manage-orders="['OWNER', 'ADMIN'].includes(tenant.myRole)"
          @expired="emit('expired', $event)"
          @order-access-denied="emit('orderAccessDenied')"
        />
      </div>

      <TenantMemberTable />
    </div>

    <div v-if="tab === 'members'" class="tm-role-footnote">
      <strong>权限说明：</strong>所有者可调整角色、交接所有权并管理账单；管理员可邀请或移除普通成员；成员可使用团队共享资源。
    </div>

    <TenantMemberDialog />
  </section>
</template>
<style src="./tenant-members.css"></style>
