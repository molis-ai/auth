<script setup lang="ts">
import { platformTenantsContext } from "./use-platform-tenants.ts";

const { canSetStatus, hasAuditRead, tenants, busy, latestRelatedAudit, selectedTenant, selectedOwner, dialogs, copyField, formatAuditTimestamp, formatRelativeAuditTime, auditOperationMeta } = platformTenantsContext.use();
</script>
<template>
  <template v-if="selectedTenant && selectedOwner">
              <header class="pt-hero-head">
                <div class="pt-hero-left">
                  <span
                    class="pt-team-avatar pt-team-avatar-lg"
                    :class="{ 'is-disabled': selectedTenant.status !== 'ACTIVE' }"
                    aria-hidden="true"
                  >
                    {{ selectedTenant.name.slice(0, 1) || "T" }}
                  </span>
                  <div class="pt-hero-copy">
                    <div class="pt-hero-title-row">
                      <h2>{{ selectedTenant.name }}</h2>
                      <span class="pt-pill" :class="selectedTenant.status === 'ACTIVE' ? 'is-success' : 'is-danger'">
                        <span class="pt-status-dot" :class="{ 'is-disabled': selectedTenant.status !== 'ACTIVE' }" />
                        {{ selectedTenant.status === "ACTIVE" ? "正常启用" : "已停用" }}
                      </span>
                      <span class="pt-pill is-neutral pt-num">v{{ selectedTenant.version }}</span>
                    </div>
                    <div class="pt-hero-sub">
                      <span class="pt-mono">{{ selectedTenant.tenantId }}</span>
                      <span>·</span>
                      <span>所有者：{{ selectedOwner.primary }}</span>
                    </div>
                  </div>
                </div>

                <div class="pt-hero-actions">
                  <template v-if="canSetStatus">
                    <button
                      v-if="selectedTenant.status === 'ACTIVE'"
                      type="button"
                      class="pt-btn pt-btn-danger-soft"
                      :disabled="busy || !dialogs"
                      @click="dialogs?.openStatusModal('disable', selectedTenant)"
                    >
                      停用团队
                    </button>
                    <button
                      v-else
                      type="button"
                      class="pt-btn pt-btn-primary"
                      :disabled="busy || !dialogs"
                      @click="dialogs?.openStatusModal('enable', selectedTenant)"
                    >
                      恢复启用团队
                    </button>
                  </template>
                  <span v-else class="pt-pill is-neutral" title="需要 TENANT_STATUS 权限才能停用或恢复团队">
                    只读模式（无 TENANT_STATUS）
                  </span>
                </div>
              </header>

              <div v-if="selectedTenant.status !== 'ACTIVE'" class="pt-disabled-banner">
                <div>
                  <strong>该团队当前处于停用状态：</strong>所有成员已无法访问该团队工作空间与席位资源，恢复启用后立即生效。
                </div>
                <button
                  v-if="canSetStatus"
                  type="button"
                  class="pt-btn pt-btn-primary pt-btn-sm"
                  :disabled="busy || !dialogs"
                  @click="dialogs?.openStatusModal('enable', selectedTenant)"
                >
                  立即恢复
                </button>
              </div>

              <!-- 3-Column Overview KPI Strip -->
              <div class="pt-kpi-grid">
                <div class="pt-kpi-card">
                  <span class="pt-kpi-label">运行状态</span>
                  <div class="pt-kpi-value" :class="selectedTenant.status === 'ACTIVE' ? 'is-success' : 'is-danger'">
                    {{ selectedTenant.status === "ACTIVE" ? "正常启用" : "已停用" }}
                  </div>
                  <span class="pt-kpi-sub">
                    {{ selectedTenant.status === "ACTIVE" ? "成员可正常协作与管理席位" : "团队访问与写操作已冻结" }}
                  </span>
                </div>
                <div class="pt-kpi-card">
                  <span class="pt-kpi-label">当前所有者</span>
                  <div class="pt-kpi-value pt-kpi-value-owner">
                    <span class="pt-truncate">{{ selectedOwner.primary }}</span>
                  </div>
                  <span class="pt-kpi-sub pt-truncate">{{ selectedOwner.secondary }}</span>
                </div>
                <div class="pt-kpi-card">
                  <span class="pt-kpi-label">数据版本与最近审计</span>
                  <div class="pt-kpi-value pt-num">Version {{ selectedTenant.version }}</div>
                  <span class="pt-kpi-sub">
                    <template v-if="!hasAuditRead">需 AUDIT_READ 权限查看审计动态</template>
                    <template v-else-if="latestRelatedAudit">
                      最近：{{ auditOperationMeta(latestRelatedAudit.operation).label }}（{{ formatRelativeAuditTime(latestRelatedAudit.occurredAt) }}）
                    </template>
                    <template v-else>暂无相关审计记录</template>
                  </span>
                </div>
              </div>

              <!-- Card 1: Core Info -->
              <section class="pt-card">
                <header class="pt-card-head">
                  <div>
                    <h3>团队基础信息</h3>
                    <p>来自平台只读视图 <span class="pt-mono">GET /api/account/platform/tenants/{{ selectedTenant.tenantId }}</span></p>
                  </div>
                  <span class="pt-pill is-neutral">受管团队</span>
                </header>
                <div class="pt-kv-list">
                  <div class="pt-kv-row">
                    <div class="pt-kv-key">团队 ID (tenantId)</div>
                    <div class="pt-kv-val">
                      <button type="button" class="pt-copy-chip" @click="copyField(selectedTenant.tenantId, '团队 ID')">
                        <span>{{ selectedTenant.tenantId }}</span>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div class="pt-kv-row">
                    <div class="pt-kv-key">团队名称 (name)</div>
                    <div class="pt-kv-val">
                      <strong class="pt-kv-strong">{{ selectedTenant.name }}</strong>
                      <span class="pt-kv-hint">团队名称由团队所有者在工作台内维护</span>
                    </div>
                  </div>
                  <div class="pt-kv-row">
                    <div class="pt-kv-key">团队状态 (status)</div>
                    <div class="pt-kv-val">
                      <span class="pt-pill" :class="selectedTenant.status === 'ACTIVE' ? 'is-success' : 'is-danger'">
                        {{ selectedTenant.status }} · {{ selectedTenant.status === "ACTIVE" ? "正常" : "已停用" }}
                      </span>
                    </div>
                  </div>
                  <div class="pt-kv-row">
                    <div class="pt-kv-key">所有者 (ownerUserId)</div>
                    <div class="pt-kv-val">
                      <div class="pt-kv-val-main">
                        <template v-if="selectedOwner.resolved">
                          <strong class="pt-kv-strong">{{ selectedOwner.primary }}</strong>
                          <span class="pt-kv-sub">{{ selectedOwner.secondary }}</span>
                        </template>
                        <button type="button" class="pt-copy-chip" @click="copyField(selectedTenant.ownerUserId, '所有者 User ID')">
                          <span>{{ selectedTenant.ownerUserId }}</span>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                        <button v-if="canSetStatus" type="button" class="pt-btn pt-btn-danger-soft pt-btn-sm"
                          :disabled="busy || !dialogs" @click="dialogs?.openTransferModal(selectedTenant)">
                          强制移交所有权
                        </button>
                      </div>
                    </div>
                  </div>
                  <div v-if="selectedTenant.createdAt" class="pt-kv-row">
                    <div class="pt-kv-key">创建时间</div>
                    <div class="pt-kv-val">{{ formatAuditTimestamp(selectedTenant.createdAt) }}</div>
                  </div>
                  <div v-if="selectedTenant.updatedAt" class="pt-kv-row">
                    <div class="pt-kv-key">更新时间</div>
                    <div class="pt-kv-val">{{ formatAuditTimestamp(selectedTenant.updatedAt) }}</div>
                  </div>
                  <div class="pt-kv-row">
                    <div class="pt-kv-key">乐观锁版本 (version)</div>
                    <div class="pt-kv-val">
                      <span class="pt-mono pt-kv-ink">v{{ selectedTenant.version }}</span>
                      <span class="pt-kv-hint">状态变更提交 <span class="pt-mono">expectedVersion: {{ selectedTenant.version }}</span> 防并发覆盖</span>
                    </div>
                  </div>
                </div>
              </section>

  </template>
</template>
