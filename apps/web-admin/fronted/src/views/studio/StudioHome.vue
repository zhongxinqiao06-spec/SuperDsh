<script setup lang="ts">
import { nextTick, ref, onScopeDispose, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/store/modules/auth-store'
import { initialBrief, projectBrief } from '@/utils/studio/foundation'
import { newId } from '@/utils/studio/storyboard'
import StudioBriefFields from './components/project/StudioBriefFields.vue'
import type { WorkMode, WorkSummary } from '@/types/studio/works'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { useMutation } from '@/composables/use-mutation'
import { useStudioDirectory } from '@/composables/studio/use-studio-directory'
import { studioApi } from '@/api/studio/studio-api'
import { worksApi } from '@/api/studio/works-api'
import StudioWorkCard from './components/StudioWorkCard.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import SeriesCreateDialog from './components/series/SeriesCreateDialog.vue'

const auth = useAuthStore()
const lifecycle = ref('active')
const mode = ref<WorkMode | 'all'>('all')
const controller = new AbortController()
onScopeDispose(() => controller.abort())
const { page, pageSize, data, query, search, filter, loading, error, reload } =
  useStudioDirectory(
    (query, signal) =>
      worksApi.page(
        { ...query, lifecycle: lifecycle.value, mode: mode.value },
        signal,
      ),
    [lifecycle, mode],
  )
const router = useRouter()
const route = useRoute()
const creating = ref(false)
const creatingSeries = ref(false)
watch(
  () => route.query.create,
  (value, previous) => {
    if (value === 'series') creatingSeries.value = true
    else if (previous === 'series') creatingSeries.value = false
  },
  { immediate: true },
)
/** 旧新建链接仍可打开弹窗；确认关闭后清理入口参数，重新打开获得独立草稿。 */
async function closeSeries(open: boolean) {
  creatingSeries.value = open
  if (!open && route.query.create === 'series') {
    await nextTick()
    const query = { ...route.query }
    delete query.create
    await router.replace({ query })
  }
}
async function seriesCreated(id: string, openEditor: boolean) {
  creatingSeries.value = false
  // 先卸载已保存的弹窗及路由保护，再进入新工程，避免成功提交后重复询问。
  await nextTick()
  if (openEditor) {
    await router.push({
      path: '/entertainment/series/' + encodeURIComponent(id),
      query: { section: 'episodes' },
    })
  } else await reload()
}
const form = ref(projectBrief())
let creationKey = newId()
let creationSignature = ''
const mutation = useMutation()
function clearFilter() {
  query.value = ''
  filter()
}
async function start() {
  if (
    await mutation.run(async () => {
      form.value = initialBrief(
        await studioApi.creationDefaults(controller.signal),
      )
    })
  ) {
    creationKey = newId()
    creating.value = true
  }
}
/** 三种入口仅决定创作组织方式，共用账号与制作能力。 */
async function startMode(value: string) {
  if (!auth.can('studio.projects.write')) return
  if (value === 'series') {
    creatingSeries.value = true
  } else if (value === 'quick') {
    await router.push('/entertainment/quick/new')
  } else await start()
}
async function create() {
  if (!form.value.title.trim()) return
  const signature = JSON.stringify(form.value)
  if (signature !== creationSignature) {
    creationKey = newId()
    creationSignature = signature
  }
  let id = ''
  if (
    await mutation.run(async () => {
      id = (await studioApi.create({ ...form.value, requestKey: creationKey }))
        .id
    })
  ) {
    creating.value = false
    await router.push({
      path: '/entertainment/' + encodeURIComponent(id),
      query: { section: 'script' },
    })
  }
}
async function archive(project: WorkSummary) {
  const archived = project.lifecycle !== 'archived'
  const confirmed = await ElMessageBox.confirm(
    archived
      ? '归档后保留工程和成果，恢复后可继续制作。是否归档？'
      : '恢复这部作品并继续制作？',
    archived ? '归档作品' : '恢复作品',
    { confirmButtonText: archived ? '归档' : '恢复', cancelButtonText: '取消' },
  )
    .then(() => true)
    .catch(() => false)
  if (
    confirmed &&
    (await mutation.run(async () => {
      await worksApi.archive(project, archived, newId())
    }))
  )
    await reload()
}
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader title="我的作品" />
    <el-tabs v-model="mode" class="works-tabs" aria-label="作品分类">
      <el-tab-pane label="全部" name="all" />
      <el-tab-pane label="快速视频" name="quick" />
      <el-tab-pane label="分镜作品" name="storyboard" />
      <el-tab-pane label="系列短剧" name="series" />
    </el-tabs>
    <FilterBar @submit="filter">
      <el-input
        v-model="query"
        maxlength="120"
        aria-label="搜索作品名称"
        placeholder="搜索作品名称"
      />
      <el-select v-model="lifecycle" aria-label="作品范围"
        ><el-option label="正在创作" value="active" /><el-option
          label="已归档"
          value="archived"
      /></el-select>
      <el-button native-type="submit">搜索</el-button>
      <el-dropdown
        v-if="auth.can('studio.projects.write')"
        trigger="click"
        @command="startMode"
      >
        <el-button
          type="primary"
          aria-label="新建作品"
          :loading="mutation.busy.value"
          >新建作品 ▾</el-button
        >
        <template #dropdown
          ><el-dropdown-menu>
            <el-dropdown-item command="quick"
              ><span class="work-create-choice"
                ><strong>快速创作</strong
                ><small>一句话或参考图生成单条视频</small></span
              ></el-dropdown-item
            >
            <el-dropdown-item command="storyboard"
              ><span class="work-create-choice"
                ><strong>分镜创作</strong
                ><small>逐镜制作一部完整短片</small></span
              ></el-dropdown-item
            >
            <el-dropdown-item command="series"
              ><span class="work-create-choice"
                ><strong>系列短剧</strong
                ><small>统一设定，按集编排与制作</small></span
              ></el-dropdown-item
            >
          </el-dropdown-menu></template
        >
      </el-dropdown>
    </FilterBar>
    <el-alert
      v-if="mutation.error.value && !creating"
      :title="mutation.error.value"
      type="error"
      :closable="false"
    />
    <ResourceStatus
      :loading="loading"
      :has-data="Boolean(data?.total)"
      :error="error"
      @retry="reload"
    />
    <ManagementList :page="page" :page-size="pageSize">
      <div class="studio-gallery" aria-label="作品项目" :aria-busy="loading">
        <StudioWorkCard
          v-for="project in data?.items"
          :key="project.id"
          :work="project"
          :can-edit="auth.can('studio.projects.write')"
          :busy="mutation.busy.value"
          @archive="archive(project)"
        />
      </div>
      <p v-if="!loading && !error && !data?.total" class="empty-cell">
        {{
          search
            ? '没有匹配的作品。'
            : '此分类暂无作品，点击「新建作品」选择创作方式。'
        }}
        <el-button v-if="search" link @click="clearFilter">清除筛选</el-button>
      </p>
      <template #pagination
        ><ManagementPagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="data?.total ?? 0"
          :loading="loading"
          :page-sizes="[10, 20, 50]"
      /></template>
    </ManagementList>
    <ManagementDialog
      v-model="creating"
      title="新建分镜作品"
      submit-text="创建并进入"
      :busy="mutation.busy.value"
      :error="mutation.error.value"
      :dirty="Boolean(form.title.trim())"
      :submit-disabled="!form.title.trim()"
      @submit="create"
    >
      <StudioBriefFields v-model="form" />
    </ManagementDialog>
    <SeriesCreateDialog
      v-if="creatingSeries"
      :model-value="creatingSeries"
      @update:model-value="closeSeries"
      @created="seriesCreated"
    />
  </section>
</template>

<style scoped src="../../assets/styles/studio-directory.css"></style>
<style scoped>
.studio-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
  gap: var(--field-gap);
}
.works-tabs :deep(.el-tabs__header) {
  margin: 0;
}
.work-create-choice {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-block: var(--control-gap);
}
.work-create-choice small {
  color: var(--muted-foreground);
}
</style>
