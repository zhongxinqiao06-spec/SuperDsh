<script setup lang="ts">
import { ref, onScopeDispose } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/store/modules/auth-store'
import { initialBrief, projectBrief } from '@/utils/studio/foundation'
import { newId } from '@/utils/studio/storyboard'
import StudioBriefFields from './components/project/StudioBriefFields.vue'
import type { ProjectSummary } from '@/types/studio/studio'
import { useRouter } from 'vue-router'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { useMutation } from '@/composables/use-mutation'
import { useStudioDirectory } from '@/composables/studio/use-studio-directory'
import { studioApi } from '@/api/studio/studio-api'
import StudioProjectCard from './components/StudioProjectCard.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'

const auth = useAuthStore()
const lifecycle = ref('active')
const controller = new AbortController()
onScopeDispose(() => controller.abort())
const { page, pageSize, data, query, search, filter, loading, error, reload } =
  useStudioDirectory(
    (query, signal) =>
      studioApi.projectPage({ ...query, lifecycle: lifecycle.value }, signal),
    [lifecycle],
  )
const router = useRouter()
const creating = ref(false)
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
async function archive(project: ProjectSummary) {
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
      await studioApi.archive(project.id, project.revision, archived, newId())
    }))
  )
    await reload()
}
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader title="我的作品" />
    <FilterBar @submit="filter">
      <el-select v-model="lifecycle" aria-label="作品范围"
        ><el-option label="正在创作" value="active" /><el-option
          label="已归档"
          value="archived"
      /></el-select>
      <el-input
        v-model="query"
        maxlength="120"
        aria-label="搜索作品名称"
        placeholder="搜索作品名称"
      />
      <el-button native-type="submit">搜索</el-button>
      <el-button
        v-if="auth.can('studio.projects.write')"
        type="primary"
        :loading="mutation.busy.value"
        @click="start"
        >新建作品</el-button
      >
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
        <StudioProjectCard
          v-for="project in data?.items"
          :key="project.id"
          :project="project"
          :can-edit="auth.can('studio.projects.write')"
          :busy="mutation.busy.value"
          @archive="archive(project)"
        />
      </div>
      <p v-if="!loading && !error && !data?.total" class="empty-cell">
        {{
          search
            ? '没有匹配的作品。'
            : '暂无作品，点击「新建作品」开始编写剧本。'
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
      title="新建作品"
      submit-text="创建并进入"
      :busy="mutation.busy.value"
      :error="mutation.error.value"
      :dirty="Boolean(form.title.trim())"
      :submit-disabled="!form.title.trim()"
      @submit="create"
    >
      <StudioBriefFields v-model="form" />
    </ManagementDialog>
  </section>
</template>

<style scoped>
.studio-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
  gap: 16px;
}
.studio-gallery:has(> :only-child) {
  grid-template-columns: minmax(0, 910px);
}
</style>
