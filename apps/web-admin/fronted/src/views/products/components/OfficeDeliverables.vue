<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import DateTime from '@/components/base/DateTime.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ArtifactPreviewDialog from '@/views/workbench/components/ArtifactPreviewDialog.vue'
import { useArtifactActions } from '@/composables/workbench/use-artifact-actions'
import { useResource } from '@/composables/use-resource'
import { resultApi } from '@/api/workbench/result-api'

/** 文件封面只投影真实文件名与会话名；正式预览和下载沿用会话受权接口。 */
const recent = useResource(resultApi.recentOffice)
const selected = ref('')
const file = computed(
  () =>
    recent.data.value?.items.find((item) => item.id === selected.value) ??
    recent.data.value?.items[0],
)
const actions = useArtifactActions(computed(() => file.value?.sessionId ?? ''))
const fileType = computed(() =>
  file.value?.name.split('.').at(-1)?.slice(0, 8).toUpperCase(),
)
const draft = computed(
  () =>
    file.value?.deliverable === false ||
    file.value?.renderedQuality?.status === 'draft',
)
function chooseFile(event: Event) {
  actions.closePreview()
  selected.value = (event.target as HTMLSelectElement).value
}
</script>
<template>
  <section class="office-feature" aria-label="最近交付">
    <header class="office-feature-head">
      <h2>最近交付</h2>
      <span v-if="file">{{ fileType }}</span>
    </header>
    <ResourceStatus
      :loading="recent.loading.value"
      :error="recent.error.value"
      @retry="recent.reload"
    />
    <template v-if="file">
      <button
        type="button"
        class="office-cover-stage"
        :aria-label="'预览 ' + file.name"
        @click="actions.preview(file)"
      >
        <span class="office-file-summary" aria-hidden="true">
          <AppIcon name="file-text" :size="40" />
          <small>{{ fileType }}</small>
          <strong>{{ file.name }}</strong>
          <span>打开文件预览</span>
        </span>
      </button>
      <footer class="office-feature-foot">
        <div>
          <strong>{{ file.name }}</strong
          ><small
            >{{ draft ? '草稿' : file.sessionTitle
            }}<template v-if="file.createdAt">
              · <DateTime :value="file.createdAt" /></template
          ></small>
        </div>
      </footer>
      <div class="office-deliverable-actions">
        <el-button
          :aria-label="'查看文件内容 ' + file.name"
          @click="actions.preview(file)"
        >
          <AppIcon name="file-text" />预览
        </el-button>
        <el-button
          native-type="button"
          :aria-label="'下载 ' + file.name"
          title="下载"
          @click="actions.download(file)"
        >
          <AppIcon name="download" />下载
        </el-button>
      </div>
      <select
        v-if="(recent.data.value?.items.length ?? 0) > 1"
        class="native-control"
        :value="file.id"
        aria-label="选择最近交付"
        @change="chooseFile"
      >
        <option
          v-for="item in recent.data.value?.items"
          :key="item.id"
          :value="item.id"
        >
          {{ item.name }}
        </option>
      </select>
    </template>
    <div v-else-if="recent.data.value" class="office-empty-cover">
      <AppIcon name="file-text" :size="38" /><strong>暂无交付物</strong
      ><span>任务生成的文件会显示在这里。</span>
    </div>
    <el-alert
      v-if="actions.error.value"
      :title="actions.error.value"
      type="error"
      :closable="false"
    />
    <ArtifactPreviewDialog :actions="actions" />
  </section>
</template>
