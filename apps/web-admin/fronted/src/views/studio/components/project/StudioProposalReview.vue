<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { preparationApi } from '@/api/studio/preparation-api'
import type { ProposalComparison } from '@/types/studio/preparation'
import type { StudioProject } from '@/types/studio/studio'
import { proposalPresenter } from '@/utils/studio/proposal-presentation'
import ExpandableText from '@/components/base/ExpandableText.vue'

/** 基线、当前内容、导演建议并列显示，用户只采用选中字段。 */
const props = defineProps<{
  project: StudioProject
  readonly: boolean
  save: () => Promise<void>
}>()
const emit = defineEmits<{ reviewed: [] }>()
const comparison = ref<ProposalComparison>(),
  selected = ref<string[]>([]),
  overrides = ref<string[]>([]),
  error = ref(''),
  busy = ref(false)
const conflicts = computed(
  () =>
    comparison.value?.changes.filter((change) => change.conflict).length ?? 0,
)
const presenter = computed(() =>
  proposalPresenter(props.project, comparison.value?.changes ?? []),
)
function selectSafe() {
  selected.value =
    comparison.value?.changes
      .filter((change) => !change.conflict)
      .map((change) => change.key) ?? []
  overrides.value = []
}
function clearSelection() {
  selected.value = []
  overrides.value = []
}
watch(
  () => [props.project.proposal?.id, props.project.revision],
  async (_, __, onCleanup) => {
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    if (!props.project.proposal) {
      comparison.value = undefined
      return
    }
    try {
      const result = await preparationApi.compare(
        props.project.id,
        props.project.proposal.id,
        controller.signal,
      )
      if (!controller.signal.aborted) {
        comparison.value = result
        selected.value = []
        overrides.value = []
        error.value = ''
      }
    } catch (cause) {
      if (!controller.signal.aborted) error.value = String(cause)
    }
  },
  { immediate: true },
)
let intent: { signature: string; key: string } | undefined
async function review(keep = false) {
  if (busy.value || !comparison.value || props.readonly) return
  busy.value = true
  error.value = ''
  try {
    const revision = comparison.value.revision
    await props.save()
    if (revision !== props.project.revision)
      throw new Error('已保存最新编辑，请重新核对更新后的字段对比')
    const data = {
      revision,
      selected: keep ? [] : selected.value,
      overrides: keep
        ? []
        : overrides.value.filter((key) => selected.value.includes(key)),
    }
    const signature = JSON.stringify([comparison.value.id, data])
    if (intent?.signature !== signature)
      intent = { signature, key: crypto.randomUUID() }
    await preparationApi.review(props.project.id, comparison.value.id, {
      ...data,
      requestKey: intent.key,
    })
    intent = undefined
    emit('reviewed')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section v-if="project.proposal" class="panel preparation-proposal">
    <div class="toolbar">
      <div>
        <span class="eyebrow">导演建议 · 等待你的决定</span>
        <h2>方案对比</h2>
      </div>
      <span class="toolbar-spacer" /><span class="studio-meta"
        >未选择的字段保留现有内容</span
      >
    </div>
    <p v-if="!comparison && !error">正在读取字段对比…</p>
    <p v-else-if="!comparison?.changes.length">
      草案与当前基线没有字段差异，可以保留当前方案。
    </p>
    <div v-if="comparison?.changes.length" class="toolbar">
      <span class="studio-meta"
        >{{ comparison.changes.length }} 项建议 · 已选
        {{ selected.length }} 项<span v-if="conflicts">
          · {{ conflicts }} 项涉及手工修改</span
        ></span
      >
      <el-button v-if="!readonly" :disabled="busy" @click="selectSafe"
        >选择无冲突建议</el-button
      >
      <el-button
        v-if="!readonly && selected.length"
        text
        :disabled="busy"
        @click="clearSelection"
        >清空选择</el-button
      >
    </div>
    <article
      v-for="change in comparison?.changes ?? []"
      :key="change.key"
      class="proposal-change"
    >
      <div class="toolbar">
        <el-checkbox
          :model-value="selected.includes(change.key)"
          :disabled="readonly || busy"
          @update:model-value="
            (value: unknown) =>
              (selected = value
                ? [...selected, change.key]
                : selected.filter((key) => key !== change.key))
          "
          >{{ change.label.replace(/^镜 (\d+)/, '第 $1 镜') }}</el-checkbox
        ><el-tag v-if="change.conflict" type="warning">已有手工修改</el-tag>
      </div>
      <div class="proposal-values">
        <div>
          <small>草案生成时</small>
          <ExpandableText
            class="proposal-value"
            :text="presenter.display(change, 'before')"
            label="内容"
            :lines="8"
          />
        </div>
        <div>
          <small>当前保留</small>
          <ExpandableText
            class="proposal-value"
            :text="presenter.display(change, 'current')"
            label="内容"
            :lines="8"
          />
        </div>
        <div>
          <small>导演建议</small>
          <ExpandableText
            class="proposal-value"
            :text="presenter.display(change, 'after')"
            label="内容"
            :lines="8"
          />
        </div>
      </div>
      <el-checkbox
        v-if="change.conflict && selected.includes(change.key)"
        :model-value="overrides.includes(change.key)"
        :disabled="readonly || busy"
        @update:model-value="
          (value: unknown) =>
            (overrides = value
              ? [...overrides, change.key]
              : overrides.filter((key) => key !== change.key))
        "
        >确认用此建议覆盖该字段的手工修改</el-checkbox
      >
    </article>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-if="!readonly" class="toolbar proposal-review-actions">
      <el-button :disabled="busy" @click="review(true)">保留现有方案</el-button
      ><el-button
        type="primary"
        :loading="busy"
        :disabled="
          !selected.length ||
          comparison?.changes.some(
            (c) =>
              c.conflict &&
              selected.includes(c.key) &&
              !overrides.includes(c.key),
          )
        "
        @click="review()"
        >采用选中字段</el-button
      >
    </div>
  </section>
</template>
