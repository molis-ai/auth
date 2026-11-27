<script setup lang="ts">
import { pendingPageContext } from "./use-pending.ts";

const { invitations, loading, showInvitations, invitationsLoading, moreInvitations, errors, read, refreshInvitations, received, updateInvitation, invitationRows, busy } = pendingPageContext.use();
</script>
<template>
  <section v-if="showInvitations" class="pending-group-card" aria-labelledby="pending-invitations-title" :aria-busy="invitationsLoading">
    <div class="pending-group-head">
      <div class="pending-group-head-left">
        <h3 id="pending-invitations-title">团队邀请</h3>
        <span class="pending-count-badge">{{ invitations.length }}</span>
      </div>
      <span class="pending-group-sub">接受后将自动出现在「团队」目录中</span>
    </div>

    <div v-if="errors.invitations" class="pending-section-error" role="alert">
      <div class="pending-section-error-left">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
        <span>{{ errors.invitations.message }}</span>
      </div>
      <button type="button" class="pending-btn" @click="errors.invitations.retry()">重试</button>
    </div>

    <p v-else-if="invitationsLoading && !invitations.length" class="pending-loading" role="status">正在加载邀请…</p>

    <div v-if="invitations.length" class="pending-list">
      <div
        v-for="invitation in invitationRows"
        :key="invitation.invitationId"
        class="console-row pending-item is-info"
        :class="{ 'is-urgent': invitation.expiry?.urgent }"
      >
        <div class="pending-row-icon is-invite" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v 2" />
            <circle cx="8.5" cy="7" r="3.5" />
            <path d="M19 8v6M16 11h6" />
          </svg>
        </div>
        <div class="pending-row-main">
          <div class="pending-row-title-line">
            <span class="pending-item-text">团队加入邀请</span>
            <span class="pending-pill is-accent">团队邀请</span>
            <span v-if="invitation.expiry?.urgent" class="pending-pill is-warning"><i class="pending-pill-dot" aria-hidden="true"></i>即将过期</span>
          </div>
          <p class="pending-row-desc">收到指向你的团队邀请，接受后你将以成员身份加入该团队。</p>
          <div class="pending-row-meta">
            <span class="pending-meta-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m3 7 9 6 9-6" /></svg>
              <span>匹配方式：<code class="pending-meta-code">{{ invitation.targetSummary }}</code></span>
            </span>
            <span v-if="invitation.expiry" class="pending-meta-item" :class="{ 'is-urgent': invitation.expiry?.urgent }">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              <span>{{ invitation.expiry?.remaining }}（{{ invitation.expiry?.formatted }} 到期）</span>
            </span>
          </div>
        </div>
        <div class="pending-item-actions">
          <button type="button" class="pending-btn" :disabled="busy" @click="updateInvitation(invitation, 'decline')">拒绝</button>
          <button type="button" class="pending-btn pending-primary" :disabled="busy" @click="updateInvitation(invitation, 'accept')">接受</button>
        </div>
      </div>
    </div>

    <div v-if="moreInvitations && !errors.invitations" class="pending-group-footer">
      <span>还有更多待处理的团队邀请</span>
      <button type="button" class="pending-btn" :disabled="busy || invitationsLoading" @click="read('invitations', received.more, refreshInvitations)">
        {{ invitationsLoading ? "正在加载…" : "加载更多邀请" }}
      </button>
    </div>
  </section>
</template>
