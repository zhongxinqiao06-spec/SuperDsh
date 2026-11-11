<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import { nextTick, ref, watch } from 'vue'
import { useFilePreview } from '@/composables/file-preview/use-file-preview'
import { previewCaret } from '@/utils/file-preview/preview-location'
import { fileSize } from '@/utils/files/presentation'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import MarkdownContent from '@/components/MarkdownContent.vue'
/** 独立预览页支持受限票据、只读附件、目录浏览与有摘要保护的文本编辑。 */
const vm = useFilePreview()
const editor = ref<HTMLTextAreaElement | null>(null)
watch(vm.editing, async () => {
  if (!vm.editing.value) return
  await nextTick()
  const offset = previewCaret(
    vm.content.value,
    vm.location.value.line,
    vm.location.value.column,
  )
  editor.value?.focus()
  editor.value?.setSelectionRange(offset, offset)
})
</script>
<template>
  <main class="preview-page">
    <PageHeader class="preview-title" :title="vm.name.value" />
    <div class="toolbar preview-toolbar">
      <el-button :disabled="vm.loading.value || vm.dirty.value" @click="vm.load"
        >刷新</el-button
      >
      <el-button v-if="vm.objectUrl.value" @click="vm.download">下载</el-button>
      <el-button
        v-if="vm.writable.value && !vm.editing.value"
        @click="vm.editing.value = true"
        >编辑</el-button
      >
      <el-button
        v-if="vm.editing.value"
        type="primary"
        :loading="vm.saving.value"
        :disabled="!vm.dirty.value"
        @click="vm.save"
        >保存</el-button
      >
      <span
        v-if="vm.location.value.path || vm.source.value"
        class="preview-metadata"
        >{{ vm.location.value.path
        }}<template v-if="vm.location.value.path && vm.source.value">
          · </template
        ><template v-if="vm.source.value">{{
          fileSize(vm.source.value.size)
        }}</template></span
      >
    </div>
    <ResourceStatus
      :loading="vm.loading.value"
      :error="vm.error.value"
      @retry="vm.load"
    />
    <el-alert
      v-if="vm.saveError.value"
      :title="vm.saveError.value"
      type="error"
      :closable="false"
    />
    <el-alert
      v-if="vm.truncated.value && !vm.error.value"
      title="文本仅展示前 1 MB，完整内容请下载查看；截断预览不可编辑。"
      type="info"
      :closable="false"
    />
    <section
      v-if="!vm.loading.value && !vm.error.value"
      class="preview-content"
    >
      <ul v-if="vm.entries.value" class="directory-list">
        <li v-for="entry in vm.entries.value" :key="entry.path">
          <button @click="vm.open(entry)">
            {{ entry.isDirectory ? '📁' : '📄' }} {{ entry.name }}</button
          ><span>{{ entry.isDirectory ? '目录' : fileSize(entry.size) }}</span>
        </li>
        <li v-if="!vm.entries.value.length">目录为空</li>
      </ul>
      <textarea
        v-else-if="vm.editing.value"
        ref="editor"
        v-model="vm.content.value"
        aria-label="文件内容编辑器"
        spellcheck="false"
      />
      <MarkdownContent
        v-else-if="
          vm.kind.value === 'text' && /\.(?:md|markdown)$/i.test(vm.name.value)
        "
        :content="vm.content.value"
      />
      <pre v-else-if="vm.kind.value === 'text'">{{ vm.content.value }}</pre>
      <img
        v-else-if="vm.kind.value === 'image'"
        :src="vm.objectUrl.value"
        :alt="vm.name.value"
      />
      <iframe
        v-else-if="vm.kind.value === 'pdf'"
        :src="vm.objectUrl.value"
        :title="vm.name.value"
        sandbox="allow-same-origin"
      />
      <audio
        v-else-if="vm.kind.value === 'audio'"
        :src="vm.objectUrl.value"
        controls
      />
      <video
        v-else-if="vm.kind.value === 'video'"
        :src="vm.objectUrl.value"
        controls
      />
      <el-empty v-else description="此文件类型暂不支持在线预览，可下载后打开" />
    </section>
  </main>
</template>
<style scoped>
.preview-page {
  min-height: 100vh;
  background: var(--color-background, #fff);
  color: var(--color-text, #1f2329);
}
.preview-title {
  padding: 20px 24px 0;
  overflow-wrap: anywhere;
}
.preview-toolbar {
  padding: 12px 24px;
  border-bottom: 1px solid var(--border);
}
.preview-metadata {
  margin-inline-start: auto;
  color: var(--muted-foreground);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.preview-content {
  min-height: calc(100vh - 100px);
  padding: 20px;
}
.preview-content pre,
.preview-content textarea {
  width: 100%;
  min-height: calc(100vh - 150px);
  box-sizing: border-box;
  margin: 0;
  font:
    13px/1.7 ui-monospace,
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.preview-content textarea {
  padding: 12px;
  resize: vertical;
  background: transparent;
  color: inherit;
  border: 1px solid var(--el-border-color);
}
.preview-content img,
.preview-content video {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 140px);
  margin: auto;
}
.preview-content iframe {
  width: 100%;
  height: calc(100vh - 140px);
  border: 0;
}
.directory-list {
  list-style: none;
  padding: 0;
}
.directory-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--el-border-color-light);
}
.directory-list button {
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
  text-align: left;
}
@media (max-width: 600px) {
  .preview-title,
  .preview-toolbar {
    padding-inline: 16px;
  }
  .preview-content {
    padding: 12px;
  }
}
</style>
