<script setup lang="ts">
import type { StudioAsset } from '@/types/studio/studio'
import { useAuthStore } from '@/store/modules/auth-store'
import { assetKinds, mediaKind } from '@/utils/studio/media-labels'
import { hasLibraryUpdates } from '@/utils/studio/library'
import ExpandableText from '@/components/base/ExpandableText.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import StudioMedia from '../StudioMedia.vue'

/** 各素材入口共用封面、版本与操作区，长设定不会挤压按钮或改变卡片对齐。 */
defineProps<{
  asset: StudioAsset
  project?: string | null
  selected?: boolean
  selectable?: boolean
  source?: string | null
}>()
const emit = defineEmits<{ select: [] }>()
const auth = useAuthStore()
</script>
<template>
  <article class="library-card" :class="{ 'library-card--selected': selected }">
    <component
      :is="selectable ? 'button' : 'div'"
      class="library-card-cover"
      :type="selectable ? 'button' : undefined"
      :aria-label="selectable ? '选择' + asset.name : undefined"
      :aria-pressed="selectable ? !!selected : undefined"
      @click="selectable && emit('select')"
    >
      <StudioMedia
        v-if="
          asset.fileId &&
          auth.can('files.read') &&
          mediaKind(asset.kind) !== 'audio'
        "
        :project="project ?? asset.project"
        :asset="asset.id"
        :kind="mediaKind(asset.kind)"
        lazy
      />
      <span v-else class="library-card-placeholder"
        ><AppIcon
          :name="asset.kind === 'character' ? 'users' : 'folder'"
        /><span>{{ assetKinds[asset.kind] }}</span
        ><strong>{{ asset.name }}</strong></span
      >
      <span v-if="selected" class="library-card-selected">已选择</span>
    </component>
    <div class="library-card-content">
      <div class="library-card-title">
        <h3>{{ asset.name }}</h3>
        <el-tag size="small">版本 {{ asset.version ?? '—' }}</el-tag>
      </div>
      <p v-if="asset.variantName" class="studio-meta">
        {{ asset.variantName }}
      </p>
      <ExpandableText
        :text="asset.description || '尚未补充设定'"
        label="设定"
        :lines="2"
      />
      <p v-if="source" class="studio-meta">{{ source }}</p>
      <p v-if="asset.kind === 'character'" class="studio-meta">
        {{ asset.voice ? '已配置角色声音' : '声音待选择' }}
      </p>
      <p v-if="asset.durationMs != null" class="studio-meta">
        时长 ·
        {{
          (asset.durationMs / 1000).toLocaleString(undefined, {
            maximumFractionDigits: 1,
          })
        }}
        秒
      </p>
      <p v-if="asset.origin" class="studio-meta">
        来自个人库 · {{ asset.origin.name
        }}<span v-if="hasLibraryUpdates(asset)"> · 库内有待采用更新</span>
      </p>
      <div v-if="$slots.actions" class="library-card-actions">
        <slot name="actions" />
      </div>
    </div>
  </article>
</template>
<style scoped src="../../../../assets/styles/studio-library.css"></style>
