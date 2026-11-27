import { request } from '@/utils/request'
import type { CardType, CardTypeInput } from '@/types/billing/membership'

/** 新建时复用客户端卡种标识，编辑时以读取到的修订防止覆盖其他管理员的更改。 */
export const cardTypesApi = {
  list: (signal: AbortSignal) =>
    request<{ items: CardType[] }>('/admin/billing/card-types', { signal }),
  save: (id: string, body: CardTypeInput) =>
    request<CardType>('/admin/billing/card-types/' + encodeURIComponent(id), {
      method: body.revision === 0 ? 'POST' : 'PUT',
      body,
    }),
}
