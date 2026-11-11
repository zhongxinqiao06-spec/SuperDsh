<script setup lang="ts">
import { ref, watch, onScopeDispose, nextTick } from 'vue'
import { renderDiagram } from '@/utils/diagram-renderer'
/** 异步图表结果受组件代际保护，卸载后不留下隐藏绘制节点。 */
const props = defineProps<{ source: string }>()
const host = ref<HTMLElement | null>(null),
  svg = ref(''),
  error = ref('')
let generation = 0
watch(
  () => props.source,
  async (source) => {
    const current = ++generation
    svg.value = ''
    error.value = ''
    await nextTick()
    if (!host.value || current !== generation) return
    const drawing = document.createElement('div')
    host.value.append(drawing)
    try {
      const result = await renderDiagram(source, drawing)
      if (current === generation) svg.value = result
    } catch {
      if (current === generation) error.value = '图表暂时无法渲染，可查看源代码'
    } finally {
      drawing.remove()
    }
  },
  { immediate: true },
)
onScopeDispose(() => {
  generation++
  host.value?.replaceChildren()
})
</script>
<template>
  <figure class="mermaid-diagram">
    <div ref="host" class="drawing" aria-hidden="true" />
    <div v-if="svg" v-html="svg" />
    <details v-else-if="error">
      <summary>{{ error }}</summary>
      <pre>{{ source }}</pre>
    </details>
    <p v-else>正在绘制图表…</p>
  </figure>
</template>
<style scoped>
.mermaid-diagram {
  margin: 12px 0;
  overflow: auto;
}
.drawing {
  position: absolute;
  left: -100000px;
  pointer-events: none;
}
.mermaid-diagram :deep(svg) {
  max-width: 100%;
  height: auto;
}
pre {
  white-space: pre-wrap;
}
</style>
