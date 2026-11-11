import { reactive, ref } from 'vue'
import { accountApi } from '@/api/account/account-api'
import { authApi } from '@/api/auth/auth-api'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import { sessionController } from '@/store/session-controller'
import type { Identity } from '@/types/auth/auth'

/** 本人资料由独立接口提交，上传图片只在校验后读入内存。 */
export function useProfile() {
  const auth = useAuthStore(),
    mutation = useMutation(),
    config = useResource(authApi.config)
  const form = reactive({
    displayName: auth.session?.displayName ?? '',
    email: auth.session?.email ?? '',
    code: '',
  })
  const notice = ref('')
  const editing = ref<'name' | 'email' | 'avatar' | null>(null)
  function edit(section: NonNullable<typeof editing.value>): void {
    Object.assign(form, {
      displayName: auth.session?.displayName ?? '',
      email: auth.session?.email ?? '',
      code: '',
    })
    mutation.error.value = ''
    editing.value = section
  }
  async function save(loader: () => Promise<Identity>) {
    let value: Identity | null = null
    if (
      (await mutation.run(async () => {
        value = await loader()
      })) &&
      value
    ) {
      sessionController.updateIdentity(value)
      notice.value = '已保存 / Saved'
      editing.value = null
    }
  }
  async function upload(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0]
    if (!file) return
    if (
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
        file.type,
      ) ||
      file.size > 190 * 1024
    ) {
      mutation.error.value =
        '请选择不超过190KB的PNG/JPEG/WebP/GIF图片 / Choose an image up to 190KB'
      input.value = ''
      return
    }
    const generation = sessionController.generation
    const avatar = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
    if (generation === sessionController.generation)
      await save(() => accountApi.avatar(avatar))
    input.value = ''
  }
  async function sendCode() {
    if (await mutation.run(() => accountApi.emailCode(form.email, 'bind')))
      notice.value =
        '验证码已发送，请一分钟后再试 / Code sent; wait one minute before retrying'
  }
  return {
    editing,
    edit,
    auth,
    mutation,
    config,
    form,
    notice,
    upload,
    sendCode,
    saveName: () => save(() => accountApi.profile(form.displayName.trim())),
    saveEmail: () => save(() => accountApi.email(form.email, form.code)),
    removeAvatar: () => save(accountApi.removeAvatar),
  }
}
