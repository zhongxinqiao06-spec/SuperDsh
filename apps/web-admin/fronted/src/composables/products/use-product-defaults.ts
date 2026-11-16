import { computed, ref } from 'vue'
import { productManagementApi } from '@/api/products/management-api'
import { useCurrentProduct } from '@/composables/console/use-current-product'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import type { Capability } from '@/types/models/models'

/** 只从服务端分配的模型池挑选；null 表示恢复平台默认。 */
export function useProductDefaults() {
  const product = useCurrentProduct()
  const resource = useResource((signal) =>
    productManagementApi.defaults(product.value, signal),
  )
  const mutation = useMutation()
  const editing = ref<Capability | null>(null),
    selection = ref('')
  const rows = computed(() => {
    const catalog = resource.data.value
    if (!catalog) return []
    const capabilities = new Set<Capability>([
      ...catalog.configurations.map((c) => c.capability),
      ...catalog.defaults.map((d) => d.capability),
      ...(Object.keys(catalog.overrides) as Capability[]),
    ])
    return [...capabilities].map((capability) => {
      const selected = catalog.overrides[capability]
      const effective =
        selected ||
        catalog.defaults.find((d) => d.capability === capability)
          ?.configurationId
      const active = catalog.configurations.find((c) => c.id === effective)
      return {
        capability,
        overridden: Boolean(selected),
        effectiveLabel: active?.name ?? (effective ? '配置已不可用' : '未配置'),
      }
    })
  })
  const choices = computed(
    () =>
      resource.data.value?.configurations.filter(
        (c) => c.capability === editing.value,
      ) ?? [],
  )
  function edit(capability: Capability) {
    mutation.error.value = ''
    editing.value = capability
    selection.value = resource.data.value?.overrides[capability] ?? ''
  }
  async function save() {
    const capability = editing.value
    if (
      capability &&
      (await mutation.run(() =>
        productManagementApi.setDefault(
          product.value,
          capability,
          selection.value || null,
        ),
      ))
    ) {
      editing.value = null
      await resource.reload()
    }
  }
  return { resource, mutation, rows, choices, editing, selection, edit, save }
}
