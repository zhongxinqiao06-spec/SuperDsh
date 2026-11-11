import { reactive, ref } from 'vue'
import { systemApi } from '@/api/service/system-api'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import type { DashboardSettings } from '@/types/service/system'

/** 日期范围、统计阈值与快照重算都是显式操作，失败保留当前查询。 */
export function useDashboard() {
  const today = new Date().toLocaleDateString('en-CA')
  const start = new Date(`${today}T12:00:00`)
  start.setDate(start.getDate() - 29)
  const query = reactive({
    from: start.toLocaleDateString('en-CA'),
    to: today,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  })
  const resource = useResource((signal) =>
      systemApi.overview(query.from, query.to, query.tz, signal),
    ),
    mutation = useMutation()
  const editing = ref(false),
    bins = reactive({ messages: '', sessions: '' })
  const settings = ref<DashboardSettings>({
    intensity: { basis: 'messages', lightMax: 10, mediumMax: 50 },
    histogramBins: { messages: [0, 5, 20, 100], sessions: [0, 1, 5, 20] },
  })
  function openSettings() {
    if (resource.data.value)
      settings.value = structuredClone(resource.data.value.settings)
    bins.messages = settings.value.histogramBins.messages.join(',')
    bins.sessions = settings.value.histogramBins.sessions.join(',')
    editing.value = true
  }
  async function saveSettings() {
    const messages = bins.messages.split(',').map(Number),
      sessions = bins.sessions.split(',').map(Number)
    if (
      [...messages, ...sessions].some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      )
    ) {
      mutation.error.value =
        '分段边界须为非负整数 / Bin boundaries must be nonnegative integers'
      return
    }
    if (
      await mutation.run(() =>
        systemApi.dashboardSettings({
          intensity: settings.value.intensity,
          histogramBins: { messages, sessions },
        }),
      )
    ) {
      editing.value = false
      await resource.reload()
    }
  }
  async function snapshot() {
    if (await mutation.run(() => systemApi.snapshot(query.to, query.tz)))
      await resource.reload()
  }
  return {
    resource,
    mutation,
    query,
    editing,
    bins,
    settings,
    openSettings,
    saveSettings,
    snapshot,
  }
}
