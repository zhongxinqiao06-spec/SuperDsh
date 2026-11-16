import { computed, ref, watch, type Ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { StudioDocument } from '@/types/studio/studio'
import { newId } from '@/utils/studio/storyboard'
import { sceneSummary } from '@/utils/studio/script-workspace'

/** 场次编辑保持稳定选中项；删除只允许无镜头引用的场次，并要求明确确认。 */
export function useScriptScenes(
  document: Ref<StudioDocument>,
  readonly: () => boolean,
) {
  const selected = ref('')
  const scenes = computed(() => document.value.scenes ?? [])
  const active = computed(() =>
    scenes.value.find((scene) => scene.id === selected.value),
  )
  const summary = computed(() => sceneSummary(document.value, selected.value))
  watch(
    () => scenes.value.map((scene) => scene.id),
    (ids) => {
      if (!ids.includes(selected.value)) selected.value = ids[0] ?? ''
    },
    { immediate: true },
  )
  function add(synopsis = '') {
    if (readonly()) return
    const scene = {
      id: newId(),
      title: `第 ${scenes.value.length + 1} 场`,
      synopsis,
    }
    document.value.scenes = [...scenes.value, scene]
    selected.value = scene.id
  }
  function move(step: number) {
    if (readonly()) return
    const index = scenes.value.findIndex((scene) => scene.id === selected.value)
    if (index < 0 || index + step < 0 || index + step >= scenes.value.length)
      return
    const [scene] = scenes.value.splice(index, 1)
    scenes.value.splice(index + step, 0, scene!)
  }
  async function remove() {
    const id = selected.value
    if (readonly() || !id || sceneSummary(document.value, id).shots.length)
      return
    const confirmed = await ElMessageBox.confirm(
      '移除此场次安排？剧本原文不变，历史修订仍保留。',
      '移除场次',
      { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' },
    )
      .then(() => true)
      .catch(() => false)
    if (
      confirmed &&
      !readonly() &&
      !sceneSummary(document.value, id).shots.length
    )
      document.value.scenes = scenes.value.filter((scene) => scene.id !== id)
  }
  return { scenes, selected, active, summary, add, move, remove }
}
