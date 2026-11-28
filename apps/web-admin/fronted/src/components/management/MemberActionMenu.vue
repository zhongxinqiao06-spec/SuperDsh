<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue'
import AppIcon from '@/components/base/AppIcon.vue'
import type { RowAction } from '@/types/common/management'
/** 桌面菜单和手机操作面板共用已授权动作，始终绑定触发它的那一行。 */
const props = defineProps<{
  label: string
  owner: string
  actions: RowAction[]
  emphasis?: boolean
  busy?: boolean
}>()
const emit = defineEmits<{ action: [key: string] }>()
const narrow = ref(false),
  opened = ref(false)
let media: MediaQueryList | undefined
function resize() {
  narrow.value = !!media?.matches
  opened.value = false
}
onMounted(() => {
  media = window.matchMedia('(max-width: 640px)')
  resize()
  media.addEventListener('change', resize)
})
onScopeDispose(() => media?.removeEventListener('change', resize))
const grantIcons: Record<string, string> = {
  open: 'shield',
  renew: 'shield',
  gift: 'plus',
  card: 'box',
}
function choose(key: string) {
  if (props.busy || !props.actions.some((a) => a.key === key && !a.disabled))
    return
  opened.value = false
  emit('action', key)
}
</script>
<template>
  <template v-if="actions.length">
    <template v-if="narrow">
      <el-button
        :class="{ 'member-grant-button': emphasis }"
        :disabled="busy"
        aria-haspopup="dialog"
        @click="opened = true"
        >{{ label }}<AppIcon name="chevron-down" :size="14"
      /></el-button>
      <el-drawer
        v-model="opened"
        direction="btt"
        size="auto"
        append-to-body
        class="member-action-sheet"
        :title="owner + ' · ' + label"
      >
        <button
          v-for="a in actions"
          :key="a.key"
          type="button"
          :class="{ 'danger-action': a.danger }"
          :disabled="a.disabled || busy"
          @click="choose(a.key)"
        >
          {{ a.label }}
        </button>
      </el-drawer>
    </template>
    <el-dropdown
      v-else
      trigger="click"
      placement="bottom-end"
      popper-class="member-action-menu"
      :disabled="busy"
      @command="choose"
    >
      <el-button :class="{ 'member-grant-button': emphasis }" :disabled="busy"
        >{{ label }}<AppIcon name="chevron-down" :size="14"
      /></el-button>
      <template #dropdown
        ><el-dropdown-menu>
          <el-dropdown-item
            v-for="(a, i) in actions"
            :key="a.key"
            :command="a.key"
            :disabled="a.disabled"
            :divided="!!a.danger && i > 0 && !actions[i - 1]?.danger"
            :class="{ 'danger-action': a.danger }"
            ><AppIcon
              v-if="emphasis && grantIcons[a.key]"
              :name="grantIcons[a.key]!"
              :size="16"
            />{{ a.label }}</el-dropdown-item
          >
        </el-dropdown-menu></template
      >
    </el-dropdown>
  </template>
</template>
