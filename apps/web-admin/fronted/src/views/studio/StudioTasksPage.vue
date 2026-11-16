<script setup lang="ts">
import { onMounted, onScopeDispose, ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import RowActions from '@/components/management/RowActions.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import DateTime from '@/components/base/DateTime.vue'
import { useStudioDirectory } from '@/composables/studio/use-studio-directory'
import { studioApi } from '@/api/studio/studio-api'
import { jobKinds, jobStates } from '@/utils/studio/media-labels'
import type { DirectoryJob } from '@/types/studio/studio'
import StudioDirectoryTable from './components/StudioDirectoryTable.vue'
import StudioMedia from './components/StudioMedia.vue'
import StudioRecovery from './components/StudioRecovery.vue'
import StudioPersonalProduction from './components/StudioPersonalProduction.vue'

const route = useRoute()
const deliveries = computed(() => route.path.endsWith('/deliveries'))
const kind = ref(''),
  state = ref('')
const { page, pageSize, data, query, search, filter, loading, error, reload } =
  useStudioDirectory(
    (params, signal) =>
      studioApi.jobPage(
        {
          ...params,
          state: deliveries.value ? 'ready' : state.value,
          kind: deliveries.value ? 'export' : kind.value,
        },
        signal,
      ),
    [state, kind, deliveries],
  )
const preview = ref<DirectoryJob>(),
  personal = ref<string>()
let timer: ReturnType<typeof setInterval>
onMounted(() => {
  // 队列中有活动任务才更新当前页；页面隐藏时不轮询。
  timer = setInterval(() => {
    if (
      !document.hidden &&
      !loading.value &&
      data.value?.items.some((job) =>
        ['queued', 'submitting', 'polling', 'downloading'].includes(job.state),
      )
    )
      void reload()
  }, 6000)
})
onScopeDispose(() => clearInterval(timer))
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader :title="deliveries ? '成片交付' : '制作任务'" />
    <FilterBar @submit="filter">
      <el-select v-if="!deliveries" v-model="state" aria-label="任务状态"
        ><el-option label="全部状态" value="" /><el-option
          v-for="(label, key) in jobStates"
          :key="key"
          :value="key"
          :label="label"
      /></el-select>
      <el-select v-if="!deliveries" v-model="kind" aria-label="任务类型"
        ><el-option label="全部类型" value="" /><el-option
          v-for="(label, key) in jobKinds"
          :key="key"
          :value="key"
          :label="label"
      /></el-select>
      <el-input
        v-model="query"
        maxlength="120"
        placeholder="搜索作品名称"
        aria-label="搜索作品名称"
      />
      <el-button native-type="submit">搜索</el-button
      ><el-button :disabled="loading" @click="reload">刷新</el-button>
    </FilterBar>
    <StudioDirectoryTable
      v-model:page="page"
      v-model:page-size="pageSize"
      :label="deliveries ? '成片交付' : '制作任务'"
      :columns="['任务', '所属作品', '状态', '最近更新', '操作']"
      :total="data?.total ?? 0"
      :empty="
        kind || state || search
          ? '没有符合筛选条件的任务。'
          : '暂无制作任务，作品中提交的镜头、配音和导出任务会出现在这里。'
      "
      :loading="loading"
      :error="error"
      @retry="reload"
    >
      <tr v-for="job in data?.items" :key="job.id">
        <td>
          <strong>{{ jobKinds[job.kind] }}</strong
          ><small v-if="job.summary">{{ job.summary }}</small
          ><small>工程版本 {{ job.revision }}</small>
        </td>
        <td data-label="所属作品">{{ job.projectTitle }}</td>
        <td data-label="状态">
          <span class="studio-task-state" :data-state="job.state">{{
            jobStates[job.state] ?? job.state
          }}</span
          ><small v-if="job.error">{{ job.error }}</small>
        </td>
        <td data-label="最近更新"><DateTime :value="job.updated" /></td>
        <td data-label="操作">
          <RowActions>
            <StudioRecovery
              :project="job.project"
              :job="job"
              @recovered="reload"
            />
            <el-button v-if="job.state === 'ready'" link @click="preview = job"
              >预览结果</el-button
            >
            <el-button
              v-if="!job.project && job.entity"
              link
              @click="personal = job.entity"
              >查看个人素材</el-button
            >
            <router-link
              v-if="job.project"
              :to="{
                path: '/entertainment/' + job.project,
                query: { section: deliveries ? 'delivery' : 'production' },
              }"
              >查看作品任务</router-link
            >
          </RowActions>
        </td>
      </tr>
    </StudioDirectoryTable>
    <StudioPersonalProduction
      v-if="personal"
      :entity="personal"
      @close="personal = undefined"
      @updated="reload"
    />
    <ManagementDialog
      v-if="preview"
      :model-value="true"
      :title="preview.projectTitle + ' · ' + jobKinds[preview.kind]"
      readonly
      @update:model-value="preview = undefined"
    >
      <StudioMedia
        :project="preview.project"
        :job="preview.id"
        :kind="
          preview.kind === 'speech'
            ? 'audio'
            : preview.kind === 'image'
              ? 'image'
              : 'video'
        "
        controls
      />
    </ManagementDialog>
  </section>
</template>
<style scoped src="../../assets/styles/studio-directory.css"></style>
<style scoped>
.studio-task-state {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  white-space: nowrap;
}
.studio-task-state::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
}
.studio-task-state[data-state='ready']::before {
  background: #48a280;
}
.studio-task-state:is([data-state='unknown'], [data-state='failed'])::before {
  background: var(--destructive);
}
</style>
