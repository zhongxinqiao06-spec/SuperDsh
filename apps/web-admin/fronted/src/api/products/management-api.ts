import { request } from '@/utils/request'
import type { Product } from '@/types/console/navigation'
import type { Capability } from '@/types/models/models'
import type {
  MemberPage,
  ProductMember,
  ProductDefaults,
} from '@/types/products/management'

/** 产品成员和模型默认值的写入路径显式带范围，切换产品后不复用旧请求。 */
export const productManagementApi = {
  members: (
    product: Product,
    page: number,
    pageSize: number,
    search: string,
    signal: AbortSignal,
  ) =>
    request<MemberPage>('/products/' + product + '/members', {
      query: { page, pageSize, search },
      signal,
    }),
  grant: (product: Product, identifier: string) =>
    request<ProductMember>('/products/' + product + '/members', {
      method: 'POST',
      body: { identifier },
    }),
  revoke: (product: Product, member: ProductMember) =>
    request<void>(
      '/products/' + product + '/members/' + encodeURIComponent(member.userId),
      { method: 'DELETE', query: { revision: member.revision } },
    ),
  defaults: (product: Product, signal: AbortSignal) =>
    request<ProductDefaults>('/admin/products/' + product + '/model-defaults', {
      signal,
    }),
  setDefault: (
    product: Product,
    capability: Capability,
    configurationId: string | null,
  ) =>
    request(
      '/admin/products/' +
        product +
        '/model-defaults/' +
        encodeURIComponent(capability),
      { method: 'PUT', body: { configurationId } },
    ),
}
