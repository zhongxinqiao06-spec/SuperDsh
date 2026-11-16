import { request, type RequestOptions } from '@/utils/request'
import type { Product } from '@/types/console/navigation'

/** 在页面创建时固定产品。即使异步表单跨越切换，新请求仍指向原来的产品。 */
export function productRequest(product: Product) {
  return <T>(path: string, options: RequestOptions = {}) =>
    request<T>(path, { ...options, query: { ...options.query, product } })
}
