<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onScopeDispose,
  ref,
  useId,
  watch,
} from 'vue'

import { markdownBlocks } from '@/utils/markdown'

/** 长说明在原位置展开，避免卡片或弹窗再套一层滚动条；保留完整文本供阅读。 */
const props = withDefaults(
  defineProps<{
    text: string
    label?: string
    lines?: number
    markdown?: boolean
  }>(),
  { label: '说明', lines: 4 },
)
const expanded = ref(false)
const displayText = computed(() =>
  props.markdown
    ? markdownBlocks(props.text)
        .map((block) =>
          block.tokens.length
            ? block.tokens.map((token) => token.text).join('')
            : block.text,
        )
        .join('\n')
    : props.text,
)
const paragraph = ref<HTMLElement>()
const contentId = useId()
const collapsible = ref(false)
let observer: ResizeObserver | undefined
let frame = 0
function scheduleMeasure() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(measure)
}
// 根据实际排版高度判断，不用字符数猜测中文在窄卡片中占多少行。
function measure() {
  const element = paragraph.value
  if (!element || !element.clientWidth) return
  const line = Number.parseFloat(getComputedStyle(element).lineHeight)
  collapsible.value = element.scrollHeight > line * props.lines + 1
}
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(scheduleMeasure)
    if (paragraph.value) observer.observe(paragraph.value)
  }
  measure()
})
watch(
  () => [props.text, props.lines],
  async () => {
    expanded.value = false
    await nextTick()
    measure()
  },
)
onScopeDispose(() => {
  observer?.disconnect()
  cancelAnimationFrame(frame)
})
</script>

<template>
  <div class="expandable-text">
    <p
      :id="contentId"
      ref="paragraph"
      :class="{ 'expandable-text-preview': !expanded }"
      :style="{ '--text-preview-lines': lines }"
    >
      {{ displayText }}
    </p>
    <el-button
      v-if="collapsible"
      text
      :aria-expanded="expanded"
      :aria-controls="contentId"
      :aria-label="`${expanded ? '收起' : '展开'}${label}`"
      @click="expanded = !expanded"
      >{{ expanded ? '收起' : '展开完整' + label }}</el-button
    >
  </div>
</template>

<style scoped>
.expandable-text {
  display: grid;
  min-width: 0;
  gap: var(--label-gap);
  justify-items: start;
}
.expandable-text p {
  max-width: 100%;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.expandable-text-preview {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--text-preview-lines);
  overflow: hidden;
}
.expandable-text .el-button {
  margin: 0;
}
</style>
