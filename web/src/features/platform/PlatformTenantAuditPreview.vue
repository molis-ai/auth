<script setup lang="ts">
import { platformTenantsContext } from "./use-platform-tenants.ts";

const { hasAuditRead, relatedAudits, activeAuditEvent, selectedTenant, selectedOwner, formatAuditTimestamp, auditOperationMeta, auditActorLabel, emit } = platformTenantsContext.use();
</script>
<template>
  <template v-if="selectedTenant && selectedOwner">
              <section v-if="hasAuditRead" class="pt-card">
                <header class="pt-card-head">
                  <div>
                    <div class="pt-card-title-row">
                      <h3>相关审计动态</h3>
                      <span class="pt-pill-count pt-num">{{ relatedAudits.length }}</span>
                    </div>
                    <p>展示关联到该团队的最新管理操作，点击任意条目查看完整变更 Diff</p>
                  </div>
                  <button
                    type="button"
                    class="pt-btn pt-btn-secondary pt-btn-sm"
                    @click="emit('openAudit', selectedTenant.tenantId)"
                  >
                    在审计日志中查看全部 →
                  </button>
                </header>

                <div v-if="relatedAudits.length">
                  <button
                    v-for="ev in relatedAudits"
                    :key="ev.auditEventId"
                    type="button"
                    class="pt-mini-audit-row"
                    @click="activeAuditEvent = ev"
                  >
                    <span class="pt-mini-col">
                      <span class="pt-op-title pt-truncate">{{ auditOperationMeta(ev.operation).label }}</span>
                      <span class="pt-op-code pt-truncate">
                        {{ ev.operation }} · {{ ev.changes?.length ? `${ev.changes.length} 项字段变更` : "无字段变更" }}
                      </span>
                    </span>
                    <span class="pt-mini-col">
                      <span class="pt-actor-name pt-truncate">
                        {{ auditActorLabel(ev) }}
                      </span>
                      <span class="pt-time-rel pt-num">{{ formatAuditTimestamp(ev.occurredAt) }}</span>
                    </span>
                    <span class="pt-pill" :class="ev.result === 'SUCCEEDED' ? 'is-success' : 'is-danger'">
                      {{ ev.result === "SUCCEEDED" ? "成功" : "已拒绝" }}
                    </span>
                    <span class="pt-mini-link">详情 →</span>
                  </button>
                </div>
                <div v-else class="pt-empty-state is-compact">
                  <div class="pt-empty-title">暂无该团队的近期审计事件</div>
                  <div class="pt-empty-desc">对该团队执行停用或恢复操作后，审计记录会实时出现在这里。</div>
                </div>
              </section>

  </template>
</template>
