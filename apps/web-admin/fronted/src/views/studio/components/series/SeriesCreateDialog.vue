<script setup lang="ts">
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { useSeriesCreation } from '@/composables/studio/use-series-creation'
import { useSeriesDraftGuard } from '@/composables/studio/use-series-draft-guard'
import StudioBriefFields from '../project/StudioBriefFields.vue'

/** 系列新建与分镜新建共用弹窗骨架；关闭不创建，提交成功后由作品目录决定导航。 */
const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  created: [id: string, openEditor: boolean]
}>()
const { form, dirty, canCreate, mutation, create } = useSeriesCreation()

async function submit(openEditor = true): Promise<boolean> {
  const result = await create()
  if (!result) return false
  emit('created', result.id, openEditor)
  return true
}
// 业务草稿保护涵盖返回、切产品和刷新，避免与弹窗的产品级导航保护重复确认。
useSeriesDraftGuard(
  () => props.modelValue && dirty.value,
  () => submit(false),
  () => mutation.busy.value,
)
</script>

<template>
  <ManagementDialog
    :model-value="modelValue"
    title="新建系列短剧"
    submit-text="创建并编排故事"
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :dirty="dirty"
    :readonly="!canCreate"
    :navigation-guard="false"
    :submit-disabled="!form.title.trim() || !canCreate"
    @update:model-value="emit('update:modelValue', $event)"
    @submit="submit()"
  >
    <el-alert
      v-if="!canCreate"
      title="当前账号只有查看权限"
      type="info"
      :closable="false"
    />
    <fieldset
      class="series-create-fields"
      :disabled="mutation.busy.value || !canCreate"
    >
      <label class="field">
        故事结构
        <el-radio-group
          v-model="form.narrativeMode"
          :disabled="mutation.busy.value || !canCreate"
          aria-label="故事结构"
        >
          <el-radio-button value="continuous">连续剧情</el-radio-button>
          <el-radio-button value="anthology">单元故事</el-radio-button>
        </el-radio-group>
        <small>
          {{
            form.narrativeMode === 'continuous'
              ? '各集承接同一条主线，编排时一起核对前情和伏笔。'
              : '每集可以独立成篇，共用角色、声音和世界设定。'
          }}
        </small>
      </label>
      <StudioBriefFields
        v-model="form"
        :disabled="mutation.busy.value || !canCreate"
      />
      <label class="field">
        初始集数
        <el-input-number
          v-model="form.plannedEpisodes"
          :disabled="mutation.busy.value || !canCreate"
          :min="1"
          :max="100"
          aria-label="初始集数"
        />
        <small
          >先创建这些分集草稿，后续可在「故事与分集」添加新集。目标时长按每集计算，确认故事后再进入单集制作。</small
        >
      </label>
    </fieldset>
  </ManagementDialog>
</template>

<style scoped>
.series-create-fields {
  display: grid;
  gap: var(--field-gap);
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}
</style>
