<script setup lang="ts">
import { computed } from 'vue'
import { usePreferences } from '@/store/modules/preferences'
/** 主列表与子列表各自维护页码，范围和翻页控制按组呈现。 */
const props = defineProps<{
  currentPage: number
  pageSize: number
  total: number
  pageSizes?: number[]
  loading?: boolean
}>()
const emit = defineEmits<{
  'update:currentPage': [value: number]
  'update:pageSize': [value: number]
  change: []
}>()
const { tr } = usePreferences()
const pages = computed(() =>
  Math.max(1, Math.ceil(props.total / props.pageSize)),
)
const start = computed(() =>
  props.total ? (props.currentPage - 1) * props.pageSize + 1 : 0,
)
function move(page: number): void {
  if (props.loading || page < 1 || page > pages.value) return
  emit('update:currentPage', page)
  emit('change')
}
function resize(event: Event): void {
  const size = Number((event.target as HTMLSelectElement).value)
  if (props.loading || !(props.pageSizes ?? [10, 20, 50]).includes(size)) return
  emit('update:pageSize', size)
  emit('update:currentPage', 1)
  emit('change')
}
</script>

<template>
  <nav
    v-if="total > 0"
    class="management-pagination"
    :aria-label="tr('列表分页', 'List pagination')"
  >
    <span class="pagination-total"
      >{{ tr(`共 ${total} 条`, `${total} items`)
      }}<template v-if="total">
        · {{ start }}–{{ Math.min(currentPage * pageSize, total) }}</template
      ></span
    >
    <div class="pagination-controls">
      <label v-if="pageSizes" class="pagination-size"
        >{{ tr('每页', 'Per page')
        }}<select :value="pageSize" :disabled="loading" @change="resize">
          <option v-for="size in pageSizes" :key="size" :value="size">
            {{ size }}
          </option>
        </select></label
      >
      <el-button
        :disabled="loading || currentPage <= 1"
        @click="move(currentPage - 1)"
        >{{ tr('上一页', 'Previous') }}</el-button
      >
      <span>{{
        tr(`第 ${currentPage} / ${pages} 页`, `Page ${currentPage} / ${pages}`)
      }}</span>
      <el-button
        :disabled="loading || currentPage >= pages"
        @click="move(currentPage + 1)"
        >{{ tr('下一页', 'Next') }}</el-button
      >
    </div>
  </nav>
</template>
