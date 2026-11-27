<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import {
  auditOperationMeta,
  copyToClipboard,
  formatAuditTimestamp,
  formatDiffValue,
  resolveDirectoryUser,
  targetKindTone,
  type AuditEvent,
  type PlatformDirectoryUser,
} from "../lib/platform-audit.ts";

const props = defineProps<{
  event: AuditEvent | null;
  usersById: ReadonlyMap<string, PlatformDirectoryUser>;
  tenantNamesById: ReadonlyMap<string, string>;
  hasUserRead: boolean;
  canOpenTenant: boolean;
}>();

const emit = defineEmits<{
  close: [];
  notify: [message: string];
  openTenant: [tenantId: string];
}>();

const operationInfo = computed(() =>
  props.event ? auditOperationMeta(props.event.operation) : null,
);
const actorIdentity = computed(() =>
  props.event ? resolveDirectoryUser(props.event.actorUserId, props.usersById, props.hasUserRead) : null,
);
const isSucceeded = computed(() => props.event?.result === "SUCCEEDED");
const tenantDisplayName = computed(() => {
  const id = props.event?.tenantId;
  if (!id) return "";
  return props.tenantNamesById.get(id) ?? id;
});
const rawJson = computed(() => (props.event ? JSON.stringify(props.event, null, 2) : ""));

async function copyId(value: string, label: string) {
  const ok = await copyToClipboard(value);
  emit("notify", ok ? `已复制${label}` : `${label}：${value}`);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.event) emit("close");
}

onMounted(() => window.addEventListener("keydown", handleKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", handleKeydown));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="event && operationInfo && actorIdentity"
      class="ad-backdrop"
      @click.self="emit('close')"
    >
      <aside class="ad-drawer" role="dialog" aria-modal="true" aria-labelledby="ad-drawer-title">
        <header class="ad-head">
          <div class="ad-head-copy">
            <div class="ad-head-row">
              <h3 id="ad-drawer-title">{{ operationInfo.label }}</h3>
              <span class="ad-pill" :class="isSucceeded ? 'is-success' : 'is-danger'">
                {{ event.result }} · {{ isSucceeded ? "执行成功" : "已拒绝" }}
              </span>
            </div>
            <p class="ad-mono ad-op-code">{{ event.operation }}</p>
          </div>
          <button type="button" class="ad-close" aria-label="关闭审计详情" @click="emit('close')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div class="ad-body">
          <section class="ad-section">
            <h4 class="ad-section-title">事件元数据</h4>
            <div class="ad-meta-grid">
              <div class="ad-meta-box is-full">
                <div class="ad-meta-label">审计事件 ID (auditEventId)</div>
                <div class="ad-meta-row">
                  <span class="ad-mono ad-meta-ink">{{ event.auditEventId }}</span>
                  <button type="button" class="ad-link-btn" @click="copyId(event.auditEventId, '事件 ID')">复制</button>
                </div>
              </div>

              <div v-if="event.reason" class="ad-meta-box is-full">
                <div class="ad-meta-label">操作原因</div>
                <div class="ad-meta-val">{{ event.reason }}</div>
              </div>

              <div v-if="event.requestId" class="ad-meta-box is-full">
                <div class="ad-meta-label">请求追踪 ID</div>
                <div class="ad-meta-row">
                  <span class="ad-mono ad-meta-ink">{{ event.requestId }}</span>
                  <button type="button" class="ad-link-btn" @click="copyId(event.requestId, '请求追踪 ID')">复制</button>
                </div>
              </div>

              <div class="ad-meta-box">
                <div class="ad-meta-label">发生时间 (occurredAt)</div>
                <div class="ad-meta-val ad-num">{{ formatAuditTimestamp(event.occurredAt) }}</div>
              </div>

              <div class="ad-meta-box">
                <div class="ad-meta-label">操作人 (actorUserId)</div>
                <div class="ad-meta-val">
                  <div class="ad-actor-primary">{{ actorIdentity.primary }}</div>
                  <div class="ad-mono">{{ event.actorUserId }}</div>
                </div>
              </div>

              <div class="ad-meta-box">
                <div class="ad-meta-label">目标类型 (target.kind)</div>
                <div class="ad-meta-val">
                  <span class="ad-kind-tag" :class="'is-' + targetKindTone(event.target.kind)">
                    {{ event.target.kind }}
                  </span>
                </div>
              </div>

              <div class="ad-meta-box">
                <div class="ad-meta-label">目标 ID (target.id)</div>
                <div class="ad-meta-val ad-mono ad-meta-ink">{{ event.target.id }}</div>
              </div>

              <div class="ad-meta-box is-full">
                <div class="ad-meta-label">关联团队 (tenantId)</div>
                <div class="ad-meta-row">
                  <template v-if="event.tenantId">
                    <span class="ad-meta-val">
                      <strong>{{ tenantDisplayName }}</strong>
                      <span v-if="tenantDisplayName !== event.tenantId" class="ad-mono"> ({{ event.tenantId }})</span>
                    </span>
                    <button
                      v-if="canOpenTenant"
                      type="button"
                      class="ad-link-btn"
                      @click="emit('close'); emit('openTenant', event.tenantId)"
                    >
                      前往该团队 →
                    </button>
                  </template>
                  <span v-else class="ad-muted-empty">平台级事件（无特定团队归属）</span>
                </div>
              </div>
            </div>
          </section>

          <section class="ad-section">
            <h4 class="ad-section-title">字段变更明细 (changes)</h4>
            <table v-if="event.changes && event.changes.length" class="ad-diff-table">
              <thead>
                <tr>
                  <th style="width: 28%;">字段 (field)</th>
                  <th style="width: 36%;">变更前 (before)</th>
                  <th style="width: 36%;">变更后 (after)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(change, idx) in event.changes" :key="change.field + '-' + idx">
                  <td class="ad-mono ad-diff-field">{{ change.field }}</td>
                  <td>
                    <span v-if="formatDiffValue(change.before) !== null" class="ad-diff-before">
                      {{ formatDiffValue(change.before) }}
                    </span>
                    <span v-else class="ad-diff-null">— (空)</span>
                  </td>
                  <td>
                    <span v-if="formatDiffValue(change.after) !== null" class="ad-diff-after">
                      {{ formatDiffValue(change.after) }}
                    </span>
                    <span v-else class="ad-diff-null">— (空)</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="ad-empty-diff">
              {{ isSucceeded
                ? "本次事件未返回结构化字段差异（changes: null）。"
                : "操作在权限校验或状态前置检查阶段被拒绝，未产生任何数据写入。" }}
            </div>
          </section>

          <section class="ad-section">
            <details class="ad-details">
              <summary>查看原始 API 响应 (audit_view JSON)</summary>
              <pre class="ad-json">{{ rawJson }}</pre>
            </details>
          </section>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.ad-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(25, 25, 27, 0.28);
  backdrop-filter: blur(2px);
  display: flex;
  justify-content: flex-end;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif;
}
.ad-drawer {
  width: min(500px, 100vw);
  height: 100%;
  background: #ffffff;
  color: #19191b;
  border-left: 1px solid #e7e7ea;
  box-shadow: 0 24px 60px rgba(25, 25, 27, 0.18);
  display: flex;
  flex-direction: column;
  animation: ad-slide-in 180ms ease-out;
}
@keyframes ad-slide-in {
  from { transform: translateX(24px); opacity: 0.4; }
  to { transform: translateX(0); opacity: 1; }
}
.ad-head {
  padding: 18px 22px;
  border-bottom: 1px solid #e7e7ea;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ad-head-copy { min-width: 0; }
.ad-head-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ad-head h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  color: #19191b;
  line-height: 1.35;
}
.ad-op-code { margin: 4px 0 0; }
.ad-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  color: #62626b;
}
.ad-num { font-variant-numeric: tabular-nums; }
.ad-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #62626b;
  cursor: pointer;
}
.ad-close:hover { background: #ececf0; color: #19191b; }
.ad-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  border: 1px solid transparent;
  white-space: nowrap;
}
.ad-pill.is-success { background: #ecf7f0; color: #216b46; border-color: #cbe8d7; }
.ad-pill.is-danger { background: #fdf1f2; color: #a62b33; border-color: #f4d3d6; }

.ad-body {
  padding: 20px 22px 28px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.ad-section { display: flex; flex-direction: column; gap: 8px; }
.ad-section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 650;
  color: #62626b;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ad-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.ad-meta-box {
  padding: 10px 12px;
  border-radius: 10px;
  background: #fafafb;
  border: 1px solid #e7e7ea;
  min-width: 0;
}
.ad-meta-box.is-full { grid-column: 1 / -1; }
.ad-meta-label { font-size: 11px; color: #8e8e98; margin-bottom: 3px; }
.ad-meta-val { font-size: 12.5px; color: #19191b; word-break: break-all; }
.ad-meta-ink { color: #19191b; }
.ad-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.ad-actor-primary { font-weight: 600; color: #19191b; }
.ad-muted-empty { font-size: 12.5px; color: #8e8e98; }
.ad-link-btn {
  border: 0;
  background: transparent;
  padding: 0;
  color: #5068b7;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.ad-link-btn:hover { color: #3f55a0; text-decoration: underline; }

.ad-kind-tag {
  display: inline-flex;
  align-items: center;
  font-size: 10.5px;
  font-weight: 650;
  padding: 1px 6px;
  border-radius: 5px;
  background: #efeff3;
  color: #3f3f46;
  letter-spacing: 0.02em;
}
.ad-kind-tag.is-tenant { background: #eae9f9; color: #4b4899; }
.ad-kind-tag.is-app { background: #e6f4ee; color: #216b46; }
.ad-kind-tag.is-user { background: #eef1fa; color: #5068b7; }
.ad-kind-tag.is-billing { background: #fff8e6; color: #8a5a10; }

.ad-diff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  border: 1px solid #e7e7ea;
  border-radius: 10px;
  overflow: hidden;
}
.ad-diff-table th {
  text-align: left;
  padding: 8px 10px;
  background: #fafafb;
  color: #62626b;
  font-size: 11px;
  font-weight: 600;
  border-bottom: 1px solid #e7e7ea;
}
.ad-diff-table td {
  padding: 9px 10px;
  border-bottom: 1px solid #e7e7ea;
  vertical-align: top;
  word-break: break-word;
}
.ad-diff-table tr:last-child td { border-bottom: 0; }
.ad-diff-field { color: #19191b; font-weight: 600; }
.ad-diff-before {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 5px;
  background: #fdf1f2;
  color: #a62b33;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11.5px;
  text-decoration: line-through;
}
.ad-diff-after {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 5px;
  background: #ecf7f0;
  color: #216b46;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11.5px;
}
.ad-diff-null { color: #8e8e98; font-style: italic; font-size: 12px; }
.ad-empty-diff {
  padding: 14px 16px;
  border-radius: 10px;
  background: #fafafb;
  border: 1px solid #e7e7ea;
  font-size: 12.5px;
  color: #62626b;
  line-height: 1.5;
}
.ad-details summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: #62626b;
  margin-bottom: 8px;
}
.ad-json {
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: #1b1b1f;
  color: #e4e4ec;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  overflow-x: auto;
}

@media (max-width: 540px) {
  .ad-meta-grid { grid-template-columns: 1fr; }
}
</style>
