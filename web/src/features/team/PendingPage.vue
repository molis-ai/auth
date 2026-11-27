<script setup lang="ts">
import PendingTransfersCard from "./PendingTransfersCard.vue";
import PendingInvitationsCard from "./PendingInvitationsCard.vue";
import { pendingPageContext, usePending, type Props, type Events } from "./use-pending.ts";

const props = defineProps<Props>();
const emit = defineEmits<Events>();
const state = usePending(props, emit);
pendingPageContext.provide(state);
const { category, invitations, transfers, initialLoading, refreshing, loading, headingCopy, emptyCopy, lastHandled, needMeCount, waitingOthersCount, urgentCount, totalCount, refreshAll, showInvitations, showTransfers, transferTitle, confirmingTransfer, confirmDialog, closeConfirmDialog, confirmAcceptTransfer } = state;
</script>

<template>
  <section class="console-card pending-page" data-console-layout="rail" data-console-flush>
    <div class="pending-layout">
      <aside class="pending-rail" aria-label="待处理分类">
        <div class="pending-rail-head">
          <h1>待处理</h1>
          <span class="pending-rail-total">{{ totalCount }}</span>
        </div>

        <nav class="pending-rail-list" aria-label="按类型筛选待处理事项">
          <button
            type="button"
            class="pending-rail-item"
            :class="{ 'is-active': category === 'all' }"
            :aria-current="category === 'all' ? 'page' : undefined"
            @click="category = 'all'"
          >
            <svg class="pending-rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="m12 3 9 5-9 5-9-5 9-5Z" />
              <path d="m3 12 9 5 9-5" />
              <path d="m3 16 9 5 9-5" />
            </svg>
            <span class="pending-rail-body">
              <span class="pending-rail-top">
                <span class="pending-rail-name">全部待处理</span>
                <span class="pending-rail-count" :class="{ 'is-zero': totalCount === 0 }">{{ totalCount }}</span>
              </span>
              <span class="pending-rail-sub">{{ initialLoading ? "正在检查…" : totalCount > 0 ? `${needMeCount} 项需你确认` : "当前已清空" }}</span>
            </span>
          </button>

          <button
            type="button"
            class="pending-rail-item"
            :class="{ 'is-active': category === 'invitations' }"
            :aria-current="category === 'invitations' ? 'page' : undefined"
            @click="category = 'invitations'"
          >
            <svg class="pending-rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v 2" />
              <circle cx="8.5" cy="7" r="3.5" />
              <path d="M19 8v6M16 11h6" />
            </svg>
            <span class="pending-rail-body">
              <span class="pending-rail-top">
                <span class="pending-rail-name">团队邀请</span>
                <span class="pending-rail-count" :class="{ 'is-zero': invitations.length === 0 }">{{ invitations.length }}</span>
              </span>
              <span class="pending-rail-sub">受邀加入团队</span>
            </span>
          </button>

          <button
            type="button"
            class="pending-rail-item"
            :class="{ 'is-active': category === 'transfers' }"
            :aria-current="category === 'transfers' ? 'page' : undefined"
            @click="category = 'transfers'"
          >
            <svg class="pending-rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M17 3l4 4-4 4" />
              <path d="M3 7h18" />
              <path d="M7 21l-4-4 4-4" />
              <path d="M21 17H3" />
            </svg>
            <span class="pending-rail-body">
              <span class="pending-rail-top">
                <span class="pending-rail-name">所有权交接</span>
                <span class="pending-rail-count" :class="{ 'is-zero': transfers.length === 0 }">{{ transfers.length }}</span>
              </span>
              <span class="pending-rail-sub">接收或取消交接</span>
            </span>
          </button>
        </nav>
      </aside>

      <div class="pending-detail">
        <div class="pending-detail-inner">
          <header class="pending-page-head">
            <div>
              <h2>{{ headingCopy.title }}</h2>
              <p>{{ headingCopy.sub }}</p>
            </div>
            <button
              type="button"
              class="pending-btn"
              :disabled="busy || loading"
              @click="refreshAll"
            >
              <svg :class="{ 'is-spinning': refreshing }" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              <span>{{ refreshing ? "正在刷新…" : "刷新" }}</span>
            </button>
          </header>

          <div v-if="lastHandled" class="pending-handled-bar" role="status">
            <div class="pending-handled-left">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
              <span>{{ lastHandled.message }}</span>
            </div>
            <div class="pending-handled-actions">
              <button v-if="lastHandled.jumpToTeams" type="button" class="pending-link-btn" @click="emit('navigate', 'tenants')">前往团队查看 →</button>
              <button type="button" class="pending-link-btn is-subtle" @click="lastHandled = null">关闭</button>
            </div>
          </div>

          <div v-if="!initialLoading && category === 'all' && totalCount > 0" class="pending-summary-strip">
            <div class="pending-summary-chip">
              <div>
                <div class="pending-summary-label">待你确认</div>
                <div class="pending-summary-val">{{ needMeCount }}<span>项</span></div>
              </div>
              <span class="pending-summary-icon is-accent" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v 2" /><circle cx="8.5" cy="7" r="3.5" /><path d="M19 8v6M16 11h6" /></svg>
              </span>
            </div>
            <div class="pending-summary-chip">
              <div>
                <div class="pending-summary-label">等待对方确认</div>
                <div class="pending-summary-val">{{ waitingOthersCount }}<span>项</span></div>
              </div>
              <span class="pending-summary-icon is-neutral" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              </span>
            </div>
            <div class="pending-summary-chip">
              <div>
                <div class="pending-summary-label">即将过期（24h 内）</div>
                <div class="pending-summary-val">{{ urgentCount }}<span>项</span></div>
              </div>
              <span class="pending-summary-icon is-warn" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
              </span>
            </div>
          </div>

          <PendingInvitationsCard />

          <PendingTransfersCard />

          <div v-if="initialLoading" class="pending-empty-card" role="status">
            <p>正在检查待处理事项…</p>
          </div>
          <section v-else-if="!showInvitations && !showTransfers" class="pending-empty-card">
            <div class="pending-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" /><path d="m9 12 2 2 4-4" /></svg>
            </div>
            <h3 class="pending-empty">{{ emptyCopy.title }}</h3>
            <p>{{ emptyCopy.desc }}</p>
            <div class="pending-empty-actions">
              <button type="button" class="pending-btn" :disabled="busy || loading" @click="refreshAll">{{ refreshing ? "检查中…" : "刷新检查" }}</button>
              <button type="button" class="pending-btn pending-primary" :disabled="busy" @click="emit('navigate', 'tenants')">查看我的团队 →</button>
            </div>
          </section>
        </div>
      </div>
    </div>

    <dialog
      ref="confirmDialog"
      class="pending-dialog"
      aria-labelledby="pending-transfer-dialog-title"
      @cancel.prevent="closeConfirmDialog"
    >
      <div class="pending-dialog-head">
        <h3 id="pending-transfer-dialog-title">确认接受团队所有权？</h3>
        <button type="button" class="pending-dialog-close" aria-label="关闭" :disabled="busy" @click="closeConfirmDialog">×</button>
      </div>
      <div class="pending-dialog-body">
        <p>
          确认接收 <strong>{{ confirmingTransfer ? transferTitle(confirmingTransfer) : "该团队所有权交接" }}</strong> 后，你的团队角色将立即升级为 <strong>所有者</strong>。
        </p>
        <div class="pending-dialog-callout">
          你将承接该团队的成员角色管理、所有权再次交接以及团队订阅与账单结算权限；原所有者将自动转为管理员。
        </div>
      </div>
      <footer class="pending-dialog-foot">
        <button type="button" class="pending-btn" :disabled="busy" @click="closeConfirmDialog">取消</button>
        <button type="button" class="pending-btn pending-primary" :disabled="busy" @click="confirmAcceptTransfer">确认接受交接</button>
      </footer>
    </dialog>
  </section>
</template>

<style src="./pending-page.css"></style>
