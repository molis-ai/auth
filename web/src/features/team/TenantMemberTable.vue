<script setup lang="ts">
import { tenantMembersContext } from "./use-tenant-members.ts";

const { tab, emit, saving, active, manager, roleLabel, query, roleFilter, sort, roleCounts, rows, openMoreId, toggleMore, open, role, error, pageSizes, pageSizeMenu, selectPageSize, dialog, tenant, members, loading, busy, page, size, hasNext, refreshPending } = tenantMembersContext.use();
</script>
<template>
  <div v-show="tab === 'members'">
    <div v-if="members.length > 1" class="tm-filter-bar">
      <div class="tm-filter-pills" role="group" aria-label="按角色筛选">
        <button
          v-for="[key, label] in ([['ALL', '全部'], ['OWNER', '所有者'], ['ADMIN', '管理员'], ['MEMBER', '成员']] as const)"
          :key="key"
          type="button"
          class="tm-filter-pill"
          :class="{ 'is-active': roleFilter === key }"
          @click="roleFilter = key"
        >
          <span>{{ label }}</span>
          <span class="tm-filter-cnt">{{ roleCounts[key] }}</span>
        </button>
      </div>
      <span class="tm-filter-hint">点击表头可按名称或角色排序</span>
    </div>

    <p v-if="error && !dialog?.open" class="tm-alert" role="alert">{{ error }}</p>

    <div class="tm-table-wrap">
      <table>
        <thead>
          <tr>
            <th :aria-sort="sort === 'name' ? 'ascending' : undefined"><button @click="sort='name'">用户 {{ sort==='name'?'↑':'' }}</button></th>
            <th>状态</th>
            <th :aria-sort="sort === 'role' ? 'ascending' : undefined"><button @click="sort='role'">角色 {{ sort==='role'?'↑':'' }}</button></th>
            <th class="tm-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="4" class="tm-empty" data-collection-status>正在加载成员…</td></tr>
          <tr v-else-if="!rows.length">
            <td colspan="4" class="tm-empty" data-collection-status>
              {{ query || roleFilter !== 'ALL' ? '没有匹配的成员' : active ? '暂无成员' : '团队已停用' }}
              <button v-if="query || roleFilter !== 'ALL'" type="button" class="tm-clear-btn" @click="query = ''; roleFilter = 'ALL'">清除筛选</button>
            </td>
          </tr>
          <tr v-for="(m, index) in loading ? [] : rows" :key="m.membershipId">
            <td>
              <div class="tm-person">
                <span class="tm-initial">{{ (m.displayName || '未').slice(0,1).toUpperCase() }}</span>
                <div>
                  <strong>{{ m.displayName || '未设置名称' }}<span v-if="m.membershipId === tenant.membershipId" class="tm-self">（我）</span></strong>
                  <small>{{ m.email || '未绑定邮箱' }}</small>
                </div>
              </div>
            </td>
            <td><span class="tm-status">{{ m.status === 'ACTIVE' ? '正常' : m.status }}</span></td>
            <td><span class="tm-role-pill" :class="m.role === 'OWNER' ? 'is-owner' : m.role === 'ADMIN' ? 'is-admin' : 'is-member'">{{ roleLabel(m.role) }}</span></td>
            <td class="tm-actions">
              <div class="tm-row-actions">
                <template v-if="active && tenant.myRole === 'OWNER' && m.role !== 'OWNER'">
                  <button type="button" class="tm-row-btn" :disabled="saving || busy || refreshPending" @click="open('role', m)">修改角色</button>
                  <div class="tm-more-wrap">
                    <button
                      type="button"
                      class="tm-row-btn tm-more-trigger"
                      aria-label="更多操作"
                      :aria-expanded="openMoreId === m.membershipId"
                      :disabled="saving || busy || refreshPending"
                      @click.stop="toggleMore(m.membershipId)"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="5" cy="12" r="1.6" fill="currentColor" />
                        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
                        <circle cx="19" cy="12" r="1.6" fill="currentColor" />
                      </svg>
                    </button>
                    <div
                      v-if="openMoreId === m.membershipId"
                      class="tm-more-menu"
                      :class="{ 'is-up': rows.length > 1 && index >= rows.length - 1 }"
                    >
                      <button type="button" @click="open('transfer', m)">交接所有权</button>
                      <button
                        v-if="m.role === 'MEMBER' && m.membershipId !== tenant.membershipId"
                        type="button"
                        class="is-danger"
                        @click="open('remove', m)"
                      >移除</button>
                    </div>
                  </div>
                </template>
                <button
                  v-else-if="manager && m.role === 'MEMBER' && m.membershipId !== tenant.membershipId"
                  type="button"
                  class="tm-row-btn tm-danger"
                  :disabled="saving || busy || refreshPending"
                  @click="open('remove', m)"
                >移除</button>
                <span v-else class="tm-no-actions" aria-label="暂无可用操作">—</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="tm-pagination">
      <span>本页 {{ rows.length }} 位成员</span>
      <div class="tm-page-controls">
        <button
          type="button"
          class="tm-page-size-trigger"
          popovertarget="tm-page-sizes"
          :disabled="busy || loading"
        >
          每页 {{ size }} 人
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        </button>
        <div id="tm-page-sizes" ref="pageSizeMenu" class="tm-page-size-menu" popover role="group" aria-label="每页人数">
          <button
            v-for="option in pageSizes"
            :key="option"
            type="button"
            :aria-pressed="size === option"
            :disabled="busy || loading"
            @click="selectPageSize(option)"
          >
            {{ option }} 人
            <svg v-if="size === option" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-6" /></svg>
          </button>
        </div>
        <nav class="tm-page-navigation" aria-label="成员分页">
          <button type="button" :disabled="page <= 1 || busy || loading" aria-label="上一页" @click="emit('previous')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 4-4 4 4 4" /></svg>
          </button>
          <span>第 {{ page }} 页</span>
          <button type="button" :disabled="!hasNext || busy || loading" aria-label="下一页" @click="emit('next')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
          </button>
        </nav>
      </div>
    </footer>
  </div>
</template>
