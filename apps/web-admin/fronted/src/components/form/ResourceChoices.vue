<script setup lang="ts">
import { computed, ref } from 'vue'
/** 声明式资源复选框：停用项不可新增，已选停用项仍允许解除关联。 */
const props = defineProps<{
  title: string
  items: { id: string; name: string; description?: string; enabled?: boolean }[]
  selected: string[]
  disabled?: boolean
  empty?: string
}>()
const emit = defineEmits<{
  change: [ids: string[], itemId: string, checked: boolean]
}>()
const query = ref('')
const selectedOnly = ref(false)
const filtered = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  return props.items.filter(
    (item) =>
      (!selectedOnly.value || props.selected.includes(item.id)) &&
      (!keyword ||
        `${item.name} ${item.description ?? ''}`
          .toLocaleLowerCase()
          .includes(keyword)),
  )
})
function toggle(id: string, checked: boolean): void {
  if (props.disabled) return
  const item = props.items.find((value) => value.id === id)
  if (!item || (checked && item.enabled === false)) return
  emit(
    'change',
    checked
      ? [...new Set([...props.selected, id])]
      : props.selected.filter((value) => value !== id),
    id,
    checked,
  )
}
</script>

<template>
  <fieldset class="resource-choices" :disabled="disabled">
    <legend>{{ title }}</legend>
    <div class="resource-choice-toolbar">
      <el-input
        v-model="query"
        :aria-label="`搜索${title}`"
        placeholder="搜索名称或说明"
        clearable
        :disabled="disabled"
      />
      <el-button
        text
        :aria-pressed="selectedOnly"
        :disabled="disabled"
        @click="selectedOnly = !selectedOnly"
        >{{ selectedOnly ? '查看全部' : `已选 ${selected.length}` }}</el-button
      >
    </div>
    <div class="resource-choices-list">
      <p v-if="!items.length" class="muted">
        {{ empty ?? '暂无可选项，请先在对应管理菜单中配置。' }}
      </p>
      <p v-else-if="!filtered.length" class="muted">
        {{ selectedOnly ? '没有匹配的已选资源。' : '没有匹配的资源。' }}
      </p>
      <label
        v-for="item in filtered"
        :key="item.id"
        class="resource-choice"
        :class="{ 'is-selected': selected.includes(item.id) }"
      >
        <input
          type="checkbox"
          :checked="selected.includes(item.id)"
          :disabled="item.enabled === false && !selected.includes(item.id)"
          @change="toggle(item.id, ($event.target as HTMLInputElement).checked)"
        />
        <span
          ><strong
            >{{ item.name
            }}{{ item.enabled === false ? '（已停用）' : '' }}</strong
          ><small v-if="item.description">{{ item.description }}</small></span
        >
      </label>
    </div>
  </fieldset>
</template>

<style scoped>
.resource-choices {
  min-width: 0;
  margin: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
}
.resource-choices legend {
  padding: 0 4px;
  font-size: 14px;
  font-weight: 500;
}
.resource-choices-list {
  max-height: 360px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.resource-choice-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.resource-choice-toolbar .el-input {
  flex: 1;
  min-width: 0;
}
.resource-choice.is-selected {
  background: var(--muted);
}
.resource-choices-list > p {
  margin: 0;
  font-size: 12px;
}
.resource-choice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
}
.resource-choice:hover {
  background: var(--muted);
}
.resource-choice input {
  margin-top: 4px;
  accent-color: var(--foreground);
}
.resource-choice span {
  min-width: 0;
  font-size: 14px;
}
.resource-choice strong {
  display: block;
  font-weight: 500;
}
.resource-choice small {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
