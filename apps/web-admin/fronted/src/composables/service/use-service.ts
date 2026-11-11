import { reactive, ref, watch } from 'vue'
import { systemApi } from '@/api/service/system-api'
import { useMutation } from '@/composables/use-mutation'
import { useResource } from '@/composables/use-resource'
import { serviceSettingsDraft } from '@/utils/service/service-drafts'
import type {
  Announcement,
  ServiceSettings,
  ServiceSettingsDraft,
} from '@/types/service/system'

/** 编辑草稿只保存当前页面；明确清除密钥才发送 clear 标志。 */
export function useService() {
  const resource = useResource(async (signal) => {
    const [settings, announcement, information] = await Promise.all([
      systemApi.settings(signal),
      systemApi.announcement(signal),
      systemApi.information(signal),
    ])
    return { settings, announcement, information }
  })
  const mutation = useMutation(),
    notice = ref('')
  const editing = ref<'access' | 'email' | 'oauth' | 'announcement' | null>(
    null,
  )
  function edit(section: NonNullable<typeof editing.value>) {
    const current = resource.data.value
    if (!current) return
    settings.value = serviceSettingsDraft(current.settings)
    Object.assign(announcement, current.announcement)
    mutation.error.value = ''
    editing.value = section
  }
  const settings = ref<ServiceSettingsDraft | null>(null),
    announcement = reactive<Announcement>({
      enabled: false,
      markdown: '',
      revision: 0,
      publishedAt: null,
    })
  watch(resource.data, (value) => {
    if (value) {
      settings.value = serviceSettingsDraft(value.settings)
      Object.assign(announcement, value.announcement)
    } else settings.value = null
  })
  async function save() {
    const value = settings.value
    const section = editing.value
    if (!value || !section || section === 'announcement') return
    const { apiKeyConfigured: _emailConfigured, ...email } = value.email
    const {
      clientSecretConfigured: _oauthConfigured,
      clientSecret,
      ...oauth
    } = value.oauth
    // 分区保存不携带其他草稿，防止保存邮件或访问配置时把未配置的 OAuth 变成空配置。
    const update: Partial<ServiceSettings> = { revision: value.revision }
    if (section === 'access') {
      update.registrationOpen = value.registrationOpen
      update.oauthRegistrationOpen = value.oauthRegistrationOpen
    } else if (section === 'email') update.email = email
    else
      update.oauth = {
        ...oauth,
        ...(clientSecret?.trim() ? { clientSecret: clientSecret.trim() } : {}),
      }
    if (await mutation.run(() => systemApi.updateSettings(update))) {
      notice.value = '配置已保存 / Settings saved'
      editing.value = null
      await resource.reload()
    }
  }
  async function publish() {
    if (
      await mutation.run(() =>
        systemApi.publish({
          enabled: announcement.enabled,
          markdown: announcement.markdown,
          revision: announcement.revision,
        }),
      )
    ) {
      notice.value = '公告已保存 / Announcement saved'
      editing.value = null
      await resource.reload()
    }
  }
  return {
    resource,
    mutation,
    notice,
    settings,
    announcement,
    save,
    publish,
    editing,
    edit,
  }
}
