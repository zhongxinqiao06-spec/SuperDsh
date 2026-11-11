import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { canonicalPath } from '@/utils/console/routes'
import { consoleModules, visibleNavigation } from '@/utils/console/modules'
import { useDraftStore } from '@/store/modules/draft-store'
import { apiUrl } from '@/utils/api-config'

beforeEach(() => setActivePinia(createPinia()))

describe('路由、菜单和账号草稿', () => {
  it('21个模块保持唯一ID，旧Hash按权限和子路由转换', () => {
    expect(new Set(consoleModules.map((item) => item.id)).size).toBe(21)
    expect(canonicalPath('/settings/archived-sessions')).toBe(
      '/workspace/archived',
    )
    expect(canonicalPath('/session/abc')).toBe('/workspace/session/abc')
    expect(canonicalPath('/management', ['roles.manage'])).toBe('/access/roles')
    expect(canonicalPath('//evil.test')).toBeNull()
    expect(canonicalPath('/overview?redirect=evil')).toBeNull()
  })

  it('菜单隐藏不改变直接访问权限，空分组不会出现', () => {
    const items = [
      {
        id: 'group',
        kind: 'group' as const,
        moduleId: null,
        parentId: null,
        title: '组',
        icon: 'folder',
        order: 0,
        visible: true,
        roleIds: [],
      },
      {
        id: 'users',
        kind: 'page' as const,
        moduleId: 'access.users',
        parentId: 'group',
        title: '用户',
        icon: 'user',
        order: 1,
        visible: false,
        roleIds: [],
      },
    ]
    expect(visibleNavigation(items, ['users.read'], ['member'])).toEqual([])
    expect(canonicalPath('/access/users', ['users.read'])).toBe('/access/users')
  })

  it('同账号切页保留File，换代际清空并撤销所有预览', () => {
    const revoke = vi.fn()
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL() {
          return 'blob:owned'
        }
        static revokeObjectURL = revoke
      },
    )
    const store = useDraftStore()
    store.bind(1)
    const first = store.draft('new')
    first.text = '草稿'
    first.files.push(new File(['data'], 'input.txt'))
    store.preview(first.files[0]!)
    store.bind(1)
    expect(store.draft('new').text).toBe('草稿')
    store.bind(2)
    expect(store.draft('new').text).toBe('')
    expect(store.draft('new').files).toHaveLength(0)
    expect(revoke).toHaveBeenCalledWith('blob:owned')
  })

  it('API客户端只构造同源规范路径并编码查询参数', () => {
    expect(apiUrl('/admin/users', { search: 'a&b', page: 2 })).toBe(
      '/api/admin/users?search=a%26b&page=2',
    )
    expect(() => apiUrl('https://evil.test')).toThrow()
    expect(() => apiUrl('//evil.test')).toThrow()
  })
})
