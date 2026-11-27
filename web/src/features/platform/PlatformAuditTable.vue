<script setup lang="ts">
import { platformAuditContext } from "./use-platform-audit.ts";

const { selectedEvent, allEvents, busy, loadMore, nextCursor, loadingMore, resetFilters, isFiltered, auditActorLabel, auditOperationMeta, targetKindTone, eventRows } = platformAuditContext.use();
</script>
<template>
  <div v-if="busy && !allEvents.length" class="pa-empty-state" role="status">
    <div class="pa-empty-title">正在读取平台审计日志…</div>
  </div>

  <template v-else-if="allEvents.length">
    <div class="pa-table-wrap">
      <table class="pa-table">
        <thead>
          <tr>
            <th>发生时间</th>
            <th>操作类型</th>
            <th>操作人</th>
            <th>目标对象</th>
            <th>结果</th>
            <th class="pa-align-right">字段变更</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="{ event: ev, timestamp, relative } in eventRows"
            :key="ev.auditEventId"
            :class="{ 'is-selected': selectedEvent?.auditEventId === ev.auditEventId }"
            tabindex="0"
            @click="selectedEvent = ev"
            @keydown.enter.prevent="selectedEvent = ev"
          >
            <td>
              <div class="pa-time-main pa-num">{{ timestamp }}</div>
              <div class="pa-time-rel">{{ relative }}</div>
            </td>
            <td>
              <div class="pa-op-title">{{ auditOperationMeta(ev.operation).label }}</div>
              <div class="pa-op-code">{{ ev.operation }}</div>
            </td>
            <td>
              <div class="pa-actor-name">{{ auditActorLabel(ev) }}</div>
              <div v-if="ev.actorDisplayName" class="pa-op-code">{{ ev.actorUserId }}</div>
            </td>
            <td>
              <div class="pa-target-cell">
                <span class="pa-kind-tag" :class="'is-' + targetKindTone(ev.target.kind)">
                  {{ ev.target.kind }}
                </span>
                <span class="pa-mono">{{ ev.target.id }}</span>
              </div>
              <div v-if="ev.tenantName || (ev.tenantId && ev.tenantId !== ev.target.id)" class="pa-time-rel pa-tenant-hint">
                所属团队：{{ ev.tenantName ?? ev.tenantId }}
              </div>
            </td>
            <td>
              <span class="pa-pill" :class="ev.result === 'SUCCEEDED' ? 'is-success' : 'is-danger'">
                {{ ev.result === "SUCCEEDED" ? "成功" : "已拒绝" }}
              </span>
            </td>
            <td class="pa-align-right pa-nowrap">
              <span v-if="ev.changes && ev.changes.length" class="pa-pill is-accent pa-num">
                {{ ev.changes.length }} 项变更
              </span>
              <span v-else class="pa-no-diff">无字段差异</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pa-table-foot">
      <span class="pa-num">已加载 {{ allEvents.length }} 条记录</span>
      <button
        v-if="nextCursor"
        type="button"
        class="pa-btn pa-btn-secondary pa-btn-sm"
        :disabled="loadingMore || busy"
        @click="loadMore"
      >
        {{ loadingMore ? "正在加载…" : "加载更早日志" }}
      </button>
      <span v-else>已加载全部可用日志</span>
    </div>
  </template>

  <div v-else class="pa-empty-state">
    <div class="pa-empty-icon" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6" />
      </svg>
    </div>
    <div class="pa-empty-title">{{ isFiltered ? "没有匹配的审计事件" : "暂无平台审计记录" }}</div>
    <div class="pa-empty-desc">
      {{ isFiltered
        ? "请调整左侧分类、结果过滤或搜索关键词。"
        : "当管理员执行用户权限、团队生命周期、应用或订阅写操作时，日志将自动归档于此。" }}
    </div>
    <button
      v-if="isFiltered"
      type="button"
      class="pa-btn pa-btn-secondary"
      @click="resetFilters"
    >
      重置全部筛选
    </button>
  </div>
</template>
