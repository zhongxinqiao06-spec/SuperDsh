import { NATIVE_ACCESS_HEADER } from '@superdsh/core/contracts/desktop-contract'
/** Exchange the private launch URL for a Host-issued cookie; credentials stay out of renderer state. */
export async function authenticateWebHost(
  url: string,
  nativeToken?: string,
): Promise<string> {
  const response = await fetch(url, {
    redirect: 'manual',
    ...(nativeToken
      ? { headers: { [NATIVE_ACCESS_HEADER]: nativeToken } }
      : {}),
  })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null)
    throw new Error('Desktop Host authentication failed')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}
