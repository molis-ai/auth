<script setup lang="ts">
import StatusTag from './StatusTag.vue'
import WorkspaceIcon from './WorkspaceIcon.vue'
import TeamNavigation from './TeamNavigation.vue'
import TeamCreate from './TeamCreate.vue'
import TeamInvite from './TeamInvite.vue'
import MemberRoleEditor from './MemberRoleEditor.vue'
import { teamListPath } from './team-query'
import { memberListPath, type MemberPermissions } from './member-table'
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { workspaceTeam, rememberedTeam, rememberTeam } from './workspace'
import { ElButton, ElDropdown, ElDropdownMenu, ElDropdownItem, ElPagination, ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import enLocale from 'element-plus/es/locale/lang/en'
import 'element-plus/es/components/dropdown/style/css'
import 'element-plus/es/components/pagination/style/css'
import type { AuthClient } from '../../sdk/browser/src/index.ts'
import { spaceApi, ConsoleError, listPath, type Page } from './console-api'
import { editableRoles, removable, type Role } from './space-policy'
const props = defineProps<{ auth: AuthClient; userId: string; language: 'en' | 'zh-CN'; personalAvatar?: string | null; creationPage?: boolean; creationBusy?: boolean }>()
const emit = defineEmits<{ draft: [value: boolean]; busy: [value: boolean]; create: []; openTeam: [id: string] }>()
type Space = { id: string; name: string; ownerName?: string | null; avatarUrl?: string | null; description?: string; spaceType: 'PERSONAL' | 'TEAM'; status: 'ACTIVE' | 'ARCHIVED'; version: number; role: Role | null; canInspectManagement?: boolean; memberCount?: number; permissionDetails?: { action: string; allowed: boolean; reason: string }[] }
type Member = { id: string; displayName: string; status: string; role: Role; emails: string[]; permissions: MemberPermissions }
type MemberPage = { items: Member[]; total: number; page: number; pageSize: number }
type Invitation = { id: string; spaceId: string; spaceName: string; invitedEmail: string; inviterName: string; status: string; expiresAt: string }
type Audit = { id: string; action: string; outcome: string; requestId: string; occurredAt: string; changeSummary: string | null; denialReason?: string | null; actorName?: string; targetName?: string }
const t = computed(() => props.language === 'en' ? {
  title: 'Your teams', create: 'Create team', name: 'Name', open: 'Open', personal: 'Personal', team: 'Team', status: 'Status', role: 'Role',
  reload: 'Reload', next: 'Next', first: 'First page', back: 'Back to teams', empty: 'No records.', save: 'Save name', archive: 'Archive', restore: 'Restore', leave: 'Leave space',
  members: 'Members', invite: 'Invite by email', email: 'Verified email address', send: 'Send invitation', memberOnly: 'New members start as Member. Existing members keep their role. Assign another role afterwards.',
  inbox: 'Pending invitations', from: 'Invited by', accept: 'Accept invitation', decline: 'Decline', revoke: 'Revoke', pending: 'Space invitations', expiry: 'Expires',
  remove: 'Remove member', change: 'Change role', audit: 'Space management audit', confirm: 'Confirm', cancel: 'Cancel', confirmHint: 'Review this change. Membership and permission changes take effect immediately; removing or leaving retains the space data.',
  saved: 'Change saved.', error: 'Request failed. No automatic retry was made.', conflict: 'The space changed elsewhere. Reload before editing.', uncertain: 'The outcome may be unknown. Read current state before repeating the operation.', request: 'Request ID',
  archived: 'Archived: reads and member removal/exit remain available; ordinary writes and new joins are blocked.', owner: 'The Owner cannot be removed, leave, or be changed through member roles.',
} : {
  title: '团队管理', create: '创建团队', name: '名称', open: '打开', personal: '个人', team: '团队', status: '状态', role: '角色',
  reload: '重新读取', next: '下一页', first: '第一页', back: '返回团队列表', empty: '暂无记录。', save: '保存名称', archive: '归档', restore: '恢复', leave: '退出空间',
  members: '成员', invite: '通过邮箱邀请', email: '已验证邮箱地址', send: '发送邀请', memberOnly: '新成员同意邀请后统一成为 Member，再由管理员分配角色；已有成员保留原角色。',
  inbox: '待处理邀请', from: '邀请人', accept: '同意邀请', decline: '拒绝', revoke: '撤销', pending: '空间邀请', expiry: '到期时间',
  remove: '移除成员', change: '修改角色', audit: '空间管理审计', confirm: '确认', cancel: '取消', confirmHint: '请核对变更。成员及权限修改即时生效；移除或退出不会删除空间数据。',
  saved: '变更已保存。', error: '请求失败，未自动重试。', conflict: '空间已被其他操作修改，请重新读取后再编辑。', uncertain: '操作结果可能尚不确定，请先读取当前状态再决定是否重试。', request: '请求 ID',
  archived: '空间已归档：保留读取、移除及退出；禁止普通写入和新成员加入。', owner: 'Owner 不能被移除、退出或通过成员角色接口变更。',
})
const busy = ref(false), error = ref<{ code: string; requestId: string; uncertain: boolean }>(), notice = ref('')
const spaces = ref<Page<Space>>(), selected = ref<Space>(), members = ref<MemberPage>(), invitations = ref<{ items: Invitation[]; total: number; page: number; pageSize: number }>(), audit = ref<{ items: Audit[]; total: number; page: number; pageSize: number }>()
const auditSize = ref(10), auditPage = ref(1), auditLoading = ref(false), auditFailed = ref(false)
let auditGeneration = 0
const memberTableWrap = ref<HTMLElement>(), auditTableWrap = ref<HTMLElement>()
const memberTableHeight = ref(0), auditTableHeight = ref(0)
const memberSort = ref<'name' | 'role'>('role'), memberOrder = ref<'asc' | 'desc'>('desc')
const memberQuery = ref(''), memberPage = ref(1), memberSize = ref(10), memberLoading = ref(false), memberFailed = ref(false)
const memberPages = computed(() => Math.max(1, Math.ceil((members.value?.total ?? 0) / memberSize.value)))
let memberGeneration = 0, memberTimer: ReturnType<typeof setTimeout> | undefined
const name = ref(''), newName = ref(''), email = ref(''), roles = ref<Record<string, Role>>({})
const creating = ref(false), createInput = ref<HTMLInputElement>()
const invitationPage = ref(1), invitationSize = ref(10), invitationLoading = ref(false), invitationFailed = ref(false)
let invitationGeneration = 0
const detailTab = ref<'members' | 'invitations' | 'audit'>('members'), chooser = ref<HTMLDialogElement>(), switchDialog = ref<HTMLDialogElement>()
const editingProfile = ref(false), profileDraft = ref(false), profileBusy = ref(false), inviting = ref(false)
const managedMember = ref<Member>()
const en = computed(() => props.language === 'en')
watch([busy, profileBusy], () => emit('busy', busy.value || profileBusy.value))
const switchTarget = ref<string>(), failedTeam = ref<string>()
const query = ref(''), order = ref<'asc' | 'desc'>('asc'), listLoading = ref(false), listFailed = ref(false)
try { if (localStorage.getItem('molis.auth.team-order') === 'desc') order.value = 'desc' } catch { /* Optional preference. */ }
let listGeneration = 0, searchTimer: ReturnType<typeof setTimeout> | undefined, disposed = false
let retryMore = false
const navigationProps = computed(() => ({ items: spaces.value?.items ?? [], selected: props.creationPage ? undefined : selected.value?.id, busy: busy.value || profileBusy.value || !!props.creationBusy, loading: listLoading.value, failed: listFailed.value, more: !!spaces.value?.nextCursor, query: query.value, order: order.value, language: props.language }))
const navigationEvents = { select: selectTeam, create: showCreate, search: searchTeams, sort: sortTeams, more: () => loadSpaces(true), retry: () => loadSpaces(retryMore), clear: clearTeamSearch }
const emptyDetail = computed(() => !props.creationPage && !selected.value && !creating.value && !busy.value && !error.value)
const noTeams = computed(() => !listLoading.value && !listFailed.value && spaces.value?.items.length === 0 && !query.value)
const selectedCount = computed(() => selected.value?.memberCount)
const descriptionElement = ref<HTMLElement>(), descriptionExpanded = ref(false), descriptionOverflow = ref(false)
let descriptionObserver: ResizeObserver | undefined
watch(descriptionElement, element => {
  descriptionObserver?.disconnect()
  if (!element) return
  descriptionObserver = new ResizeObserver(() => { descriptionOverflow.value = element.scrollHeight > 40 })
  descriptionObserver.observe(element)
})
watch(() => selected.value?.id, () => { descriptionExpanded.value = false; descriptionOverflow.value = false })
onUnmounted(() => descriptionObserver?.disconnect())
const draft = computed(() => profileDraft.value || !!newName.value || !!email.value || (!!selected.value && name.value !== selected.value.name) || !!members.value?.items.some(member => roles.value[member.id] && roles.value[member.id] !== member.role))
function storeSelection(id?: string, push = false) {
  if (disposed) return
  rememberTeam(sessionStorage, props.userId, id)
  if (location.hash.startsWith('#/spaces')) history[push ? 'pushState' : 'replaceState'](null, '', '/console#/spaces' + (id ? '/' + id : ''))
}
function savedSelection() { try { return workspaceTeam(location.hash) || rememberedTeam(sessionStorage, props.userId) } catch { return workspaceTeam(location.hash) } }
async function selectTeam(id: string, confirmed = false, push = true) {
  if (props.creationPage) { if (!props.creationBusy) { chooser.value?.close(); emit('openTeam', id) }; return }
  if (busy.value || profileBusy.value) return
  if (id === selected.value?.id && !creating.value && !editingProfile.value) { chooser.value?.close(); return }
  if (!confirmed && draft.value) { switchTarget.value = id; storeSelection(selected.value?.id); await nextTick(); switchDialog.value?.showModal(); return }
  chooser.value?.close(); creating.value = false; editingProfile.value = false; profileDraft.value = false; newName.value = ''; email.value = ''; detailTab.value = 'members'
  storeSelection(id, push); await work(() => open(id))
}
function cancelSwitch() { switchTarget.value = undefined; switchDialog.value?.close() }
async function confirmSwitch() { const id = switchTarget.value; cancelSwitch(); if (id === 'create') { email.value = ''; name.value = selected.value?.name ?? ''; roles.value = Object.fromEntries((members.value?.items ?? []).map(m => [m.id, m.role])); await beginCreate() } else if (id) await selectTeam(id, true) }
function routeChanged() {
  if (!location.hash.startsWith('#/spaces')) return
  const id = workspaceTeam(location.hash) || selected.value?.id || savedSelection()
  if (id && id !== selected.value?.id) void selectTeam(id, false, false)
  else if (id) storeSelection(id)
}
function roleLabel(role: Role) { return (props.language === 'en' ? { OWNER: 'Owner', ADMIN: 'Administrator', MEMBER: 'Member', VIEWER: 'Viewer' } : { OWNER: '所有者', ADMIN: '管理员', MEMBER: '成员', VIEWER: '只读成员' })[role] }
async function beginCreate() { chooser.value?.close(); creating.value = true; await nextTick(); createInput.value?.focus() }
function showCreate() { if (profileBusy.value) return; chooser.value?.close(); emit('create') }
async function finishProfile(id: string) { editingProfile.value = false; profileDraft.value = false; await work(async () => { await open(id); await loadSpaces(); notice.value = t.value.saved }) }
function closeProfile() { if (!profileBusy.value && selected.value) void selectTeam(selected.value.id) }
async function switchTab(tab: typeof detailTab.value) { if (busy.value) return; detailTab.value = tab; if (tab === 'audit' && !audit.value) await loadAudit() }
async function invited() { inviting.value = false; detailTab.value = 'invitations'; await work(async () => { await loadInvitations(); audit.value = undefined; notice.value = en.value ? 'Invitation sent.' : '邀请已发送。' }) }
function manageMember(member: Member) { managedMember.value = member }
async function memberRoleSaved() { managedMember.value = undefined; await work(async () => { await loadMembers(); audit.value = undefined; notice.value = t.value.saved }) }
function dateLabel(value: string) { return new Date(value).toLocaleString(props.language === 'en' ? 'en' : 'zh-CN', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) }
function statusLabel(value: string) { const labels: Record<string,string> = en.value ? { PENDING:'Pending', ACCEPTED:'Accepted', DECLINED:'Declined', EXPIRED:'Expired', REVOKED:'Revoked', SUCCESS:'Completed', DENIED:'Denied', DISABLED:'Disabled' } : { PENDING:'等待接受', ACCEPTED:'已接受', DECLINED:'已拒绝', EXPIRED:'已过期', REVOKED:'已撤销', SUCCESS:'已完成', DENIED:'未通过', DISABLED:'已停用' }; return labels[value] || value }
function auditSummary(event: Audit) {
  if (event.outcome === 'DENIED') return en.value ? 'Request denied; the operation was not completed.' : '请求未通过，操作未完成。'
  const summary = event.changeSummary ?? ''
  const roles = summary.match(/^(OWNER|ADMIN|MEMBER|VIEWER)->(OWNER|ADMIN|MEMBER|VIEWER)$/)
  if (roles) return roleLabel(roles[1] as Role) + ' → ' + roleLabel(roles[2] as Role)
  if (/^(profile updated; )?version=/.test(summary)) return ''
  const labels: Record<string, [string, string]> = {
    'OWNER created atomically': ['创建团队并成为所有者。', 'Created the team as its owner.'],
    'membership removed; data retained': ['成员关系已解除，团队数据保留。', 'Membership ended; team data retained.'],
    'pending; initial role=MEMBER': ['等待接受邀请，初始角色为成员。', 'Invitation pending; initial role: Member.'],
    'accepted; existing role preserved': ['已接受邀请；已有成员保留原角色。', 'Invitation accepted; existing members retain their role.'],
    'declined': ['邀请已拒绝。', 'Invitation declined.'],
    'revoked': ['邀请已撤销，不再有效。', 'Invitation revoked and no longer valid.'],
    'expired': ['邀请已过期。', 'Invitation expired.'],
  }
  return labels[summary]?.[en.value ? 1 : 0] ?? summary
}
function auditLabel(action: string) { const labels: Record<string, string> = en.value ? { 'space.create':'Team created', 'space.update':'Team profile updated', 'space.member.role':'Member role changed', 'space.member.remove':'Member removed', 'space.member.leave':'Member left', 'space.invitation.create':'Invitation sent', 'space.invitation.accept':'Invitation accepted', 'space.invitation.decline':'Invitation declined', 'space.invitation.revoke':'Invitation revoked', 'space.invitation.expire':'Invitation expired', 'space.archive':'Team archived', 'space.restore':'Team restored' } : { 'space.create':'创建团队', 'space.update':'修改团队资料', 'space.member.role':'调整成员角色', 'space.member.remove':'移除成员', 'space.member.leave':'退出团队', 'space.invitation.create':'发送成员邀请', 'space.invitation.accept':'接受邀请', 'space.invitation.decline':'拒绝邀请', 'space.invitation.revoke':'撤销邀请', 'space.invitation.expire':'邀请已过期', 'space.archive':'归档团队', 'space.restore':'恢复团队' }; return labels[action] || action }
watch(draft, value => emit('draft', value), { immediate: true })
const pending = shallowRef<{ label: string; action: () => Promise<void> }>(), dialog = ref<HTMLDialogElement>()
const personal = computed(() => selected.value?.spaceType === 'PERSONAL'), archived = computed(() => selected.value?.status === 'ARCHIVED')
const inspector = computed(() => !!selected.value?.canInspectManagement)
const manager = computed(() => selected.value?.role === 'OWNER' || selected.value?.role === 'ADMIN')
watch(pending, async value => { await nextTick(); if (value && !dialog.value?.open) dialog.value?.showModal(); else if (!value) dialog.value?.close() })
async function work(action: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = undefined; notice.value = ''; try { await action() } catch (e) {
  error.value = e instanceof ConsoleError ? e : { code: 'AUTH_UNAVAILABLE', requestId: '', uncertain: false }
} finally { busy.value = false } }
function ask(label: string, action: () => Promise<void>) { if (!busy.value) pending.value = { label, action } }
async function confirm() { const value = pending.value; pending.value = undefined; if (value) await work(async () => { await value.action(); notice.value = t.value.saved }) }
async function loadSpaces(more = false) {
  if (disposed || (more && (listLoading.value || !spaces.value?.nextCursor))) return
  clearTimeout(searchTimer)
  const generation = ++listGeneration, cursor = more ? spaces.value!.nextCursor : null
  listLoading.value = true; listFailed.value = false; retryMore = more
  if (!more) spaces.value = undefined
  try {
    const page = await spaceApi<Page<Space>>(props.auth, teamListPath(query.value, 'ALL', order.value, cursor))
    if (disposed || generation !== listGeneration) return
    if (page.nextCursor && page.nextCursor === cursor) throw new ConsoleError('INVALID_RESPONSE')
    spaces.value = { items: [...new Map([...(more ? spaces.value?.items ?? [] : []), ...page.items].map(item => [item.id, item])).values()], nextCursor: page.nextCursor }
  } catch { if (!disposed && generation === listGeneration) listFailed.value = true }
  finally { if (!disposed && generation === listGeneration) listLoading.value = false }
}
function searchTeams(value: string) { query.value = value; ++listGeneration; clearTimeout(searchTimer); spaces.value = undefined; listFailed.value = false; listLoading.value = true; searchTimer = setTimeout(() => void loadSpaces(), 300) }
function sortTeams() { order.value = order.value === 'asc' ? 'desc' : 'asc'; try { localStorage.setItem('molis.auth.team-order', order.value) } catch { /* Optional preference. */ }; void loadSpaces() }
function clearTeamSearch() { query.value = ''; void loadSpaces() }
async function refreshOverview() { await work(async () => { await loadSpaces(); if (failedTeam.value) await open(failedTeam.value) }) }
async function open(space: string) { memberTableHeight.value = 0; auditTableHeight.value = 0; ++memberGeneration; clearTimeout(memberTimer); if (selected.value?.id !== space) { memberQuery.value = ''; memberPage.value = 1 }; failedTeam.value = space; selected.value = undefined; members.value = undefined; invitations.value = undefined; audit.value = undefined; roles.value = {};
  let detail: Space
  try {
    detail = await spaceApi<Space>(props.auth, '/spaces/' + space)
    if (disposed) return
    if (detail.spaceType !== 'TEAM') throw new ConsoleError('TEAM_NOT_AVAILABLE')
  } catch (cause) {
    if (disposed) return
    if (!(cause instanceof ConsoleError) || !['SPACE_FORBIDDEN', 'NOT_FOUND', 'TEAM_NOT_AVAILABLE'].includes(cause.code)) throw cause
    // A remembered/deep-linked team can disappear or belong to another account.
    // Never bypass the server's membership check, and never hide network failures.
    failedTeam.value = undefined; name.value = ''; storeSelection(); error.value = undefined
    await loadSpaces()
    return
  }
  selected.value = detail; name.value = detail.name;
  await loadMembers(); if (inspector.value && !personal.value) await loadInvitations(); else invitations.value = undefined
  failedTeam.value = undefined; storeSelection(space)
  const row = spaces.value?.items.find(s => s.id === space); if (row && selected.value) Object.assign(row, { name: selected.value.name, status: selected.value.status, role: selected.value.role }) }
async function loadMembers(page = memberPage.value) {
  const space = selected.value?.id; if (!space || disposed) return
  clearTimeout(memberTimer); const generation = ++memberGeneration
  memberTableHeight.value = Math.max(memberTableHeight.value, memberTableWrap.value?.getBoundingClientRect().height ?? 0)
  memberLoading.value = true; memberFailed.value = false
  try {
    const result = await spaceApi<MemberPage>(props.auth, memberListPath(space, memberQuery.value, page, memberSize.value, memberSort.value, memberOrder.value))
    if (disposed || generation !== memberGeneration || space !== selected.value?.id) return
    members.value = result; memberPage.value = result.page; roles.value = Object.fromEntries(result.items.map(m => [m.id, m.role]))
  } catch { if (!disposed && generation === memberGeneration) memberFailed.value = true }
  finally { if (!disposed && generation === memberGeneration) memberLoading.value = false }
}
function searchMembers(value: string) { memberQuery.value = value; memberPage.value = 1; ++memberGeneration; clearTimeout(memberTimer); memberFailed.value = false; memberLoading.value = true; memberTimer = setTimeout(() => void loadMembers(1), 300) }
function sortMembers(field: 'name' | 'role') { memberOrder.value = memberSort.value === field ? (memberOrder.value === 'asc' ? 'desc' : 'asc') : (field === 'role' ? 'desc' : 'asc'); memberSort.value = field; memberPage.value = 1; void loadMembers(1) }
function resizeMembers(value: string) { memberSize.value = Number(value); memberPage.value = 1; void loadMembers(1) }
onUnmounted(() => { ++memberGeneration; clearTimeout(memberTimer) })
async function loadInvitations(page = 1) {
  const space = selected.value?.id; if (!space || disposed) return
  const generation = ++invitationGeneration; invitationLoading.value = true; invitationFailed.value = false
  try {
    const result = await spaceApi<{ items: Invitation[]; total: number; page: number; pageSize: number }>(props.auth, '/spaces/' + space + '/invitations?page=' + page + '&limit=' + invitationSize.value)
    if (disposed || generation !== invitationGeneration || space !== selected.value?.id) return
    invitations.value = result; invitationPage.value = result.page
  } catch { if (!disposed && generation === invitationGeneration) invitationFailed.value = true }
  finally { if (!disposed && generation === invitationGeneration) invitationLoading.value = false }
}
function resizeInvitations(size: number) { invitationSize.value = size; void loadInvitations(1) }
async function loadAudit(page = 1) {
  const space = selected.value?.id; if (!space) return
  const generation = ++auditGeneration
  auditTableHeight.value = Math.max(auditTableHeight.value, auditTableWrap.value?.getBoundingClientRect().height ?? 0)
  auditLoading.value = true; auditFailed.value = false
  try { const result = await spaceApi<{ items: Audit[]; total: number; page: number; pageSize: number }>(props.auth, '/spaces/' + space + '/audit?page=' + page + '&limit=' + auditSize.value); if (generation === auditGeneration && selected.value?.id === space) { audit.value = result; auditPage.value = result.page } }
  catch { if (generation === auditGeneration && selected.value?.id === space) auditFailed.value = true }
  finally { if (generation === auditGeneration) auditLoading.value = false }
}
function resizeAudit(size: number) { auditSize.value = size; void loadAudit(1) }
function create() { const value = newName.value; ask(t.value.create, async () => { const space = await spaceApi<Space>(props.auth, '/spaces', 'POST', { name: value }); newName.value = ''; creating.value = false; await loadSpaces(); await open(space.id) }) }
function save() { const current = selected.value!, value = name.value; ask(t.value.save, async () => { await spaceApi(props.auth, '/spaces/' + current.id, 'PUT', { name: value, version: current.version }); await open(current.id); await loadSpaces() }) }
function setArchive() { const current = selected.value!; ask(archived.value ? t.value.restore : t.value.archive, async () => { await spaceApi(props.auth, '/spaces/' + current.id + '/archive', 'PUT', { archived: current.status !== 'ARCHIVED', version: current.version }); await open(current.id); await loadSpaces() }) }
function leave() { const space = selected.value!.id; ask(t.value.leave, async () => { await spaceApi(props.auth, '/spaces/' + space + '/leave', 'POST', {}); selected.value = undefined; email.value = ''; storeSelection(); await loadSpaces() }) }
function invite() { const space = selected.value!.id, value = email.value; ask(t.value.send + ': ' + value, async () => { await spaceApi(props.auth, '/spaces/' + space + '/invitations', 'POST', { email: value, locale: props.language }); email.value = ''; await loadInvitations() }) }
function revoke(value: Invitation) { ask(t.value.revoke + ': ' + value.invitedEmail, async () => { await spaceApi(props.auth, '/spaces/' + value.spaceId + '/invitations/' + value.id + '/revoke', 'POST', {}); await loadInvitations() }) }
function change(member: Member, remove = false) { const space = selected.value!.id, replacement = roles.value[member.id]; ask((remove ? t.value.remove : t.value.change) + ': ' + member.displayName, async () => {
  await spaceApi(props.auth, '/spaces/' + space + '/members/' + member.id + (remove ? '/remove' : '/role'), remove ? 'POST' : 'PUT', remove ? {} : { role: replacement }); await loadSpaces(); await open(space) }) }
function discardDraft() { editingProfile.value = false; profileDraft.value = false; newName.value = ''; email.value = ''; name.value = selected.value?.name ?? ''; roles.value = Object.fromEntries((members.value?.items ?? []).map(m => [m.id, m.role])); emit('draft', false) }
defineExpose({ refresh: () => loadSpaces(), syncRoute: routeChanged, discardDraft })
onMounted(() => { window.addEventListener('popstate', routeChanged); window.addEventListener('hashchange', routeChanged); void work(async () => { await loadSpaces(); const id = savedSelection(); if (id) await open(id) }) })
onUnmounted(() => { disposed = true; ++listGeneration; clearTimeout(searchTimer); window.removeEventListener('popstate', routeChanged); window.removeEventListener('hashchange', routeChanged) })
</script>
<template>
  <section class="spaces-page" :aria-busy="busy">
    <button class="team-mobile-trigger" @click="chooser?.showModal()">{{ selected?.name || (language === 'en' ? 'Choose team' : '选择团队') }} <span aria-hidden="true">⌄</span></button>
    <div class="team-workspace">
    <aside class="team-secondary"><TeamNavigation v-bind="navigationProps" v-on="navigationEvents" /></aside>
    <div class="team-content" :class="{ 'team-content-empty': emptyDetail }" role="region" :aria-label="creationPage ? (language === 'en' ? 'Create team' : '创建团队') : (language === 'en' ? 'Team details' : '团队详情')" tabindex="0">
    <slot v-if="creationPage" />
    <template v-else>
    <div v-if="error" class="notice error" role="alert"><p>{{ error.code === 'VERSION_CONFLICT' ? t.conflict : t.error }} {{ error.code }}</p><p v-if="error.uncertain">{{ t.uncertain }}</p><small v-if="error.requestId">{{ t.request }}: {{ error.requestId }}</small></div>
    <div v-if="notice" class="notice success" role="status">{{ notice }}</div>
      <ElButton v-if="error" :disabled="busy" @click="refreshOverview">{{ language === 'en' ? 'Retry' : '重试' }}</ElButton>
      <section v-if="creating" class="console-card spaces-create"><form class="console-inline" @submit.prevent="create"><label>{{ language === 'en' ? 'Team name' : '团队名称' }}<input ref="createInput" v-model="newName" required maxlength="120" :disabled="busy" /></label><ElButton native-type="submit" type="primary" :disabled="busy || !newName.trim()">{{ t.create }}</ElButton><ElButton :disabled="busy" @click="creating = false; newName = ''">{{ t.cancel }}</ElButton></form></section>
      <p v-if="busy" role="status" class="console-muted">{{ language === 'en' ? 'Loading teams…' : '正在读取团队…' }}</p>
      <div v-if="emptyDetail" class="team-detail-empty">
        <span class="team-empty-icon" aria-hidden="true"><WorkspaceIcon name="users" /></span>
        <h2>{{ noTeams ? (en ? 'Create your first team' : '创建你的第一个团队') : (en ? 'Choose a team' : '选择一个团队') }}</h2>
        <p>{{ noTeams ? (en ? 'Invite members and start working together.' : '邀请伙伴加入，一起开始协作。') : (en ? 'Select a team from the list to view its details.' : '从左侧选择团队，查看详情。') }}</p>
        <ElButton type="primary" @click="showCreate">{{ t.create }}</ElButton>
      </div>
    <TeamCreate v-if="editingProfile && selected" :key="selected.id" :auth="auth" :language="language" :team="selected" @back="closeProfile" @created="finishProfile" @draft="profileDraft = $event" @busy="profileBusy = $event" />
    <section v-else-if="selected && !creating" class="team-detail">
      <header class="team-detail-heading">
        <span class="team-detail-avatar" aria-hidden="true"><img v-if="selected.avatarUrl" :src="selected.avatarUrl" alt=""/><template v-else>{{ Array.from(selected.name)[0] }}</template></span>
        <div class="team-heading-copy"><h2>{{ selected.name }}</h2><div class="team-description-wrap"><p ref="descriptionElement" class="team-description" :class="{ 'is-expanded': descriptionExpanded }">{{ selected.description || (en ? 'No description yet' : '暂无团队简介') }}</p><button v-if="descriptionOverflow" class="team-description-toggle" :aria-expanded="descriptionExpanded" @click="descriptionExpanded = !descriptionExpanded">{{ descriptionExpanded ? (en ? 'Show less' : '收起') : (en ? 'Show more' : '展开') }}</button></div><p class="team-owner-line"><span>{{ en ? 'Owner: ' : '所有者：' }}{{ selected.ownerName || (en ? 'Unavailable' : '暂无信息') }}</span><span v-if="selectedCount !== undefined">{{ selectedCount }} {{ en ? 'members' : '位成员' }}</span></p></div>
        <div class="team-heading-actions"><button v-if="manager && !archived" class="team-profile-edit" :disabled="busy" @click="editingProfile = true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg>{{ en ? 'Edit profile' : '修改资料' }}</button><ElDropdown v-if="selected.role" trigger="click" :disabled="busy" @command="command => command === 'archive' ? setArchive() : leave()"><button class="team-heading-more" :disabled="busy" :aria-label="en ? 'More team actions' : '更多团队操作'">···</button><template #dropdown><ElDropdownMenu><ElDropdownItem v-if="selected.role === 'OWNER'" command="archive">{{ archived ? t.restore : t.archive }}</ElDropdownItem><ElDropdownItem v-else command="leave">{{ en ? 'Leave team' : '退出团队' }}</ElDropdownItem></ElDropdownMenu></template></ElDropdown></div>
      </header>
      <p v-if="archived" class="notice info">{{ t.archived }}</p>
      <nav class="team-detail-tabs" :aria-label="en ? 'Team sections' : '团队详情栏目'">
        <button :aria-pressed="detailTab === 'members'" :disabled="busy" @click="switchTab('members')">{{ t.members }}</button>
        <button v-if="inspector" :aria-pressed="detailTab === 'invitations'" :disabled="busy" @click="switchTab('invitations')">{{ en ? 'Invitations' : '邀请记录' }}</button>
        <button v-if="manager" :aria-pressed="detailTab === 'audit'" :disabled="busy" @click="switchTab('audit')">{{ en ? 'Activity log' : '操作日志' }}</button>
      </nav>
      <section v-if="detailTab === 'members'" :aria-label="t.members">
        <div class="team-members-tools"><input class="team-members-search" type="search" :value="memberQuery" maxlength="254" :disabled="busy" :aria-label="en ? 'Search members by name or email' : '搜索成员名称或邮箱'" :placeholder="en ? 'Search name or email' : '搜索名称或邮箱'" @input="searchMembers(($event.target as HTMLInputElement).value)"/><button v-if="manager && !archived" class="team-add-member" :disabled="busy" :title="en ? 'Invite members' : '邀请成员'" :aria-label="en ? 'Invite members' : '邀请成员'" @click="inviting = true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>
        <div ref="memberTableWrap" class="team-members-table-wrap" :aria-busy="memberLoading" :style="{ minHeight: memberTableHeight + 'px' }">
          <div v-if="members && (memberLoading || memberFailed)" class="team-table-feedback" :role="memberFailed ? 'alert' : 'status'">{{ memberFailed ? (en ? 'Update failed; previous results retained.' : '更新失败，已保留原列表。') : (en ? 'Updating…' : '正在更新…') }}<button v-if="memberFailed" @click="loadMembers()">{{ en ? 'Retry' : '重试' }}</button></div>
          <table class="team-members-table"><colgroup><col class="team-member-identity-col"/><col class="team-member-status-col"/><col class="team-member-role-col"/><col class="team-member-action-col"/></colgroup><thead><tr><th scope="col" :aria-sort="memberSort === 'name' ? (memberOrder === 'asc' ? 'ascending' : 'descending') : 'none'"><button class="team-member-sort" :disabled="busy || memberLoading" @click="sortMembers('name')">{{ en ? 'User' : '用户' }}<span aria-hidden="true">{{ memberSort === 'name' ? (memberOrder === 'asc' ? '↑' : '↓') : '↕' }}</span></button></th><th scope="col">{{ en ? 'Status' : '状态' }}</th><th scope="col" :aria-sort="memberSort === 'role' ? (memberOrder === 'asc' ? 'ascending' : 'descending') : 'none'"><button class="team-member-sort" :disabled="busy || memberLoading" @click="sortMembers('role')">{{ t.role }}<span aria-hidden="true">{{ memberSort === 'role' ? (memberOrder === 'asc' ? '↑' : '↓') : '↕' }}</span></button></th><th scope="col" class="team-member-actions">{{ en ? 'Actions' : '操作' }}</th></tr></thead><tbody>
            <tr v-if="memberLoading && !members"><td colspan="4" class="team-table-state" role="status">{{ en ? 'Loading members…' : '正在加载成员…' }}</td></tr>
            <tr v-else-if="memberFailed && !members"><td colspan="4" class="team-table-state" role="alert">{{ en ? 'Could not load members.' : '成员加载失败。' }}<button class="team-text-action" @click="loadMembers()">{{ en ? 'Retry' : '重试' }}</button></td></tr>
            <tr v-else-if="members && !members.items.length"><td colspan="4" class="team-table-state">{{ memberQuery ? (en ? 'No matching members' : '没有匹配的成员') : (en ? 'No members yet' : '暂无成员') }}<button v-if="memberQuery" class="team-text-action" @click="searchMembers('')">{{ en ? 'Clear search' : '清除搜索' }}</button></td></tr>
            <tr v-for="member in members?.items" :key="member.id" :inert="memberLoading || memberFailed"><td><div class="team-member-person"><span class="team-member-initial" aria-hidden="true">{{ Array.from(member.displayName)[0] }}</span><div class="team-member-identity"><span class="team-member-name">{{ member.displayName }}</span><small v-for="address in member.emails" :key="address" class="team-member-email">{{ address }}</small><small v-if="!member.emails.length" class="team-member-email">{{ en ? 'No linked email' : '未绑定邮箱' }}</small></div></div></td><td><StatusTag :label="member.status === 'ACTIVE' ? (en ? 'Active' : '正常') : statusLabel(member.status)" :value="member.status" /></td><td class="team-member-role">{{ roleLabel(member.role) }}</td><td class="team-member-actions"><template v-if="editableRoles(selected.role, member.role, personal, archived).length || removable(selected.role, member.role, personal)"><button v-if="editableRoles(selected.role, member.role, personal, archived).length" type="button" class="team-member-action" :disabled="busy || member.status !== 'ACTIVE'" :aria-label="(en ? 'Change role: ' : '修改角色：') + member.displayName" @click="manageMember(member)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg>{{ en ? 'Change role' : '修改角色' }}</button><button v-if="removable(selected.role, member.role, personal)" type="button" class="team-member-action team-member-remove-action" :disabled="busy" :aria-label="(en ? 'Remove member: ' : '移除成员：') + member.displayName" @click="change(member, true)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="9" cy="7" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 11h6"/></svg>{{ en ? 'Remove' : '移除' }}</button></template><span v-else class="team-member-no-action" :title="en ? 'No available actions' : '暂无可用操作'">—</span></td></tr>
          </tbody></table>
        </div>
        <div class="team-members-pagination"><span class="team-member-total" aria-live="polite">{{ members ? (en ? members.total + ' members' : '共 ' + members.total + ' 位成员') : '—' }}</span><label><span class="team-table-sr">{{ en ? 'Members per page' : '每页成员数' }}</span><select :value="memberSize" :disabled="busy || memberLoading" @change="resizeMembers(($event.target as HTMLSelectElement).value)"><option v-for="size in [10,25,50]" :key="size" :value="size">{{ en ? size + ' / page' : size + ' 条 / 页' }}</option></select></label><nav :aria-label="en ? 'Member pagination' : '成员分页'"><button :disabled="busy || memberLoading || memberFailed || memberPage <= 1" @click="loadMembers(memberPage - 1)">{{ en ? 'Previous' : '上一页' }}</button><span>{{ memberPage }} / {{ members ? memberPages : '—' }}</span><button :disabled="busy || memberLoading || memberFailed || !members || memberPage >= memberPages" @click="loadMembers(memberPage + 1)">{{ en ? 'Next' : '下一页' }}</button></nav></div>
      </section>
      <section v-if="detailTab === 'invitations' && inspector" :aria-label="en ? 'Invitations' : '邀请记录'">
        <div class="team-invitations-table-wrap" :aria-busy="invitationLoading">
          <p v-if="invitationFailed" role="alert" class="console-muted">{{ en ? 'Could not update invitations.' : '邀请记录更新失败。' }}<button class="team-text-action" @click="loadInvitations(invitationPage)">{{ en ? 'Retry' : '重试' }}</button></p>
          <table class="team-audit-table team-invitations-table"><thead><tr><th>{{ en ? 'Invitee' : '受邀账号' }}</th><th>{{ t.from }}</th><th>{{ en ? 'Status' : '状态' }}</th><th>{{ t.expiry }}</th><th>{{ en ? 'Actions' : '操作' }}</th></tr></thead><tbody>
            <tr v-if="!invitations"><td colspan="5" class="team-audit-state">{{ invitationLoading ? (en ? 'Loading…' : '正在加载…') : '—' }}</td></tr>
            <tr v-else-if="!invitations.items.length"><td colspan="5" class="team-audit-state">{{ en ? 'No invitations yet.' : '暂无邀请记录。' }}</td></tr>
            <tr v-for="invitation in invitations?.items" :key="invitation.id"><td>{{ invitation.invitedEmail }}</td><td>{{ invitation.inviterName }}</td><td><StatusTag :label="statusLabel(invitation.status)" :value="invitation.status"/></td><td class="team-audit-time">{{ dateLabel(invitation.expiresAt) }}</td><td><button v-if="manager && invitation.status === 'PENDING'" class="team-text-action" :disabled="busy || invitationLoading || invitationFailed" @click="revoke(invitation)">{{ t.revoke }}</button><span v-else class="console-muted">—</span></td></tr>
          </tbody></table>
        </div>
        <div v-if="invitations" class="team-audit-pagination"><span>{{ en ? 'Total ' + invitations.total : '共 ' + invitations.total + ' 条' }} · {{ invitations.total ? (invitations.page - 1) * invitations.pageSize + 1 : 0 }}–{{ Math.min(invitations.page * invitations.pageSize, invitations.total) }}</span><ElConfigProvider :locale="en ? enLocale : zhCn"><ElPagination small :current-page="invitationPage" :page-size="invitationSize" :page-sizes="[10,25,50]" :total="invitations.total" :pager-count="5" :disabled="busy || invitationLoading || invitationFailed" layout="sizes, prev, pager, next, jumper" @size-change="resizeInvitations" @current-change="loadInvitations" /></ElConfigProvider></div>
      </section>
      <section v-if="detailTab === 'audit' && inspector" :aria-label="en ? 'Activity log' : '操作日志'">
        <div ref="auditTableWrap" class="team-audit-table-wrap" :aria-busy="auditLoading" :style="{ minHeight: auditTableHeight + 'px' }"><div v-if="audit && (auditLoading || auditFailed)" class="team-table-feedback" :role="auditFailed ? 'alert' : 'status'">{{ auditFailed ? (en ? 'Update failed; previous results retained.' : '更新失败，已保留原列表。') : (en ? 'Updating…' : '正在更新…') }}<button v-if="auditFailed" @click="loadAudit(auditPage)">{{ en ? 'Retry' : '重试' }}</button></div><table class="team-audit-table"><thead><tr><th>{{ en ? 'Time' : '时间' }}</th><th>{{ en ? 'Action' : '操作' }}</th><th>{{ en ? 'Actor' : '操作人' }}</th><th>{{ en ? 'Result' : '结果' }}</th><th>{{ t.request }}</th></tr></thead><tbody>
          <tr v-if="auditLoading && !audit"><td colspan="5" class="team-audit-state" role="status">{{ en ? 'Loading…' : '正在加载…' }}</td></tr>
          <tr v-else-if="auditFailed && !audit"><td colspan="5" class="team-audit-state" role="alert">{{ en ? 'Could not load activity.' : '日志加载失败。' }}<button class="team-text-action" @click="loadAudit(auditPage)">{{ en ? 'Retry' : '重试' }}</button></td></tr>
          <tr v-else-if="audit && !audit.items.length"><td colspan="5" class="team-audit-state">{{ en ? 'No activity yet.' : '暂无操作记录。' }}</td></tr>
          <template v-else><tr v-for="event in audit?.items" :key="event.id"><td class="team-audit-time">{{ dateLabel(event.occurredAt) }}</td><td><span class="team-audit-action">{{ event.outcome === 'DENIED' ? (en ? 'Attempted: ' : '尝试：') : '' }}{{ auditLabel(event.action) }}<template v-if="event.targetName"> | {{ event.targetName }}</template></span><small v-if="auditSummary(event)">{{ auditSummary(event) }}</small></td><td>{{ event.actorName || (en ? 'System' : '系统') }}</td><td><StatusTag :label="statusLabel(event.outcome)" :value="event.outcome" /></td><td class="team-audit-request">{{ event.requestId || '—' }}</td></tr></template>
        </tbody></table></div>
        <div v-if="audit" class="team-audit-pagination"><span>{{ en ? 'Total ' + audit.total : '共 ' + audit.total + ' 条' }} · {{ audit.total ? (audit.page - 1) * audit.pageSize + 1 : 0 }}–{{ Math.min(audit.page * audit.pageSize, audit.total) }}</span><ElConfigProvider :locale="en ? enLocale : zhCn"><ElPagination small :current-page="auditPage" :page-size="auditSize" :page-sizes="[10,25,50]" :total="audit.total" :pager-count="5" :disabled="busy || auditLoading || auditFailed" layout="sizes, prev, pager, next, jumper" @size-change="resizeAudit" @current-change="loadAudit" /></ElConfigProvider></div>
      </section>
    </section>
    </template></div></div>
    <TeamInvite v-if="inviting && selected" :auth="auth" :language="language" :space-id="selected.id" @close="inviting = false" @sent="invited" />
    <MemberRoleEditor v-if="managedMember && selected" :auth="auth" :space-id="selected.id" :language="language" :member="managedMember" :options="editableRoles(selected.role, managedMember.role, personal, archived)" @close="managedMember = undefined" @saved="memberRoleSaved" />
    <dialog ref="chooser" class="team-chooser" :aria-label="language === 'en' ? 'Choose team' : '选择团队'"><header><h2>{{ language === 'en' ? 'Teams' : '团队列表' }}</h2><button @click="chooser?.close()">{{ language === 'en' ? 'Close' : '关闭' }}</button></header><TeamNavigation v-bind="navigationProps" v-on="navigationEvents" /></dialog>
    <dialog ref="switchDialog" class="console-modal" aria-labelledby="team-switch-title" @cancel="cancelSwitch"><section class="console-card"><h2 id="team-switch-title">{{ language === 'en' ? 'Unsaved changes' : '有未保存的修改' }}</h2><p>{{ language === 'en' ? 'Continue and discard these changes?' : '继续操作将放弃当前未保存的修改，是否继续？' }}</p><div class="console-actions"><ElButton autofocus @click="cancelSwitch">{{ language === 'en' ? 'Keep editing' : '继续编辑' }}</ElButton><ElButton @click="confirmSwitch">{{ language === 'en' ? 'Continue' : '继续' }}</ElButton></div></section></dialog>
    <dialog ref="dialog" class="console-modal" aria-labelledby="space-confirm-title" @cancel="pending = undefined"><section v-if="pending" class="console-card"><h2 id="space-confirm-title">{{ pending.label }}</h2><p>{{ t.confirmHint }}</p><div class="console-actions"><ElButton autofocus @click="pending = undefined">{{ t.cancel }}</ElButton><ElButton type="primary" @click="confirm">{{ t.confirm }}</ElButton></div></section></dialog>
  </section>
</template>
<style>
.team-invitations-table-wrap { overflow-x:auto; }
.team-audit-table.team-invitations-table { min-width:940px; }
.team-audit-table.team-invitations-table th,.team-audit-table.team-invitations-table td { padding:10px 16px; line-height:20px; vertical-align:middle; }
.team-audit-table.team-invitations-table th:first-child { width:auto; }
.team-audit-table.team-invitations-table th:nth-child(2) { width:144px; }
.team-audit-table.team-invitations-table th:nth-child(3) { width:100px; }
.team-audit-table.team-invitations-table th:nth-child(4) { width:208px; }
.team-audit-table.team-invitations-table th:last-child { width:72px; }
.team-audit-table.team-invitations-table td:nth-child(4) { white-space:nowrap; font-variant-numeric:tabular-nums; }
.team-audit-table.team-invitations-table th:last-child,.team-audit-table.team-invitations-table td:last-child { text-align:right; }

.team-members-table-wrap,.team-audit-table-wrap { position:relative; overflow-anchor:none; }
.team-table-feedback { position:absolute; top:0; right:0; z-index:2; display:flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:var(--surface); color:var(--muted); font-size:12px; }
.team-table-feedback button { border:0; background:transparent; color:var(--accent); }
.team-members-table-wrap[aria-busy="true"] tbody,.team-audit-table-wrap[aria-busy="true"] tbody { opacity:.55; }

.team-heading-actions { display:flex; align-items:center; gap:4px; justify-self:end; }
.team-detail .team-heading-more { border:0; background:transparent; color:var(--muted); border-radius:6px; width:32px; height:32px; font-size:20px; }
.team-detail .team-heading-more:hover { background:var(--sidebar); }
.team-audit-table-wrap { overflow-x:auto; }
.team-audit-table { width:100%; min-width:880px; border-collapse:collapse; table-layout:fixed; font-size:13px; }
.team-audit-table th { font-size:12px; font-weight:500; color:var(--muted); text-align:left; padding:8px; border-bottom:1px solid var(--line); }
.team-audit-table th:first-child { width:150px; }.team-audit-table th:nth-child(3) { width:100px; }.team-audit-table th:nth-child(4) { width:72px; }.team-audit-table th:last-child { width:236px; }
.team-audit-table td { padding:10px 8px; line-height:20px; vertical-align:top; border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent); overflow-wrap:anywhere; }
.team-audit-table th:first-child,.team-audit-table td:first-child { padding-left:0; }.team-audit-time { color:var(--muted); font-size:12px; }
.team-audit-table small { display:block; font-size:12px; color:var(--muted); margin-top:3px; line-height:18px; }
.team-audit-action { font-weight:500; color:var(--ink); }
.team-audit-table .team-audit-request { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; color:var(--muted); user-select:all; overflow-wrap:anywhere; }
.team-audit-table .team-audit-state { text-align:center; padding:32px 8px; color:var(--muted); }
.team-audit-pagination { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-top:16px; font-size:12px; color:var(--muted); }
.team-audit-pagination .el-pagination { flex-wrap:wrap; gap:8px; --el-color-primary:var(--accent); }
@media(max-width:760px){.team-heading-actions { grid-column:2; }.team-detail .team-heading-more { width:44px; height:44px; }.team-audit-pagination .el-pagination { white-space:normal; }}

.team-detail .team-member-sort { display:inline-flex; align-items:center; gap:6px; padding:0; border:0; background:transparent; color:inherit; font:inherit; font-weight:500; }
.team-member-sort span { font-size:14px; color:var(--muted); }
.team-detail .team-member-sort:hover:not(:disabled) { color:var(--ink); }
.team-member-sort:focus-visible { outline:2px solid var(--accent); outline-offset:4px; border-radius:2px; }
.team-detail .team-member-action { display:inline-flex; align-items:center; justify-content:center; gap:5px; border:1px solid var(--line); border-radius:6px; background:transparent; padding:5px 8px; min-height:32px; font-size:12px; line-height:20px; color:var(--muted); vertical-align:middle; }
.team-member-action svg { width:14px; height:14px; flex-shrink:0; }
.team-detail .team-member-action + .team-member-action { margin-left:6px; }
.team-detail .team-member-action:hover:not(:disabled) { background:var(--sidebar); }
.team-detail .team-member-action:hover:not(:disabled) { color:var(--ink); }
.team-detail .team-member-remove-action:hover:not(:disabled) { color:#b42318; background:#b423180a; border-color:#b4231840; }
@media(max-width:760px){.team-detail .team-member-action { min-height:44px; }}
.team-members-tools { display:flex; align-items:center; gap:8px; margin:0 0 16px; }
.team-members-tools .team-members-search { width:min(360px,100%); min-width:0; height:34px; padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:var(--surface); color:var(--ink); font:inherit; font-size:13px; }
.team-members-tools .team-members-search:focus { outline:2px solid #85858f; outline-offset:-2px; box-shadow:none; }
.team-members-tools .team-add-member { flex-shrink:0; border:0; }
.team-members-table-wrap { position:relative; overflow-x:auto; scrollbar-width:thin; }
.team-members-table { width:100%; min-width:640px; table-layout:fixed; border-collapse:collapse; font-size:13px; }
.team-member-identity-col { width:auto; }.team-member-status-col { width:88px; }.team-member-role-col { width:104px; }.team-member-action-col { width:180px; }
.team-members-table th { padding:8px 8px; background:transparent; color:var(--muted); font-size:12px; line-height:20px; font-weight:500; text-align:left; border-bottom:1px solid var(--line); }
.team-members-table td { padding:8px 8px; line-height:20px; border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent); vertical-align:middle; }
.team-members-table td:first-child,.team-members-table th:first-child { padding-left:0; }
.team-members-table .team-member-actions { text-align:right; white-space:nowrap; }
.team-member-no-action { color:var(--muted); }
.team-members-table tbody tr:hover { background:color-mix(in srgb,var(--sidebar) 50%,transparent); }
.team-member-identity { min-width:0; overflow-wrap:anywhere; }
.team-members-table .team-member-email { display:block; font-size:12px; line-height:18px; color:var(--muted); margin-top:0; }
.team-members-table .team-table-state { text-align:center; height:140px; color:var(--muted); }
.team-members-pagination { display:flex; align-items:center; justify-content:flex-end; gap:12px; flex-wrap:wrap; margin-top:20px; color:var(--muted); font-size:12px; }
.team-member-total { margin-right:auto; }
.team-members-pagination nav { display:flex; align-items:center; gap:10px; }
.team-members-pagination select,.team-members-pagination button { background:var(--surface); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:inherit; }
.team-members-pagination button:hover:not(:disabled) { background:var(--sidebar); }
.team-table-sr { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
@media(max-width:760px){.team-members-tools .team-members-search { flex:1; height:44px; font-size:16px; }.team-members-pagination button,.team-members-pagination select { min-height:44px; }}
.team-detail { padding:8px 24px 24px; }
.team-heading-copy { flex:1; min-width:0; }
.team-detail .team-detail-heading { align-items:flex-start; margin-bottom:28px; }
.team-detail button { font:inherit; cursor:pointer; }
.team-detail button:disabled { opacity:.5; cursor:default; }
.team-detail .team-profile-edit { display:flex; align-items:center; gap:7px; margin-left:auto; padding:6px 8px; border:0; background:transparent; color:var(--muted); font-size:13px; border-radius:6px; white-space:nowrap; }
.team-detail svg { width:16px; height:16px; flex-shrink:0; }
.team-detail .team-profile-edit:hover,.team-detail .team-member-more:hover,.team-detail .team-text-action:hover { background:var(--sidebar); color:var(--ink); }
.spaces-page .team-detail .team-detail-tabs { display:flex; gap:28px; margin-bottom:20px; flex-wrap:wrap; }
.spaces-page .team-detail .team-detail-tabs button { appearance:none; box-shadow:none; min-width:0; min-height:40px; border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; padding:8px 0 12px; color:var(--muted); font-size:14px; font-weight:400; }
.spaces-page .team-detail .team-detail-tabs button[aria-pressed=true] { background:transparent; color:var(--ink); border-bottom-color:var(--ink); font-weight:500; }
.spaces-page .team-detail .team-detail-tabs button:hover:not(:disabled) { color:var(--ink); }
.team-list-toolbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; color:var(--muted); font-size:13px; min-height:36px; }
.team-list-toolbar.team-member-toolbar { justify-content:flex-end; }
.team-detail .team-add-member { width:34px; height:34px; display:grid; place-items:center; padding:0; border:1px solid var(--line); border-radius:7px; background:transparent; color:var(--ink); }
.team-detail .team-add-member:hover { background:var(--sidebar); }
.team-member-columns,.team-member-row { display:grid; grid-template-columns:minmax(0,1fr) 100px 32px; gap:16px; align-items:center; border-bottom:1px solid var(--line); }
.team-member-columns { color:var(--muted); font-size:12px; padding:8px 0; }
.team-member-row { padding:16px 0; }
.team-member-person { display:flex; gap:12px; align-items:center; min-width:0; }
.team-member-initial { display:grid; place-items:center; width:34px; height:34px; flex-shrink:0; border-radius:10px; background:var(--sidebar); color:var(--muted); font-size:14px; }
.team-member-name { font-size:14px; overflow-wrap:anywhere; }
.team-member-name small { display:block; margin-top:4px; }
.team-member-role { color:var(--muted); font-size:13px; }
.team-detail .team-member-more { border:0; background:transparent; padding:6px; border-radius:6px; color:var(--muted); font-size:20px; line-height:1; }
.team-pagination { display:flex; justify-content:flex-end; gap:8px; margin-top:20px; }
.team-pagination .el-button { font-size:12px; border:0; background:transparent; color:var(--muted); }
.team-pagination .el-button.is-disabled { opacity:.4; }
.team-section-empty { color:var(--muted); text-align:center; padding:48px 16px; font-size:13px; }
.team-invitation-row,.team-audit-row { display:flex; align-items:center; gap:16px; padding:18px 0; border-bottom:1px solid var(--line); font-size:14px; }
.team-invitation-row>div:first-child,.team-audit-row>div:first-child { flex:1; min-width:0; overflow-wrap:anywhere; }
.team-invitation-row small,.team-audit-row small { display:block; color:var(--muted); font-size:12px; margin-top:6px; }
.team-audit-row details { margin-top:10px; color:var(--muted); font-size:12px; }
.team-audit-row summary { cursor:pointer; }
.team-detail .team-text-action { border:0; background:transparent; color:var(--muted); border-radius:6px; padding:6px 8px; font-size:13px; white-space:nowrap; }
.team-detail .team-danger { color:#a14343; }
.team-setting-row { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:24px 0; border-bottom:1px solid var(--line); }
.team-setting-row h3 { margin:0; font-size:14px; font-weight:500; }
.team-setting-row p { margin:8px 0 0; font-size:13px; color:var(--muted); }
.team-setting-row code { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.team-member-dialog label { display:flex; flex-direction:column; gap:8px; margin:24px 0; }
@media(max-width:760px){.team-detail { padding:8px 12px 16px; }.team-detail .team-detail-heading { gap:12px; flex-wrap:wrap; }.spaces-page .team-detail .team-detail-tabs { gap:20px; }.team-detail .team-profile-edit { min-height:44px; }.team-member-row,.team-member-columns { grid-template-columns:minmax(0,1fr) 68px 44px; gap:8px; }.team-detail .team-add-member,.team-detail .team-member-more { width:44px; min-height:44px; }.team-setting-row { flex-wrap:wrap; }.team-invitation-row { flex-wrap:wrap; }.team-invitation-row>div:first-child { flex-basis:100%; }}
.team-workspace { display:grid; grid-template-columns:192px minmax(0,1fr); gap:8px; min-height:0; }
.team-secondary { border-right:1px solid var(--line); padding-right:8px; min-width:0; }
.team-content { min-width:0; }
.team-detail.console-card { margin:0; padding:24px; }
.team-detail-heading { display:flex; align-items:center; gap:16px; margin-bottom:24px; }
.team-detail-heading h2 { margin:0; font-size:22px; font-weight:500; overflow-wrap:anywhere; }
.team-detail-heading p { margin:6px 0 0; color:var(--muted); font-size:13px; }
.team-detail-avatar { display:grid; place-items:center; flex:0 0 48px; height:48px; background:#e9edfb; color:var(--accent); border-radius:12px; font-size:22px; }
.team-detail-avatar { overflow:hidden; }
.team-detail-avatar img { width:48px; height:48px; object-fit:cover; }
.team-description { white-space:pre-wrap; overflow-wrap:anywhere; }
.team-detail .team-detail-heading { display:grid; grid-template-columns:96px minmax(0,1fr) auto; gap:20px; align-items:start; }
.team-detail .team-detail-avatar { width:96px; height:96px; border-radius:16px; font-size:34px; }
.team-detail .team-detail-avatar img { width:100%; height:100%; object-fit:cover; }
.team-detail .team-heading-copy { display:flex; flex-direction:column; justify-content:space-between; gap:4px; min-height:96px; }
.team-detail .team-heading-copy h2 { line-height:28px; }
.team-detail .team-description { margin:0; line-height:20px; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
.team-detail .team-description.is-expanded { display:block; }
.team-detail .team-description-toggle { border:0; background:transparent; padding:2px 0; color:var(--accent); font-size:12px; }
.team-detail .team-owner-line { display:flex; flex-wrap:wrap; gap:4px 12px; margin:0; line-height:20px; overflow-wrap:anywhere; }
.team-owner-line>span+span::before { content:'|'; margin-right:12px; }
@media(max-width:760px){.team-detail .team-detail-heading { grid-template-columns:80px minmax(0,1fr); gap:12px; }.team-detail .team-detail-avatar { width:80px; height:80px; font-size:30px; }.team-detail .team-heading-copy { min-height:80px; }.team-detail .team-heading-copy h2 { font-size:20px; line-height:24px; }.team-detail .team-profile-edit { grid-column:2; justify-self:end; margin-top:-4px; }}
.team-detail-tabs { display:flex; gap:20px; border-bottom:1px solid var(--line); margin-bottom:24px; }
.team-detail .team-detail-tabs button { border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; padding:8px 0; color:var(--muted); }
.team-detail .team-detail-tabs button[aria-pressed=true] { border-bottom-color:var(--accent); color:var(--ink); }
.team-content-empty { display:flex; flex-direction:column; }
.team-detail-empty { flex:1; min-height:280px; box-sizing:border-box; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:32px 24px; text-align:center; }
.team-empty-icon { display:grid; place-items:center; width:56px; height:56px; margin-bottom:20px; border-radius:14px; background:var(--surface); color:var(--muted); }
.team-empty-icon svg { width:28px; height:28px; }
.team-detail-empty h2 { margin:0; font-size:18px; line-height:1.5; font-weight:500; }
.team-detail-empty p { margin:8px 0 24px; max-width:320px; color:var(--muted); font-size:14px; line-height:1.7; }
.team-detail-empty .el-button { min-height:40px; margin:0; }
@media(max-width:760px) { .team-detail-empty .el-button { min-height:44px; } }
.team-mobile-trigger { display:none; }
.team-chooser { margin:0; width:min(300px,90vw); height:100svh; max-height:100svh; padding:20px; border:0; background:var(--surface); color:var(--ink); }
.team-chooser::backdrop { background:#19191b55; }
.team-chooser header { display:flex; align-items:center; justify-content:space-between; margin-bottom:24px; }
.team-chooser h2 { font-size:18px; font-weight:500; }
.team-chooser header button { background:transparent; color:var(--muted); border:0; min-height:44px; padding:8px; cursor:pointer; }
@media(max-width:1000px) { .team-workspace { grid-template-columns:minmax(0,1fr); } .team-secondary { display:none; } .team-mobile-trigger { display:flex; align-items:center; justify-content:space-between; gap:16px; width:100%; min-height:44px; padding:10px 12px; margin-bottom:16px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--ink); text-align:left; cursor:pointer; } .team-detail.console-card { padding:16px; } }
.spaces-toolbar { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-bottom:24px; }
.spaces-create { margin-bottom:24px; }
.team-group { margin:0 0 32px; }
.team-group h2 { display:flex; align-items:center; gap:8px; margin:0 0 16px; font-size:16px; font-weight:500; }
.team-group h2 > span { color:var(--muted); font-size:13px; font-weight:400; }
.team-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr)); gap:16px; }
.team-card { display:flex; flex-direction:column; gap:24px; min-width:0; min-height:148px; padding:20px; text-align:left; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--ink); cursor:pointer; }
.team-card:hover:not(:disabled) { background:#fafafa; border-color:#c6c6ce; }
.team-card:disabled { cursor:wait; }
.team-card-main { display:flex; align-items:center; gap:16px; min-width:0; }
.team-avatar { display:grid; place-items:center; width:48px; height:48px; flex-shrink:0; overflow:hidden; border-radius:12px; background:#e9edfb; color:#5068b7; font-size:22px; font-weight:500; }
.team-avatar img { width:100%; height:100%; object-fit:cover; }
.team-card-copy { display:flex; flex-direction:column; gap:6px; min-width:0; }
.team-members { color:var(--muted); font-size:13px; }
.team-card-bottom { display:flex; align-items:center; justify-content:space-between; gap:12px; color:var(--muted); font-size:12px; }
.team-card strong { font-size:16px; font-weight:500; overflow-wrap:anywhere; line-height:1.5; }
.team-card-bottom { margin-top:auto; }
.team-empty { margin:0; padding:16px 0; color:var(--muted); font-size:13px; border-top:1px solid var(--line); }
@media(max-width:760px) { .team-card { padding:16px; } }
</style>
