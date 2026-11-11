<script setup lang="ts">
import { computed, ref } from 'vue'
import SettingsCard from '@/components/settings/SettingsCard.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import { usePreferences } from '@/store/modules/preferences'
import type { ServiceInformation } from '@/types/service/system'
/** 服务摘要展示后端报告的版本和存储状态；公开访问地址使用当前浏览器入口。 */
const props = defineProps<{ information: ServiceInformation }>()
const { tr } = usePreferences()
const endpoint = window.location.origin,
  copyError = ref('')
const uptime = computed(() => {
  const seconds = Math.max(0, props.information.uptimeSeconds)
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h`
    : seconds >= 60
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds)}s`
})
async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    copyError.value = ''
  } catch {
    copyError.value = tr(
      '复制失败，请手动选择内容复制。',
      'Copy failed. Select and copy the text manually.',
    )
  }
}
</script>
<template>
  <SettingsCard
    :title="tr('服务器', 'Server')"
    :description="
      tr(
        '后端报告的运行状态和存储信息。',
        'Runtime and storage information reported by the backend.',
      )
    "
  >
    <template #action><AppIcon name="server" /></template>
    <dl class="settings-details">
      <div>
        <dt>{{ tr('访问地址', 'Public address') }}</dt>
        <dd class="service-information-value">
          <code>{{ endpoint }}</code
          ><el-button
            text
            :aria-label="tr('复制访问地址', 'Copy address')"
            @click="copy(endpoint)"
            ><AppIcon name="copy"
          /></el-button>
        </dd>
      </div>
      <div>
        <dt>{{ tr('版本', 'Version') }}</dt>
        <dd>
          <code>{{ information.version }}</code>
        </dd>
      </div>
      <div>
        <dt>{{ tr('数据库', 'Database') }}</dt>
        <dd class="service-information-value">
          <span
            ><el-tag>{{ information.database }}</el-tag>
            <code>{{ information.databasePath }}</code></span
          ><el-button
            text
            :aria-label="tr('复制数据库位置', 'Copy database location')"
            @click="copy(information.databasePath)"
            ><AppIcon name="copy"
          /></el-button>
        </dd>
      </div>
      <div>
        <dt>{{ tr('启动时间', 'Started') }}</dt>
        <dd>
          <code>{{ information.startedAt }}</code>
        </dd>
      </div>
      <div>
        <dt>{{ tr('运行时间', 'Uptime') }}</dt>
        <dd>{{ uptime }}</dd>
      </div>
    </dl>
    <p v-if="copyError" role="alert">{{ copyError }}</p>
  </SettingsCard>
</template>
