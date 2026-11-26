<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { useAuthStore } from '@/store/modules/auth-store'
import { useStudioDirectory } from '@/composables/studio/use-studio-directory'
import { studioApi } from '@/api/studio/studio-api'
import { libraryApi } from '@/api/studio/library-api'
import { librarySection, librarySections } from '@/utils/studio/library'
import { assetKinds } from '@/utils/studio/media-labels'
import type { StudioAsset } from '@/types/studio/studio'
import StudioLinkAssetDialog from './components/StudioLinkAssetDialog.vue'
import StudioPersonalAssetDialog from './components/StudioPersonalAssetDialog.vue'
import StudioPersonalProduction from './components/StudioPersonalProduction.vue'
import StudioAssetCard from './components/library/StudioAssetCard.vue'
import StudioAssetDetail from './components/library/StudioAssetDetail.vue'
import StudioCollectionDialog from './components/library/StudioCollectionDialog.vue'
import StudioBatchCollectionDialog from './components/library/StudioBatchCollectionDialog.vue'

/** 库目录按素材身份聚合，作品来源显式可见；历史版本只在详情中展开。 */
const auth = useAuthStore(),
  route = useRoute()
const category = computed(() => librarySection(route.path))
const section = computed(() => librarySections[category.value])
const availableKinds = computed(() =>
  Object.fromEntries(
    section.value.kinds.map((kind) => [kind, assetKinds[kind]]),
  ),
)
const scope = ref('personal'),
  kind = ref(''),
  layout = ref('cards'),
  archived = ref(false)
const creating = ref(false),
  editing = ref<StudioAsset>(),
  producing = ref<StudioAsset>(),
  viewing = ref<StudioAsset>(),
  linking = ref<StudioAsset>(),
  collecting = ref<StudioAsset>(),
  variant = ref(false)
const checked = ref<string[]>([]),
  batch = ref<StudioAsset[]>()
const { page, pageSize, data, query, search, filter, loading, error, reload } =
  useStudioDirectory(
    (params, signal) =>
      studioApi.libraryPage(
        {
          ...params,
          scope: scope.value,
          kind: kind.value,
          category: category.value,
          archived: scope.value === 'personal' && archived.value,
        },
        signal,
      ),
    [scope, kind, category, archived],
  )
watch(category, () => {
  kind.value = ''
  creating.value = false
  editing.value = undefined
  viewing.value = undefined
})
watch([scope, category, page, search], () => {
  checked.value = []
})
watch(
  () => route.query.asset,
  async (id, _, cleanup) => {
    let active = true
    const controller = new AbortController()
    cleanup(() => {
      active = false
      controller.abort()
    })
    if (typeof id !== 'string') return
    try {
      const value = await libraryApi.detail(id, controller.signal)
      if (active) viewing.value = value.asset
    } catch (cause) {
      if (active)
        ElMessage.error(cause instanceof Error ? cause.message : String(cause))
    }
  },
  { immediate: true },
)
function saved() {
  creating.value = false
  editing.value = undefined
  ElMessage.success('已保存到我的素材库')
  void reload()
}
function collected() {
  collecting.value = undefined
  ElMessage.success('已保存到素材库，作品中的设定保持不变')
  void reload()
}
function beginCollect(asset: StudioAsset, isVariant = false) {
  collecting.value = asset
  variant.value = isVariant
}
function toggleChecked(id: string, value: unknown) {
  checked.value =
    value === true
      ? [...new Set([...checked.value, id])]
      : checked.value.filter((item) => item !== id)
}
function closeEditor() {
  creating.value = false
  editing.value = undefined
}
function chooseVersion(asset: StudioAsset) {
  linking.value = asset
  viewing.value = undefined
}
function linked() {
  linking.value = undefined
  ElMessage.success('已加入作品，可以继续创作')
}
function batchSaved() {
  batch.value = undefined
  checked.value = []
  collected()
}
function closeBatch() {
  batch.value = undefined
  void reload()
}
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader :title="section.title" />
    <el-tabs v-model="scope" class="library-tabs" aria-label="素材范围"
      ><el-tab-pane
        :label="'我的' + section.singular"
        name="personal" /><el-tab-pane
        :label="'作品中的' + section.singular"
        name="project"
    /></el-tabs>
    <FilterBar @submit="filter">
      <div class="filter-query">
        <el-input
          v-model="query"
          maxlength="120"
          :placeholder="
            scope === 'personal'
              ? '搜索' + section.singular + '名称'
              : '搜索' + section.singular + '或作品名称'
          "
          aria-label="搜索素材"
        />
        <el-button native-type="submit">搜索</el-button>
      </div>
      <el-select
        v-if="category === 'media'"
        v-model="kind"
        :empty-values="[null, undefined]"
        aria-label="媒体类型"
        ><el-option label="全部媒体" value="" /><el-option
          v-for="(label, key) in availableKinds"
          :key="key"
          :value="key"
          :label="label"
      /></el-select>
      <el-select
        v-if="scope === 'personal'"
        v-model="archived"
        aria-label="素材归档状态"
        ><el-option :value="false" label="使用中的素材" /><el-option
          :value="true"
          label="已归档素材"
      /></el-select>
      <div class="filter-actions">
        <el-button
          v-if="scope === 'personal' && auth.can('studio.assets.write')"
          type="primary"
          @click="creating = true"
          >{{
            category === 'media' ? '上传素材' : '创建' + section.singular
          }}</el-button
        >
        <el-button
          v-if="scope === 'personal' && auth.can('studio.assets.write')"
          @click="scope = 'project'"
          >从作品收藏</el-button
        >
        <el-button
          v-if="scope === 'project' && auth.can('studio.assets.write')"
          :disabled="!checked.length"
          @click="
            batch = data?.items.filter((asset) => checked.includes(asset.id))
          "
          >收藏选中 {{ checked.length || '' }}</el-button
        >
        <el-radio-group v-model="layout" aria-label="素材展示方式"
          ><el-radio-button value="cards">卡片</el-radio-button
          ><el-radio-button value="list">列表</el-radio-button></el-radio-group
        >
      </div>
    </FilterBar>
    <ManagementList :page="page" :page-size="pageSize">
      <ResourceStatus
        :loading="loading"
        :error="error"
        :has-data="!!data?.items.length"
        @retry="reload"
      />
      <div
        v-if="!loading && !error && !data?.items.length"
        class="panel preparation-empty"
      >
        <h2>
          {{
            search || kind
              ? '没有找到匹配素材'
              : scope === 'personal'
                ? '把喜欢的' + section.singular + '留给下一部作品'
                : '作品里还没有这类素材'
          }}
        </h2>
        <p>
          {{
            search || kind
              ? '试试其他名称或清空筛选。'
              : scope === 'personal'
                ? '可以从已有作品收藏，也可以新建。保存后随时用于其他作品。'
                : '在作品创作过程中添加素材后，这里会展示它的当前版本。'
          }}
        </p>
        <el-button
          v-if="!search && !kind && scope === 'personal'"
          @click="scope = 'project'"
          >查看作品中的{{ section.singular }}</el-button
        >
      </div>
      <div
        v-else
        class="library-grid"
        :class="{ 'library-list-view': layout === 'list' }"
      >
        <StudioAssetCard
          v-for="asset in data?.items"
          :key="asset.family + '/' + (asset.workId ?? '')"
          :asset="asset"
          :project="asset.workId"
          :source="asset.workTitle"
        >
          <template #actions>
            <el-checkbox
              v-if="
                scope === 'project' &&
                auth.can('studio.assets.write') &&
                !asset.origin
              "
              :model-value="checked.includes(asset.id)"
              :aria-label="'选择收藏' + asset.name"
              @change="toggleChecked(asset.id, $event)"
              >选择</el-checkbox
            >
            <el-button
              link
              :aria-label="'查看' + asset.name + '的详情与版本'"
              @click="viewing = asset"
              >详情与版本</el-button
            >
            <el-button
              v-if="
                !asset.project && !archived && auth.can('studio.projects.write')
              "
              link
              @click="linking = asset"
              >用于作品</el-button
            >
            <el-button
              v-if="asset.project && auth.can('studio.assets.write')"
              link
              @click="beginCollect(asset)"
              >{{ asset.origin ? '存回素材库' : '收藏到素材库' }}</el-button
            >
            <el-button
              v-if="
                !asset.project && !archived && auth.can('studio.assets.write')
              "
              link
              @click="editing = asset"
              >编辑设定</el-button
            >
            <el-button
              v-if="
                !asset.project &&
                !archived &&
                ['character', 'scene', 'prop'].includes(asset.kind) &&
                auth.can('studio.assets.write')
              "
              link
              @click="beginCollect(asset, true)"
              >{{
                asset.kind === 'scene' ? '新增环境变体' : '新增造型'
              }}</el-button
            >
            <el-button
              v-if="
                !asset.project &&
                !archived &&
                ['character', 'scene', 'prop'].includes(asset.kind) &&
                auth.can('studio.assets.write') &&
                auth.can('models.use')
              "
              link
              @click="producing = asset"
              >AI 制作</el-button
            >
            <router-link
              v-if="asset.workId"
              :to="{
                path: '/entertainment/' + asset.workId,
                query: {
                  section: ['character', 'scene', 'prop'].includes(asset.kind)
                    ? 'cast'
                    : 'edit',
                  asset: asset.id,
                },
              }"
              >查看作品用法</router-link
            >
          </template>
        </StudioAssetCard>
      </div>
      <template #pagination
        ><ManagementPagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="data?.total ?? 0"
          :loading="loading"
      /></template>
    </ManagementList>
    <StudioAssetDetail
      v-if="viewing"
      :asset="viewing"
      :selectable="!viewing.project && auth.can('studio.projects.write')"
      @changed="reload"
      @close="viewing = undefined"
      @choose="chooseVersion"
    />
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
      @close="closeEditor"
    />
    <StudioLinkAssetDialog
      v-if="linking"
      :asset="linking"
      @linked="linked"
      @close="linking = undefined"
    />
    <StudioCollectionDialog
      v-if="collecting"
      :asset="collecting"
      :variant="variant"
      @saved="collected"
      @close="collecting = undefined"
    />
    <StudioBatchCollectionDialog
      v-if="batch?.length"
      :assets="batch"
      @saved="batchSaved"
      @close="closeBatch"
    />
  </section>
</template>
<style scoped src="../../assets/styles/studio-library.css"></style>
