<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import AppDrawer from '@/components/overlay/AppDrawer.vue'

/** 按工作区真实宽度安排选镜、审看和检查器，抽屉仍编辑父级同一份工程草稿。 */
const props = defineProps<{ selected?: string }>()
const host = ref<HTMLElement>()
const compact = ref(false)
const inspector = ref(false)
let observer: ResizeObserver | undefined
let frame = 0
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (!entry) return
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      compact.value = entry.contentRect.width < 1100
      void revealSelected()
    })
  })
  if (host.value) observer.observe(host.value)
})
// 选镜和布局变化只滚动目录本身，不把预览及整页拉离当前位置。
async function revealSelected() {
  await nextTick()
  const rail = host.value?.querySelector<HTMLElement>(
    '.studio-rail .scroll-panel__body',
  )
  const item = rail?.querySelector<HTMLElement>('[aria-pressed="true"]')
  if (!rail || !item) return
  const box = rail.getBoundingClientRect(),
    current = item.getBoundingClientRect()
  if (current.left < box.left || current.right > box.right)
    rail.scrollLeft += current.left - box.left - (box.width - current.width) / 2
  if (
    rail.scrollHeight > rail.clientHeight &&
    (current.top < box.top || current.bottom > box.bottom)
  )
    rail.scrollTop += current.top - box.top - (box.height - current.height) / 2
}
watch(() => props.selected, revealSelected, { immediate: true })
onScopeDispose(() => {
  observer?.disconnect()
  cancelAnimationFrame(frame)
})
</script>
<template>
  <section ref="host" class="studio-workspace" aria-label="分镜工作区">
    <div v-if="compact" class="toolbar studio-inspector-entry">
      <span class="studio-meta">先选镜头，再审看画面与候选</span>
      <el-button @click="inspector = true">镜头设定</el-button>
    </div>
    <div class="studio-board" :class="{ 'studio-board--compact': compact }">
      <slot name="rail" />
      <slot />
      <div v-if="!compact" class="studio-inspector">
        <slot name="inspector" />
      </div>
    </div>
    <AppDrawer
      v-if="compact"
      v-model="inspector"
      title="镜头设定"
      class="studio-inspector-drawer"
      size="min(420px, 100vw)"
    >
      <slot name="inspector" />
      <template #footer
        ><el-button @click="inspector = false">返回审看</el-button
        ><span class="studio-meta"
          >修改保留在工程草稿，保存工程后生效。</span
        ></template
      >
    </AppDrawer>
  </section>
</template>
