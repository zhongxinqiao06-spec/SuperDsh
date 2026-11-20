import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { canonicalPath, consoleContinuation } from '@/utils/console/routes'
import { homeFirst } from '@/utils/console/navigation-display'
import type { MenuNode } from '@/types/console/navigation'
import {
  canOpenModule,
  consoleModules,
  visibleNavigation,
} from '@/utils/console/modules'
import { useDraftStore } from '@/store/modules/draft-store'
import { apiUrl } from '@/utils/api-config'

beforeEach(() => setActivePinia(createPinia()))

describe('路由、菜单和账号草稿', () => {
  it('办公模块保留，娱乐模块共用注册目录，旧Hash按权限和子路由转换', () => {
    expect(consoleModules.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'workbench',
        'office.history',
        'office.devices',
        'product.members',
        'product.defaults',
        'platform.extensions',
      ]),
    )
    expect(
      consoleModules
        .filter((item) => item.product === 'entertainment')
        .map((item) => item.id),
    ).toEqual([
      'studio.deliveries',
      'studio.environments',
      'studio.props',
      'studio.characters',
      'studio.create',
      'studio.projects',
      'studio.library',
      'studio.tasks',
    ])
    expect(new Set(consoleModules.map((item) => item.id)).size).toBe(
      consoleModules.length,
    )
    expect(canonicalPath('/settings/archived-sessions')).toBe(
      '/workspace/archived',
    )
    expect(canonicalPath('/session/abc')).toBe('/workspace/session/abc')
    expect(canonicalPath('/management', ['roles.manage'])).toBe('/access/roles')
    expect(canonicalPath('//evil.test')).toBeNull()
    expect(canonicalPath('/overview?redirect=evil')).toBeNull()
  })

  it('同一账号的办公管理授权不能打开娱乐产品管理页', () => {
    const modules = consoleModules.filter((item) => item.productAction)
    const grants = [
      'products.office',
      'products.entertainment',
      'products.office.members.manage',
      'products.office.menus.manage',
      'products.office.resources.manage',
      'products.office.models.manage',
    ]
    expect(modules.every((item) => canOpenModule(item, grants, 'office'))).toBe(
      true,
    )
    expect(
      modules.some((item) => canOpenModule(item, grants, 'entertainment')),
    ).toBe(false)
    expect(
      canOpenModule(
        consoleModules.find((item) => item.id === 'models')!,
        grants,
        'office',
      ),
    ).toBe(false)
  })

  it('登录续接保留作品阶段和公共页面的产品上下文，仅接收登记的站内页面', () => {
    expect(consoleContinuation('/entertainment/work-id?section=timeline')).toBe(
      '/entertainment/work-id?section=timeline',
    )
    for (const path of [
      '/entertainment/storyboard/new',
      '/entertainment/quick/new',
      '/entertainment/series/new',
      '/entertainment/quick/record',
      '/entertainment/series/record?section=episodes',
    ])
      expect(consoleContinuation(path)).toBe(path)
    expect(consoleContinuation('/settings?product=entertainment')).toBe(
      '/account/profile?product=entertainment',
    )
    expect(consoleContinuation('//example.org?section=jobs')).toBeNull()
    expect(consoleContinuation('/missing?product=office')).toBeNull()
    expect(
      consoleContinuation('/preview?connectorId=pc&path=a.txt&line=3'),
    ).toBe('/preview?connectorId=pc&path=a.txt&line=3')
    for (const secret of ['token', 'previewToken', 'sourceUrl']) {
      expect(
        consoleContinuation(
          '/preview?connectorId=pc&path=a.txt&' + secret + '=opaque',
        ),
      ).toBeNull()
    }
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
    expect(visibleNavigation(items, ['users.read'], ['admin'])).toEqual(items)
    expect(canonicalPath('/access/users', ['users.read'])).toBe('/access/users')
  })

  it('旧分组先过滤角色，再把允许访问的首页提升到首项', () => {
    const group: MenuNode = {
      id: 'studio-workspace',
      kind: 'group',
      moduleId: null,
      parentId: null,
      title: '创作工作台',
      icon: 'folder',
      order: 0,
      visible: true,
      roleIds: ['entertainment_creator'],
    }
    const home: MenuNode = {
      ...group,
      id: 'studio.create',
      kind: 'page',
      moduleId: 'studio.create',
      parentId: group.id,
      title: '创作中心',
      icon: 'sparkles',
      roleIds: [],
    }
    const permissions = ['products.entertainment', 'studio.projects.read']
    const display = (role: string) =>
      homeFirst(
        visibleNavigation([group, home], permissions, [role], 'entertainment'),
      )
    expect(display('member')).toEqual([])
    expect(display('entertainment_creator')).toEqual([
      { ...home, parentId: null, title: '首页', icon: 'house' },
    ])
    expect(home.parentId).toBe(group.id)
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
