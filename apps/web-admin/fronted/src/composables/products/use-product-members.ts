import { ref, watch } from 'vue'
import { productManagementApi } from '@/api/products/management-api'
import { useCurrentProduct } from '@/composables/console/use-current-product'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import type { ProductMember } from '@/types/products/management'

/** 成员资格独立于全局账号，增减只提交本产品的单条成员变更。 */
export function useProductMembers() {
  const product = useCurrentProduct()
  const page = ref(1),
    pageSize = ref(10),
    search = ref(''),
    query = ref('')
  const adding = ref(false),
    identifier = ref(''),
    removing = ref<ProductMember | null>(null)
  const mutation = useMutation()
  const resource = useResource((signal) =>
    productManagementApi.members(
      product.value,
      page.value,
      pageSize.value,
      search.value,
      signal,
    ),
  )
  watch(
    [search, pageSize],
    () => {
      page.value = 1
    },
    { flush: 'sync' },
  )
  watch([page, pageSize, search], () => void resource.reload())
  watch(
    () => resource.data.value?.total,
    (total) => {
      if (total !== undefined)
        page.value = Math.min(
          page.value,
          Math.max(1, Math.ceil(total / pageSize.value)),
        )
    },
  )
  function filter() {
    if (search.value === query.value.trim()) void resource.reload()
    else search.value = query.value.trim()
  }
  function add() {
    identifier.value = ''
    mutation.error.value = ''
    adding.value = true
  }
  function remove(member: ProductMember) {
    removing.value = member
    mutation.error.value = ''
  }
  async function grant() {
    const value = identifier.value.trim()
    if (
      value &&
      (await mutation.run(() =>
        productManagementApi.grant(product.value, value),
      ))
    ) {
      adding.value = false
      await resource.reload()
    }
  }
  async function revoke() {
    const member = removing.value
    if (
      member?.removable &&
      (await mutation.run(() =>
        productManagementApi.revoke(product.value, member),
      ))
    ) {
      removing.value = null
      await resource.reload()
    }
  }
  return {
    page,
    pageSize,
    query,
    resource,
    mutation,
    adding,
    identifier,
    removing,
    add,
    remove,
    grant,
    revoke,
    filter,
  }
}
