<script setup lang="ts">
import RowActions from '@/components/management/RowActions.vue'
import { ref, toRef } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import AppIcon from '@/components/base/AppIcon.vue'
import MarkdownContent from '@/components/MarkdownContent.vue'
import { useWorkspaceFiles } from '@/composables/workspace-files/use-workspace-files'
/** 工作区浏览与编辑；对外暴露关闭检查供抽屉保留未保存草稿。 */
const props = defineProps<{ connectorId: string; root?: string }>()
const files = useWorkspaceFiles(
  toRef(props, 'connectorId'),
  toRef(props, 'root'),
)
defineExpose({ beforeClose: files.discard })
const previewText = ref(false)
onBeforeRouteLeave(files.discard)
</script>

<template>
  <section v-loading="files.busy.value" class="workspace-files">
    <el-alert
      v-if="files.error.value"
      :title="files.error.value"
      type="error"
      :closable="false"
    />
    <div class="file-toolbar">
      <el-input
        v-model="files.path.value"
        aria-label="工作目录"
        @keyup.enter="files.list()"
      /><el-button @click="files.list()">刷新</el-button
      ><el-button @click="files.create">新建文本</el-button>
    </div>
    <el-breadcrumb separator="/"
      ><el-breadcrumb-item
        v-for="part in files.breadcrumbs.value"
        :key="part.path"
        ><el-button text @click="files.list(part.path)">{{
          part.name
        }}</el-button></el-breadcrumb-item
      ></el-breadcrumb
    >
    <el-table
      :data="files.entries.value"
      max-height="260"
      @row-dblclick="files.open"
      ><el-table-column prop="name" label="名称"
        ><template #default="scope"
          ><el-button text @click="files.open(scope.row)"
            ><AppIcon :name="scope.row.isDirectory ? 'folder' : 'file-text'" />
            {{ scope.row.name }}</el-button
          ></template
        ></el-table-column
      ><el-table-column prop="size" label="大小" width="100" /><el-table-column
        label="操作"
        width="150"
        ><template #default="scope"
          ><RowActions :busy="files.busy.value">
            <el-button
              v-if="!scope.row.isDirectory"
              link
              text
              @click="files.download(scope.row)"
              >下载</el-button
            >
            <el-button
              v-if="!scope.row.isDirectory"
              link
              text
              @click="files.preview(scope.row)"
              >预览</el-button
            >
          </RowActions>
        </template></el-table-column
      ></el-table
    >
    <template v-if="files.selected.value"
      ><div class="file-toolbar">
        <strong
          >{{ files.selected.value
          }}{{ files.dirty.value ? ' · 未保存' : '' }}</strong
        ><el-button
          type="primary"
          :disabled="!files.dirty.value && !files.selected.value"
          @click="files.save"
          >保存</el-button
        >
        <el-switch
          v-model="previewText"
          active-text="预览"
          inactive-text="编辑"
        />
      </div>
      <el-input
        v-if="!previewText"
        v-model="files.content.value"
        type="textarea"
        :rows="18"
        aria-label="文本文件内容"
        spellcheck="false"
      />
      <MarkdownContent v-else :content="files.content.value" />
      <p>
        保存会校验文件摘要；如果文件已被其他操作修改，会保留你的草稿并提示冲突。
      </p></template
    >
  </section>
</template>
