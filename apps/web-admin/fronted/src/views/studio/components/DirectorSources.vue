<script setup lang="ts">
import { ref } from 'vue'
import type { useDirectorSources } from '@/composables/studio/use-director-sources'
import StudioMedia from './StudioMedia.vue'
import StudioAssetPicker from './library/StudioAssetPicker.vue'

/** 创作资料选择器展示上传、来源和实际能力；发送前不改动作品。 */
const props = defineProps<{
  sources: ReturnType<typeof useDirectorSources>
  disabled: boolean
  canUpload: boolean
  canReadAssets: boolean
  canPreview: boolean
}>()
const fileInput = ref<HTMLInputElement>()
async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  await props.sources.upload(Array.from(input.files ?? []))
  input.value = ''
}
</script>
<template>
  <section class="form-stack director-sources" aria-label="导演参考资料">
    <div class="director-sources-heading">
      <strong>参考资料</strong
      ><small class="studio-meta"
        >选择主角、场景或道具，再让导演围绕它们起草</small
      >
    </div>
    <div class="toolbar director-source-actions">
      <el-button
        v-if="canUpload"
        :disabled="disabled || sources.references.value >= 4"
        :loading="sources.uploading.value"
        @click="fileInput?.click()"
        >上传形象图片</el-button
      >
      <input
        ref="fileInput"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        @change="upload"
      />
      <el-button
        v-if="canReadAssets"
        :disabled="disabled || sources.references.value >= 4"
        @click="sources.openLibrary"
        >从素材库选择</el-button
      >
    </div>
    <div v-if="sources.references.value" class="director-sources-list">
      <article
        v-for="(item, index) in sources.uploads.value"
        :key="item.file.fileId"
        class="director-source"
      >
        <img :src="item.preview" :alt="item.name || '待命名的参考图'" />
        <div class="form-stack">
          <el-input
            :model-value="item.name"
            :disabled="disabled"
            maxlength="120"
            aria-label="参考形象名称"
            placeholder="给形象取个名字，例如噜噜"
            @update:model-value="
              sources.setUploadName(item.file.fileId, $event)
            "
          />
          <small class="studio-meta">本次上传 · 发送后保存到项目素材</small>
        </div>
        <el-button
          text
          :disabled="disabled"
          :aria-label="'移除上传参考 ' + item.name"
          @click="sources.removeUpload(index)"
          >移除</el-button
        >
      </article>
      <article
        v-for="item in sources.selectedAssets.value"
        :key="item.id"
        class="director-source"
      >
        <StudioMedia
          v-if="item.fileId && canPreview"
          :project="null"
          :asset="item.id"
          kind="image"
        />
        <span v-else class="source-placeholder">{{
          item.name.slice(0, 1)
        }}</span>
        <div class="form-stack">
          <strong>{{ item.name }}</strong
          ><small class="studio-meta"
            >素材库 ·
            {{
              item.version === undefined ? '已有版本' : '版本 ' + item.version
            }}</small
          >
          <p v-if="item.description" class="source-description">
            {{ item.description }}
          </p>
        </div>
        <el-button
          text
          :disabled="disabled"
          :aria-label="'移除参考 ' + item.name"
          @click="sources.toggleAsset(item.id)"
          >移除</el-button
        >
      </article>
    </div>
    <div v-if="sources.referenceImages.value" class="form-stack">
      <el-checkbox
        :model-value="sources.analyzeImages.value"
        :disabled="disabled || !sources.capabilities.value?.vision.available"
        @update:model-value="sources.setAnalyzeImages($event === true)"
        >让 AI 理解参考图，提取外观和风格</el-checkbox
      >
      <p
        v-if="
          sources.capabilities.value &&
          !sources.capabilities.value.vision.available
        "
        class="studio-meta"
      >
        {{
          sources.capabilities.value.vision.reason ||
          '尚未配置可用的图片理解能力，可先保存形象引用并描述特点。'
        }}
      </p>
    </div>
    <div class="form-stack">
      <el-checkbox
        :model-value="sources.research.value"
        :disabled="disabled || !sources.capabilities.value?.research.available"
        @update:model-value="sources.setResearch($event === true)"
        >联网查询地点和故事背景</el-checkbox
      >
      <el-input
        v-if="sources.research.value"
        :model-value="sources.researchQuery.value"
        :disabled="disabled"
        maxlength="2000"
        aria-label="联网查询主题"
        placeholder="例如海南的海滩、椰林和当地特色；留空使用故事想法"
        @update:model-value="sources.setResearchQuery"
      />
      <p
        v-if="
          sources.capabilities.value &&
          !sources.capabilities.value.research.available
        "
        class="studio-meta"
      >
        {{
          sources.capabilities.value.research.reason ||
          '尚未配置可用的联网查询，仍可按你的想法起草。'
        }}
      </p>
    </div>
    <p v-if="sources.references.value" class="studio-meta">
      已选 {{ sources.references.value }}/4
      份资料，发送后才引用到本片。库内原设定保留，视频和配音在后续确认后制作。
    </p>
    <el-alert
      v-if="sources.error.value"
      :title="sources.error.value"
      type="error"
      :closable="false"
    />
    <details v-if="sources.evidence.value" class="director-evidence">
      <summary>已整理的参考资料</summary>
      <div class="form-stack">
        <section v-if="sources.evidence.value.vision" class="form-stack">
          <strong>参考图理解</strong>
          <p>{{ sources.evidence.value.vision.text }}</p>
        </section>
        <section v-if="sources.evidence.value.research" class="form-stack">
          <strong>联网资料</strong>
          <p>{{ sources.evidence.value.research.text }}</p>
          <ul v-if="sources.evidence.value.research.sources.length">
            <li
              v-for="item in sources.evidence.value.research.sources"
              :key="item.url"
            >
              <a :href="item.url" target="_blank" rel="noopener noreferrer">{{
                item.title || item.url
              }}</a>
            </li>
          </ul>
        </section>
      </div>
    </details>
    <StudioAssetPicker
      v-if="sources.libraryOpen.value && canReadAssets"
      title="为导演选择角色、场景或道具"
      :kinds="['character', 'scene', 'prop', 'image']"
      :exclude-ids="sources.selected.value"
      :resolve="async (asset) => asset"
      @selected="sources.addAsset"
      @close="sources.setLibraryOpen(false)"
    />
  </section>
</template>
<style scoped>
.director-sources-list {
  display: grid;
  gap: var(--control-gap);
}
.director-sources {
  padding-block: var(--field-gap);
  border-block: 1px solid var(--border);
}
.director-sources-heading {
  display: grid;
  gap: var(--space-1);
}
.director-source-actions > .el-button {
  max-width: 100%;
  min-height: var(--control-height);
  height: auto;
  padding-block: var(--control-gap);
  white-space: normal;
}
.director-source-actions > .el-button :deep(span) {
  white-space: normal;
  line-height: 1.5;
}
.director-source {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) auto;
  align-items: start;
  gap: var(--control-gap);
  padding: var(--space-3);
  background: var(--muted);
  border-radius: var(--radius);
}
.director-source > img,
.director-source :deep(.studio-frame) {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: var(--radius-control);
}
.source-placeholder {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  background: var(--muted);
  color: var(--muted-foreground);
  border-radius: var(--radius-control);
}
.director-source > div {
  gap: var(--label-gap);
}
.source-description {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  color: var(--muted-foreground);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.director-evidence > div {
  padding-top: var(--field-gap);
}
.director-evidence p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
}
.director-evidence a {
  color: var(--primary);
  text-decoration: underline;
  overflow-wrap: anywhere;
}
.director-evidence ul {
  padding-inline-start: var(--field-gap);
}
.form-stack :deep(.el-checkbox) {
  height: auto;
  min-height: var(--control-height);
  align-items: center;
}
.form-stack :deep(.el-checkbox__label) {
  white-space: normal;
  line-height: 1.5;
}
@media (max-width: 600px) {
  .director-source-actions > .el-button {
    min-height: 44px;
  }
  .director-source {
    grid-template-columns: 48px minmax(0, 1fr);
  }
  .director-source > img,
  .director-source :deep(.studio-frame) {
    width: 48px;
    height: 48px;
  }
  .director-source > button {
    grid-column: 2;
    justify-self: start;
  }
}
@media (max-width: 420px) {
  .director-source-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
