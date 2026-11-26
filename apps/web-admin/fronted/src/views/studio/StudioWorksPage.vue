<script setup lang="ts">
import { ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useWorksFilters } from '@/store/modules/works-filters'
import { ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/store/modules/auth-store'
import { newId } from '@/utils/studio/storyboard'
import type { WorkMode, WorkSummary } from '@/types/studio/works'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { useMutation } from '@/composables/use-mutation'
import { useStudioDirectory } from '@/composables/studio/use-studio-directory'
import { worksApi } from '@/api/studio/works-api'
import StudioWorkCard from './components/StudioWorkCard.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'

const auth = useAuthStore()
const filters = useWorksFilters()
const generation = auth.generation
const lifecycle = ref(filters.saved.lifecycle)
const mode = ref<WorkMode | 'all'>(filters.saved.mode)
const { page, pageSize, data, query, search, filter, loading, error, reload } =
  useStudioDirectory(
    (query, signal) =>
      worksApi.page(
        { ...query, lifecycle: lifecycle.value, mode: mode.value },
        signal,
      ),
    [lifecycle, mode],
    filters.saved,
  )
// 只记住本次账号会话中实际应用的筛选与页码，重新进入时仍向服务端读取最新作品。
onBeforeRouteLeave(() => {
  if (auth.generation !== generation) return
  filters.saved = {
    mode: mode.value,
    lifecycle: lifecycle.value,
    page: page.value,
    pageSize: pageSize.value,
    search: search.value,
  }
})
const mutation = useMutation()
function clearFilter() {
  query.value = ''
  filter()
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
    </FilterBar>
    <el-alert
      v-if="mutation.error.value"
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
            : mode === 'all' && lifecycle === 'active'
              ? '暂无正在创作的作品。'
              : '此分类暂无作品。'
        }}
        <el-button v-if="search" link @click="clearFilter">清除筛选</el-button>
        <router-link
          v-else-if="
            mode === 'all' &&
            lifecycle === 'active' &&
            auth.can('studio.projects.write')
          "
          to="/entertainment"
          >去创作中心</router-link
        >
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
  </section>
</template>

<style scoped>
.studio-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
  gap: var(--field-gap);
}
.works-tabs :deep(.el-tabs__header) {
  margin: 0;
}
</style>
