import { ref } from 'vue'
import { productionApi } from '@/api/studio/production-api'
import { useMutation } from '@/composables/use-mutation'
import type { GenerationPlan } from '@/types/studio/production'

/** 失败保留冻结计划，重复确认使用同一计划身份，避免再次发起付费任务。 */
export function useProductionPlan(
  kind: 'projects' | 'entities',
  id: () => string,
  updated: () => void | Promise<void>,
) {
  const plan = ref<GenerationPlan>(),
    open = ref(false)
  const mutation = useMutation()
  async function prepare(load: () => Promise<GenerationPlan>) {
    await mutation.run(async () => {
      plan.value = await load()
      open.value = true
    })
  }
  async function confirm() {
    if (!plan.value) return
    await mutation.run(async () => {
      await productionApi.confirm(kind, id(), plan.value!)
      open.value = false
      await updated()
    })
  }
  return { plan, open, ...mutation, prepare, confirm }
}
