import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { authApi } from '@/api/auth/auth-api'
import { useAuthStore } from '@/store/modules/auth-store'
import { useMutation } from '@/composables/use-mutation'
import { allowedNativeRedirect } from '@/utils/auth/native-oauth'

/** 授权页只签发一次授权码；授权前显式展示账号并允许取消或换号。 */
export function useNativeOAuth() {
  const route = useRoute(),
    auth = useAuthStore(),
    mutation = useMutation()
  const query = computed(() => ({
    client_id: String(route.query.client_id ?? ''),
    redirect_uri: String(route.query.redirect_uri ?? ''),
    code_challenge: String(route.query.code_challenge ?? ''),
    code_challenge_method: String(route.query.code_challenge_method ?? 'S256'),
    response_type: String(route.query.response_type ?? 'code'),
    state: String(route.query.state ?? ''),
    scope: String(route.query.scope ?? ''),
  }))
  const valid = computed(
    () =>
      allowedNativeRedirect(query.value.client_id, query.value.redirect_uri) &&
      /^[A-Za-z0-9_-]{43}$/u.test(query.value.code_challenge) &&
      query.value.code_challenge_method === 'S256',
  )
  async function authorize() {
    if (valid.value)
      await mutation.run(async () => {
        const result = await authApi.authorize(query.value)
        location.assign(result.redirectUrl)
      })
  }
  function cancel() {
    if (valid.value) {
      const target = new URL(query.value.redirect_uri)
      target.searchParams.set('error', 'access_denied')
      target.searchParams.set('state', query.value.state)
      location.assign(target.href)
    }
  }
  async function switchAccount() {
    await auth.signOut()
  }
  onMounted(() => void auth.hydrate())
  return {
    auth,
    mutation,
    query,
    valid,
    authorize,
    cancel,
    switchAccount,
    route,
  }
}
