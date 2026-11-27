<script setup lang="ts">
import { useAccountContext } from "../../shared/api/account-context.ts";
import { lazyComponent } from "../../shared/components/lazy-component.ts";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AuthError } from "../../shared/api/account-client.ts";
import { accountErrorMessage } from "../../shared/api/errors.ts";

const PlatformClients = lazyComponent(() => import("./PlatformClients.vue"));
const { client, run, submitWrite, submitBusyWrite, mutate, discard, expireAccount, expireWithToast } = useAccountContext();
const props = defineProps<{
  capabilities: string[];
  busy: boolean;
}>();
const applicationSearch = ref("");

interface Application {
  applicationId: string;
  name: string;
  status: string;
  version: number;
}

const applications = ref<Application[]>([]);
const selectedApplication = ref<Application>();
const applicationClientCounts = ref(new Map<string, number>());
const createApplicationDialog = ref<HTMLDialogElement>();
const createApplicationError = ref("");
const platformClients = ref<{ openCreate: () => void; busy: boolean }>();
const filteredApplications = computed(() => {
  const query = applicationSearch.value.trim().toLowerCase();
  return applications.value.filter(application => application.name.toLowerCase().includes(query));
});
const newApplicationName = ref(""),
  appName = ref(""),
  appStatus = ref("ACTIVE");

watch(newApplicationName, () => discard("create-application"), { flush: "sync" });
watch([appName, appStatus, () => selectedApplication.value?.applicationId, () => selectedApplication.value?.version],
  () => discard("edit-application"), { flush: "sync" });

function can(capability: string) {
  return props.capabilities.includes(capability);
}

onMounted(() => {
  selectedApplication.value = undefined;
  void run(async () => {
    applicationClientCounts.value.clear();
    applications.value = await list("/platform/applications");
    if (!selectedApplication.value && applications.value[0]) openApplication(applications.value[0]);
  });
});

onBeforeUnmount(() => {
  selectedApplication.value = undefined;
  createApplicationDialog.value?.close();
});

async function list<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: { items: T[]; nextCursor: string | null } =
      await client.request<{ items: T[]; nextCursor: string | null }>(
        path +
          "?limit=100" +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
    result.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw Error("分页状态发生变化，请刷新");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}

function openApplication(a: Application) {
  selectedApplication.value = a;
  appName.value = a.name;
  appStatus.value = a.status;
}
function openCreateApplication() {
  if (props.busy) return;
  newApplicationName.value = "";
  createApplicationError.value = "";
  createApplicationDialog.value?.showModal();
}
function closeCreateApplication() {
  if (!props.busy) createApplicationDialog.value?.close();
}
async function createApplication() {
  const name = newApplicationName.value.trim();
  if (props.busy || !name) return;
  createApplicationError.value = "";
  try {
    await submitBusyWrite<Application>("/platform/applications", { name }, {
      action: "create-application",
      success: "应用已创建",
      refreshMessage: "应用已创建，但应用列表暂未刷新。",
      committed: created => {
        newApplicationName.value = "";
        applications.value = [...applications.value.filter(a => a.applicationId !== created.applicationId), created];
        applicationSearch.value = "";
        createApplicationDialog.value?.close();
        openApplication(created);
      },
      after: async () => { applications.value = await list("/platform/applications"); },
    });
  } catch (error) {
    if (error instanceof AuthError && error.code === "CANCELLED") return;
    if (!expireAccount(error)) createApplicationError.value = accountErrorMessage(error);
  }
}
function editApplication() {
  const application = selectedApplication.value;
  if (!application) return;
  return mutate<Application>("/platform/applications/" + application.applicationId, {
    name: appName.value, status: appStatus.value, expectedVersion: application.version,
  }, {
    method: "PATCH",
    action: "edit-application",
    success: "应用已保存",
    refreshMessage: "应用已保存，但应用列表暂未刷新。",
    committed: saved => {
      applications.value = applications.value.map(a => a.applicationId === saved.applicationId ? saved : a);
      openApplication(saved);
    },
    after: async saved => {
      applications.value = await list("/platform/applications");
      const latest = applications.value.find(a => a.applicationId === saved.applicationId);
      if (latest && selectedApplication.value?.applicationId === saved.applicationId &&
        selectedApplication.value.version === saved.version &&
        appName.value === saved.name && appStatus.value === saved.status) openApplication(latest);
    },
  });
}
</script>

<template>
  <section class="applications-page">
    <div class="applications-layout">
      <aside class="applications-rail" aria-label="应用列表">
        <div class="apps-rail-head">
          <h1>应用管理</h1>
          <span class="apps-rail-count">{{ applications.length }}</span>
        </div>
        <input v-model="applicationSearch" class="app-search" type="search" aria-label="搜索应用" placeholder="搜索应用…" />
        <button v-if="can('APPLICATION_WRITE')" type="button" class="app-create-trigger" :disabled="busy" @click="openCreateApplication">
          ＋ 创建应用
        </button>
        <div class="apps-rail-list">
          <button
            v-for="application in filteredApplications"
            :key="application.applicationId"
            type="button"
            class="app-rail-item"
            :aria-current="selectedApplication?.applicationId === application.applicationId ? 'true' : undefined"
            :disabled="busy"
            @click="openApplication(application)"
          >
            <span class="app-avatar-sm" aria-hidden="true">{{ application.name.slice(0, 1) }}</span>
            <span class="app-rail-body">
              <span class="app-rail-top">
                <span class="app-rail-name">{{ application.name }}</span>
                <span class="app-dot" :class="{ 'is-on': application.status === 'ACTIVE' }" aria-hidden="true" />
              </span>
              <span class="app-rail-sub">
                {{ can('CLIENT_READ') && applicationClientCounts.has(application.applicationId)
                  ? applicationClientCounts.get(application.applicationId) + ' 个客户端'
                  : application.status }}
              </span>
            </span>
          </button>
          <p v-if="applicationSearch.trim() && !filteredApplications.length" class="app-list-hint">没有匹配的应用</p>
        </div>
      </aside>

      <div class="applications-detail">
        <p v-if="!selectedApplication && !busy" class="app-list-hint">暂无可管理的应用</p>
        <div v-if="selectedApplication" class="applications-detail-inner">
          <header class="app-page-head">
            <div class="app-head-left">
              <span class="app-avatar-lg" aria-hidden="true">{{ selectedApplication.name.slice(0, 1) }}</span>
              <div class="app-head-copy">
                <div class="app-head-row">
                  <h2>{{ selectedApplication.name }}</h2>
                  <span class="app-status-pill" :class="selectedApplication.status === 'ACTIVE' ? 'is-active' : 'is-disabled'">
                    <i class="app-status-dot" aria-hidden="true"></i>{{ selectedApplication.status }}
                  </span>
                </div>
                <p class="app-head-meta">
                  {{ selectedApplication.applicationId }}<template v-if="can('CLIENT_READ') && applicationClientCounts.has(selectedApplication.applicationId)">
                    · {{ applicationClientCounts.get(selectedApplication.applicationId) }} 个已登记客户端
                  </template>
                </p>
              </div>
            </div>
            <button
              v-if="can('CLIENT_WRITE')"
              type="button"
              class="app-button is-primary"
              :disabled="busy || !platformClients || platformClients.busy"
              @click="platformClients?.openCreate()"
            >
              ＋ 登记登录客户端
            </button>
          </header>

          <section v-if="can('APPLICATION_WRITE')" class="app-settings-card">
            <div class="app-card-head"><h3>应用基础设置</h3></div>
            <form class="app-edit-card" @submit.prevent="editApplication">
              <label class="app-field app-name-field">
                应用名称
                <input v-model="appName" :disabled="busy" required maxlength="80" />
              </label>
              <label class="app-field app-status-field">
                状态
                <select v-model="appStatus" :disabled="busy" aria-label="应用状态">
                  <option>ACTIVE</option>
                  <option>DISABLED</option>
                </select>
              </label>
              <button type="submit" class="app-button is-primary" :disabled="busy || (appName === selectedApplication.name && appStatus === selectedApplication.status)">保存应用</button>
            </form>
          </section>

          <PlatformClients
            v-if="can('CLIENT_READ') || can('CLIENT_WRITE')"
            :key="selectedApplication.applicationId"
            ref="platformClients"
            :application-id="selectedApplication.applicationId"
            :client="client"
            :capabilities="capabilities"
            :submit-write="submitWrite"
            @count="(id, count) => applicationClientCounts.set(id, count)"
            @expired="expireWithToast"
          />
        </div>
      </div>
    </div>

    <dialog
      v-if="can('APPLICATION_WRITE')"
      ref="createApplicationDialog"
      class="app-operation-dialog app-create-dialog"
      aria-labelledby="app-create-title"
      @cancel.prevent="closeCreateApplication"
    >
      <form @submit.prevent="createApplication">
        <header class="app-dialog-head">
          <h3 id="app-create-title">创建应用</h3>
          <button type="button" class="app-dialog-close" aria-label="关闭" :disabled="busy" @click="closeCreateApplication">×</button>
        </header>
        <div class="app-dialog-body">
          <label class="app-field">
            应用名称
            <input v-model="newApplicationName" :disabled="busy" required autofocus maxlength="80" placeholder="例如：Molis Studio" />
          </label>
          <p v-if="createApplicationError" class="app-dialog-error" role="alert">{{ createApplicationError }}</p>
        </div>
        <footer class="app-dialog-foot">
          <button type="button" class="app-button" :disabled="busy" @click="closeCreateApplication">取消</button>
          <button type="submit" class="app-button is-primary" :disabled="busy || !newApplicationName.trim()">创建</button>
        </footer>
      </form>
    </dialog>
  </section>
</template>

<style src="./applications-page.css"></style>
