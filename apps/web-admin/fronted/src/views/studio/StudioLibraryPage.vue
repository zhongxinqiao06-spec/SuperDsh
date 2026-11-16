<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import RowActions from '@/components/management/RowActions.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { useAuthStore } from '@/store/modules/auth-store'
import { useStudioDirectory } from '@/composables/studio/use-studio-directory'
import { studioApi } from '@/api/studio/studio-api'
import { assetKinds, mediaKind } from '@/utils/studio/media-labels'
import type { DirectoryAsset } from '@/types/studio/studio'
import StudioDirectoryTable from './components/StudioDirectoryTable.vue'
import StudioLinkAssetDialog from './components/StudioLinkAssetDialog.vue'
import StudioPersonalAssetDialog from './components/StudioPersonalAssetDialog.vue'
import StudioMedia from './components/StudioMedia.vue'
import StudioPersonalProduction from './components/StudioPersonalProduction.vue'
import StudioAssetUsage from './components/StudioAssetUsage.vue'

const auth = useAuthStore()
const route = useRoute()
const category = computed(() =>
  route.path.endsWith('/characters')
    ? 'characters'
    : route.path.endsWith('/environments')
      ? 'environments'
      : 'media',
)
const title = computed(
  () =>
    ({ characters: '角色库', environments: '场景与道具', media: '媒体素材' })[
      category.value
    ],
)
const availableKinds = computed(() =>
  Object.fromEntries(
    Object.entries(assetKinds).filter(([key]) =>
      category.value === 'characters'
        ? key === 'character'
        : category.value === 'environments'
          ? ['scene', 'prop'].includes(key)
          : ['image', 'video', 'audio', 'music'].includes(key),
    ),
  ),
)
const editing = ref<DirectoryAsset>()
const producing = ref<DirectoryAsset>()
const scope = ref('personal'),
  kind = ref('')
watch(category, () => {
  kind.value = ''
  creating.value = false
  editing.value = undefined
})
const { page, pageSize, data, query, search, filter, loading, error, reload } =
  useStudioDirectory(
    (params, signal) =>
      studioApi.libraryPage(
        {
          ...params,
          scope: scope.value,
          kind: kind.value,
          category: category.value,
        },
        signal,
      ),
    [scope, kind, category],
  )
const creating = ref(false),
  viewing = ref<DirectoryAsset>(),
  linking = ref<DirectoryAsset>()
function saved() {
  creating.value = false
  editing.value = undefined
  ElMessage.success('已保存到个人素材库')
  void reload()
}
function linked(title: string) {
  linking.value = undefined
  ElMessage.success('已引用到作品「' + title + '」')
}
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader :title="title" />
    <FilterBar @submit="filter">
      <el-select v-model="scope" aria-label="素材范围"
        ><el-option label="个人素材" value="personal" /><el-option
          label="作品素材"
          value="project"
      /></el-select>
      <el-select v-model="kind" aria-label="筛选素材类型"
        ><el-option label="全部类型" value="" /><el-option
          v-for="(label, k) in availableKinds"
          :key="k"
          :value="k"
          :label="label"
      /></el-select>
      <el-input
        v-model="query"
        maxlength="120"
        :placeholder="
          scope === 'personal' ? '搜索素材名称' : '搜索素材或作品名称'
        "
        aria-label="搜索素材"
      />
      <el-button native-type="submit">搜索</el-button>
      <el-button
        v-if="scope === 'personal' && auth.can('studio.assets.write')"
        type="primary"
        @click="creating = true"
        >新增个人素材</el-button
      >
    </FilterBar>
    <StudioDirectoryTable
      v-model:page="page"
      v-model:page-size="pageSize"
      :label="title"
      :columns="['素材名称', '类型', '素材来源', '版本', '操作']"
      :total="data?.total ?? 0"
      :empty="
        kind || search
          ? '没有符合筛选条件的素材。'
          : scope === 'personal'
            ? '个人库暂无素材，可以新增角色、场景或参考文件。'
            : '暂无作品素材，可在个人库将素材引用到作品。'
      "
      :loading="loading"
      :error="error"
      @retry="reload"
    >
      <tr
        v-for="asset in data?.items"
        :key="(asset.workId ?? '') + '/' + asset.id"
      >
        <td>
          <span class="asset-entry">
            <span class="asset-thumbnail">
              <StudioMedia
                v-if="
                  asset.fileId &&
                  auth.can('files.read') &&
                  mediaKind(asset.kind) !== 'audio'
                "
                :project="asset.workId"
                :asset="asset.id"
                :kind="mediaKind(asset.kind)"
                lazy
              />
              <AppIcon v-else name="folder" />
            </span>
            <span
              ><strong>{{ asset.name }}</strong
              ><small v-if="asset.workTitle">{{ asset.workTitle }}</small></span
            >
          </span>
        </td>
        <td data-label="类型">{{ assetKinds[asset.kind] }}</td>
        <td data-label="素材来源">
          {{
            asset.sourceJob
              ? '制作任务'
              : asset.parent
                ? '派生版本'
                : asset.project
                  ? '作品素材'
                  : '个人素材'
          }}
        </td>
        <td data-label="版本">
          <span :title="asset.id">{{
            asset.version ?? asset.id.slice(0, 8)
          }}</span>
        </td>
        <td data-label="操作">
          <RowActions>
            <el-button
              v-if="
                !asset.project &&
                ['character', 'scene', 'prop'].includes(asset.kind) &&
                auth.can('studio.assets.write') &&
                auth.can('models.use')
              "
              link
              @click="producing = asset"
              >制作素材</el-button
            >
            <el-button
              v-if="!asset.project && auth.can('studio.assets.write')"
              link
              @click="editing = asset"
              >创建新版本</el-button
            >
            <el-button link @click="viewing = asset">查看素材</el-button>
            <router-link
              v-if="asset.workId"
              :to="{
                path: '/entertainment/' + asset.workId,
                query: { section: 'library' },
              }"
              >作品素材</router-link
            >
            <el-button v-else link @click="linking = asset"
              >引用到作品</el-button
            >
          </RowActions>
        </td>
      </tr>
    </StudioDirectoryTable>
    <ManagementDialog
      v-if="viewing"
      :model-value="true"
      :title="viewing.name"
      readonly
      @update:model-value="viewing = undefined"
    >
      <p>
        {{ assetKinds[viewing.kind] }} · 版本
        {{ viewing.version ?? viewing.id.slice(0, 8) }}
      </p>
      <p v-if="viewing.description" class="asset-description">
        {{ viewing.description }}
      </p>
      <p v-if="viewing.voice">默认音色 · {{ viewing.voice }}</p>
      <StudioMedia
        v-if="viewing.fileId && auth.can('files.read')"
        :project="viewing.workId"
        :asset="viewing.id"
        :kind="mediaKind(viewing.kind)"
        controls
      />
      <p v-else-if="viewing.fileId">当前账号没有预览参考文件的权限。</p>
      <StudioAssetUsage
        :key="viewing.id + (viewing.workId ?? '')"
        :asset="viewing.id"
        :project="viewing.workId"
      />
    </ManagementDialog>
    <StudioPersonalProduction
      v-if="producing"
      :key="producing.family"
      :entity="producing.entityId ?? producing.family"
      @close="producing = undefined"
      @updated="reload"
    />
    <StudioPersonalAssetDialog
      v-if="creating || editing"
      :kinds="availableKinds"
      :asset="editing"
      @saved="saved"
      @close="
        () => {
          creating = false
          editing = undefined
        }
      "
    />
    <StudioLinkAssetDialog
      v-if="linking"
      :asset="linking"
      @linked="linked"
      @close="linking = undefined"
    />
  </section>
</template>
<style scoped src="../../assets/styles/studio-directory.css"></style>
<style scoped>
.asset-entry {
  display: flex;
  align-items: center;
  gap: 10px;
}
.asset-thumbnail {
  flex: 0 0 56px;
  height: 40px;
  display: grid;
  place-items: center;
  background: var(--muted);
  border-radius: 5px;
  overflow: hidden;
  color: var(--muted-foreground);
}
.asset-thumbnail :deep(.studio-media),
.asset-thumbnail :deep(.studio-frame) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  margin: 0;
}
.asset-description {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
