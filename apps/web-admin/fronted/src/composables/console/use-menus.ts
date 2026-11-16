import { createUuid } from '@/utils/uuid'
import { computed, ref, toRaw, watch } from 'vue'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import { navigationApi } from '@/api/console/navigation-api'
import type { MenuNode, Product } from '@/types/console/navigation'
import { useRoute } from 'vue-router'
import { productOf } from '@/utils/studio/products'

/** 菜单编辑保留服务端版本；冲突时不丢本地草稿或自动覆盖。 */
export function useMenus() {
  const auth = useAuthStore()
  const route = useRoute()
  const product = ref<Product>(productOf(route.query.product) ?? 'office')
  const globalAccess = computed(
    () => auth.can('menus.read') || auth.can('menus.manage'),
  )
  const previewOpen = ref(false)
  const resource = useResource((signal) =>
    navigationApi.menus(product.value, signal),
  )
  const mutation = useMutation()
  const items = ref<MenuNode[]>([]),
    version = ref(0),
    resetOpen = ref(false)
  const editing = ref<MenuNode | null>(null)
  const deletingGroup = ref<MenuNode | null>(null)
  const query = ref(''),
    page = ref(1),
    pageSize = ref(10)
  const filtered = computed(() => {
    const value = query.value.trim().toLocaleLowerCase()
    return items.value
      .filter(
        (item) =>
          !value ||
          `${item.title} ${item.moduleId ?? ''}`
            .toLocaleLowerCase()
            .includes(value),
      )
      .sort((left, right) => left.order - right.order)
  })
  const rows = computed(() =>
    filtered.value.slice(
      (page.value - 1) * pageSize.value,
      page.value * pageSize.value,
    ),
  )
  watch([query, pageSize], () => {
    page.value = 1
  })
  const canEdit = computed(
    () =>
      auth.can('menus.manage') ||
      auth.can('products.' + product.value + '.menus.manage'),
  )
  function editable(item: MenuNode): boolean {
    const ids = resource.data.value?.editableIds
    return canEdit.value && (!ids || ids.includes(item.id))
  }
  // 切换编辑对象时清除旧版本与筛选，避免用办公的配置覆盖娱乐菜单。
  watch(product, () => {
    items.value = []
    version.value = 0
    editing.value = null
    deletingGroup.value = null
    resetOpen.value = false
    previewOpen.value = false
    query.value = ''
    page.value = 1
    mutation.error.value = ''
    void resource.reload()
  })
  watch(resource.data, (value) => {
    if (value) {
      items.value = structuredClone(value.items)
      version.value = value.version
      editing.value = null
      mutation.error.value = ''
      page.value = Math.min(
        page.value,
        Math.max(1, Math.ceil(filtered.value.length / pageSize.value)),
      )
    }
  })
  function edit(item: MenuNode): void {
    editing.value = structuredClone(toRaw(item))
  }
  async function apply(): Promise<void> {
    if (!editing.value?.title.trim()) return
    const value = editing.value
    value.parentId = value.parentId || null
    const next = structuredClone(toRaw(items.value))
    const index = next.findIndex((item) => item.id === value.id)
    if (index < 0) next.push(structuredClone(toRaw(value)))
    else next[index] = structuredClone(toRaw(value))
    // 弹窗保存即提交版本条件，冲突时保留编辑器，不用第二次全表提交才能生效。
    if (
      await mutation.run(() =>
        navigationApi.save(product.value, version.value, next),
      )
    ) {
      await resource.reload()
      window.dispatchEvent(new Event('starbridge:navigation-changed'))
    }
  }
  function addGroup(): void {
    editing.value = {
      id: 'group-' + createUuid(),
      kind: 'group',
      moduleId: null,
      parentId: null,
      title: '',
      icon: 'folder',
      order: items.value.length,
      visible: true,
      roleIds: [],
    }
  }
  async function removeGroup(): Promise<void> {
    const group = deletingGroup.value
    if (!group || group.kind !== 'group') return
    // 分组只是导航组织；移除分组时页面升为一级，业务入口不能随分组删除。
    const next = items.value
      .filter((item) => item.id !== group.id)
      .map((item) =>
        item.parentId === group.id ? { ...item, parentId: null } : item,
      )
    if (
      await mutation.run(() =>
        navigationApi.save(product.value, version.value, next),
      )
    ) {
      deletingGroup.value = null
      await resource.reload()
      window.dispatchEvent(new Event('starbridge:navigation-changed'))
    }
  }
  async function save(): Promise<void> {
    if (
      await mutation.run(() =>
        navigationApi.save(product.value, version.value, items.value),
      )
    ) {
      await resource.reload()
      window.dispatchEvent(new Event('starbridge:navigation-changed'))
    }
  }
  async function reset(): Promise<void> {
    if (
      await mutation.run(() =>
        navigationApi.reset(product.value, version.value),
      )
    ) {
      resetOpen.value = false
      await resource.reload()
      window.dispatchEvent(new Event('starbridge:navigation-changed'))
    }
  }
  return {
    product,
    globalAccess,
    previewOpen,
    editable,
    resource,
    mutation,
    items,
    version,
    resetOpen,
    editing,
    deletingGroup,
    canEdit,
    query,
    page,
    pageSize,
    rows,
    filtered,
    edit,
    apply,
    addGroup,
    removeGroup,
    save,
    reset,
  }
}
