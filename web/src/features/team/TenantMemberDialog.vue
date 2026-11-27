<script setup lang="ts">
import { tenantMembersContext } from "./use-tenant-members.ts";

const { saving, close, operation, title, role, target, invite, inviteKind, error, submit, dialog, tenant, canInviteByPhone } = tenantMembersContext.use();
</script>
<template>
  <dialog
    ref="dialog"
    class="tm-dialog"
    :class="{ 'tm-invite-dialog': operation === 'invite' }"
    aria-labelledby="tm-dialog-title"
    @cancel.prevent="close"
  >
    <form @submit.prevent="submit">
      <header>
        <h2 id="tm-dialog-title">{{ title }}</h2>
        <button type="button" aria-label="关闭" :disabled="saving" @click="close">×</button>
      </header>
      <div class="tm-dialog-body">
        <template v-if="operation === 'invite'">
          <label v-if="canInviteByPhone">邀请方式
            <select v-model="inviteKind" :disabled="saving">
              <option value="EMAIL">邮箱</option>
              <option value="PHONE">手机号</option>
            </select>
          </label>
          <label>{{ inviteKind === 'EMAIL' ? '邮箱地址' : '手机号（含国家区号）' }}
            <input
              v-model="invite"
              :type="inviteKind === 'EMAIL' ? 'email' : 'tel'"
              :placeholder="inviteKind === 'EMAIL' ? 'colleague@molis.ai' : undefined"
              aria-describedby="tm-invite-help"
              autocomplete="off"
              autofocus
              required
              :disabled="saving"
            />
          </label>
          <p id="tm-invite-help">对方使用此{{ inviteKind === 'EMAIL' ? '邮箱' : '手机号' }}登录后，可在「待处理」接受邀请。</p>
        </template>
        <template v-else-if="operation === 'role'">
          <p>{{ target?.displayName }}</p>
          <label>团队角色
            <select v-model="role" :disabled="saving">
              <option value="ADMIN">管理员</option>
              <option value="MEMBER">成员</option>
            </select>
          </label>
          <p>管理员可以邀请成员和移除普通成员；所有权需要单独交接。</p>
        </template>
        <p v-else-if="operation === 'remove'">确定移除 {{ target?.displayName }}？该成员的团队席位会同时释放。</p>
        <p v-else-if="operation === 'transfer'">将所有权交接给 {{ target?.displayName }}。对方接受后，你将不再是所有者。</p>
        <p v-else>确定退出 {{ tenant.name }}？你在该团队的席位会同时释放。</p>
        <p v-if="error" role="alert" class="tm-danger">{{ error }}</p>
      </div>
      <footer>
        <button type="button" :disabled="saving" @click="close">取消</button>
        <button class="tm-primary" :disabled="saving || (operation === 'role' && role === target?.role)" type="submit">
          {{ saving ? '正在提交…' : operation === 'invite' ? '创建邀请' : '确认' }}
        </button>
      </footer>
    </form>
  </dialog>
</template>
