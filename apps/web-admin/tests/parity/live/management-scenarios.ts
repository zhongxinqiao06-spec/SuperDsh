import { observe, redacted, type Observation } from './observations.ts'

interface ManagementResult {
  id: string
  side: string
  observations: unknown
  passed: boolean
}
type Fields = Record<string, unknown>
const fields = (value: unknown): Fields =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Fields)
    : {}
const list = (value: unknown): Fields[] =>
  Array.isArray(value) ? value.map(fields) : []
const revision = (value: Fields): Fields =>
  typeof value.revision === 'number' ? { revision: value.revision } : {}

/** 每侧独立执行相同真实管理流程，保留动态 ID 和原始字段；不撤销调用方管理员会话。 */
export async function managementScenarios(
  side: string,
  base: string,
  token: string,
): Promise<ManagementResult[]> {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
    throw new Error('管理差分只允许本轮本机测试服务')
  const results: ManagementResult[] = []
  const root = '/api/v2'
  const call = (
    path: string,
    method = 'GET',
    body?: unknown,
    authorization = token,
  ) => observe(base, root + path, method, body, authorization)
  const check = (
    id: string,
    response: Observation,
    passed: boolean,
    semantic?: unknown,
  ) => {
    results.push({
      id: `management:${id}`,
      side,
      observations: redacted({ response, semantic }),
      passed,
    })
    return fields(response.body)
  }
  const users: string[] = []
  let roleId = ''
  try {
    const roleResponse = await call('/admin/roles', 'POST', {
      name: '差分测试角色',
      description: '本轮合成数据',
      permissions: ['users.read', 'menus.read', 'sessions.read'],
    })
    const role = check(
      'role-create',
      roleResponse,
      roleResponse.status === 201 &&
        Array.isArray(fields(roleResponse.body).permissions),
    )
    roleId = String(role.id || '')
    if (!roleId) throw new Error('角色创建未返回标识')
    const roleList = await call('/admin/roles')
    check(
      'role-list',
      roleList,
      roleList.status === 200 &&
        list(fields(roleList.body).roles).some((item) => item.id === roleId),
    )
    const edited = await call('/admin/roles/' + roleId, 'PATCH', {
      name: '差分测试角色已编辑',
      description: '更新后的合成描述',
      permissions: ['sessions.read', 'users.read', 'menus.read'],
      ...revision(role),
    })
    check(
      'role-update',
      edited,
      edited.status === 200 &&
        fields(edited.body).name === '差分测试角色已编辑',
    )
    for (const [name, label, email] of [
      ['parity_z_first', '差分成员一', 'parity-first@example.invalid'],
      ['parity_a_second', '差分成员二', 'parity-second@example.invalid'],
    ]) {
      const response = await call('/admin/users', 'POST', {
        username: name,
        displayName: label,
        email,
        password: 'Synthetic-parity-initial-password!',
        roles: [roleId],
      })
      const value = fields(response.body)
      check(
        'user-create-' + name,
        response,
        response.status === 201 &&
          value.resetRequired === true &&
          value.emailVerified === false &&
          typeof value.updatedAt === 'string',
      )
      if (typeof value.userId === 'string') users.push(value.userId)
    }
    if (users.length !== 2) throw new Error('合成账号未创建完整')
    const pageOne = await call(
      '/admin/users?search=' +
        encodeURIComponent(' 差分成员 ') +
        '&pageSize=1&page=1',
    )
    const pageTwo = await call(
      '/admin/users?search=' +
        encodeURIComponent(' 差分成员 ') +
        '&pageSize=1&page=2',
    )
    const firstRows = list(fields(pageOne.body).users),
      secondRows = list(fields(pageTwo.body).users)
    check(
      'users-search-created-order-page-one',
      pageOne,
      pageOne.status === 200 &&
        fields(pageOne.body).total === 2 &&
        firstRows[0]?.username === 'parity_z_first',
    )
    check(
      'users-search-created-order-page-two',
      pageTwo,
      pageTwo.status === 200 &&
        fields(pageTwo.body).total === 2 &&
        secondRows[0]?.username === 'parity_a_second',
    )
    const builtin = await call('/admin/roles/admin', 'DELETE')
    check('builtin-role-delete-protected', builtin, builtin.status === 409)
    const assigned = await call('/admin/roles/' + roleId, 'DELETE')
    check('assigned-role-delete-protected', assigned, assigned.status === 409)
    const firstLogin = await call('/auth/login', 'POST', {
      identifier: 'parity_z_first',
      password: 'Synthetic-parity-initial-password!',
      clientType: 'native',
    })
    const first = check(
      'member-initial-login',
      firstLogin,
      firstLogin.status === 200 &&
        fields(firstLogin.body).resetRequired === true,
    )
    if (typeof first.accessToken !== 'string')
      throw new Error('合成初始账号登录失败')
    const resetGuard = await call(
      '/admin/users',
      'GET',
      undefined,
      first.accessToken,
    )
    check(
      'initial-password-change-required',
      resetGuard,
      resetGuard.status === 403 &&
        fields(resetGuard.body).detail === 'password change required',
    )
    const changedPassword = await call(
      '/auth/change-password',
      'POST',
      { newPassword: 'Synthetic-parity-final-password!' },
      first.accessToken,
    )
    check(
      'member-change-password',
      changedPassword,
      changedPassword.status === 204,
    )
    const revokedFirst = await call(
      '/auth/me',
      'GET',
      undefined,
      first.accessToken,
    )
    check(
      'password-change-revokes-old-access',
      revokedFirst,
      revokedFirst.status === 401,
    )
    const freshLogin = await call('/auth/login', 'POST', {
      identifier: 'parity_z_first',
      password: 'Synthetic-parity-final-password!',
      clientType: 'native',
    })
    const fresh = check(
      'member-relogin',
      freshLogin,
      freshLogin.status === 200 &&
        fields(freshLogin.body).resetRequired === false,
    )
    if (typeof fresh.accessToken !== 'string')
      throw new Error('改密后重新登录失败')
    const read = await call('/admin/users', 'GET', undefined, fresh.accessToken)
    check('delegated-user-read', read, read.status === 200)
    const forbidden = await call(
      '/admin/roles',
      'POST',
      { name: '禁止提权', permissions: ['roles.manage'] },
      fresh.accessToken,
    )
    check(
      'delegated-user-cannot-create-role',
      forbidden,
      forbidden.status === 403,
    )
    const navigation = await call(
      '/navigation',
      'GET',
      undefined,
      fresh.accessToken,
    )
    const visible = list(fields(navigation.body).items).map((item) => item.id)
    check(
      'read-only-menu-authority',
      navigation,
      navigation.status === 200 &&
        visible.includes('access.users') &&
        visible.includes('access.menus'),
      { visible },
    )
    const disabled = await call('/admin/users/' + users[0], 'PATCH', {
      disabled: true,
      ...revision(fresh),
    })
    check(
      'member-disable',
      disabled,
      disabled.status === 200 && fields(disabled.body).disabled === true,
    )
    const revoked = await call('/auth/me', 'GET', undefined, fresh.accessToken)
    check('disable-revokes-access', revoked, revoked.status === 401)
    const removed = await call('/admin/users/' + users[0], 'DELETE')
    check('member-soft-delete', removed, removed.status === 204)
    const enableDeleted = await call('/admin/users/' + users[0], 'PATCH', {
      disabled: false,
    })
    check(
      'deleted-member-cannot-enable-directly',
      enableDeleted,
      enableDeleted.status === 409,
    )
    const restored = await call(
      '/admin/users/' + users[0] + '/restore',
      'POST',
      {},
    )
    check(
      'member-restore',
      restored,
      restored.status === 200 && fields(restored.body).deletedAt === null,
    )
  } catch (error) {
    results.push({
      id: 'management:user-role-flow',
      side,
      observations: {
        error: error instanceof Error ? error.message : String(error),
      },
      passed: false,
    })
  } finally {
    // 只清理由本流程实际返回的合成 ID；旧数据库仍保留软删除记录供根级隔离库清理。
    for (const id of users) {
      const unassigned = await call('/admin/users/' + id, 'PATCH', {
        roles: ['member'],
      })
      check('cleanup-member-role-' + id, unassigned, unassigned.status === 200)
      const removed = await call('/admin/users/' + id, 'DELETE')
      check('cleanup-member-' + id, removed, removed.status === 204)
    }
    if (roleId) {
      const removed = await call('/admin/roles/' + roleId, 'DELETE')
      check('role-delete-after-unassigning', removed, removed.status === 204)
    }
  }

  const syntheticKey = 'synthetic-parity-provider-key-only'
  const providerBody = {
    name: '差分供应商',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/api',
    apiKey: syntheticKey,
    enabled: true,
    models: [
      {
        modelId: 'synthetic-parity-chat',
        name: '差分聊天模型',
        maxTokens: 1024,
        contextWindow: 32000,
        inputTypes: ['text', 'image'],
      },
    ],
  }
  let providerId = ''
  try {
    const created = await call('/admin/models/providers', 'POST', providerBody)
    const provider = check(
      'provider-create-secret-redacted',
      created,
      created.status === 200 &&
        fields(created.body).apiKeyConfigured === true &&
        !JSON.stringify(created.body).includes(syntheticKey),
    )
    providerId = String(provider.providerId || '')
    if (!providerId) throw new Error('供应商创建未返回标识')
    const selection = {
      selection: { providerId, modelId: 'synthetic-parity-chat' },
    }
    const selected = await call('/admin/models/default', 'PUT', selection)
    check(
      'provider-default-select',
      selected,
      selected.status === 200 &&
        fields(fields(selected.body).selection).providerId === providerId,
    )
    const blocked = await call(
      '/admin/models/providers/' + providerId,
      'PATCH',
      { ...providerBody, enabled: false },
    )
    check(
      'selected-provider-disable-protected',
      blocked,
      blocked.status === 422,
    )
    const preserved = await call(
      '/admin/models/providers/' + providerId,
      'PATCH',
      { ...providerBody, apiKey: '', name: '差分供应商已编辑' },
    )
    check(
      'provider-empty-key-preserved',
      preserved,
      preserved.status === 200 &&
        fields(preserved.body).apiKeyConfigured === true &&
        !JSON.stringify(preserved.body).includes(syntheticKey),
    )
    const cleared = await call(
      '/admin/models/providers/' + providerId,
      'PATCH',
      { ...providerBody, apiKey: '', clearApiKey: true },
    )
    check(
      'provider-key-explicitly-cleared',
      cleared,
      cleared.status === 200 && fields(cleared.body).apiKeyConfigured === false,
    )
    const listed = await call('/admin/models/providers')
    check(
      'provider-list-redacted',
      listed,
      listed.status === 200 &&
        list(fields(listed.body).providers).some(
          (value) => value.providerId === providerId,
        ) &&
        !JSON.stringify(listed.body).includes(syntheticKey),
    )
  } catch (error) {
    results.push({
      id: 'management:provider-flow',
      side,
      observations: {
        error: error instanceof Error ? error.message : String(error),
      },
      passed: false,
    })
  } finally {
    if (providerId) {
      const removed = await call(
        '/admin/models/providers/' + providerId,
        'DELETE',
      )
      check('provider-delete', removed, removed.status === 200)
      const clearedDefault = await call('/admin/models/default')
      check(
        'provider-delete-clears-default',
        clearedDefault,
        clearedDefault.status === 200 &&
          fields(clearedDefault.body).selection === null,
      )
    }
  }

  try {
    const connectionBody = {
      name: '差分能力连接',
      adapter: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/api',
      apiKey: syntheticKey,
      enabled: true,
    }
    const createdConnection = await call(
      '/admin/models/connections',
      'POST',
      connectionBody,
    )
    const connection = check(
      'connection-create-redacted',
      createdConnection,
      createdConnection.status === 200 &&
        fields(createdConnection.body).credentialConfigured === true &&
        !JSON.stringify(createdConnection.body).includes(syntheticKey),
    )
    if (typeof connection.id !== 'string')
      throw new Error('能力连接创建未返回标识')
    const configurationBody = {
      name: '差分图像能力',
      connectionId: connection.id,
      capability: 'image.generate',
      modelId: 'synthetic-parity-image',
      parameters: { size: '1024x1024' },
      roleIds: [],
      enabled: true,
    }
    const createdConfiguration = await call(
      '/admin/models/configurations',
      'POST',
      configurationBody,
    )
    const configuration = check(
      'configuration-create',
      createdConfiguration,
      createdConfiguration.status === 200 &&
        fields(createdConfiguration.body).revision === 1,
    )
    if (typeof configuration.id !== 'string')
      throw new Error('能力配置创建未返回标识')
    const updated = await call(
      '/admin/models/configurations/' + configuration.id,
      'PATCH',
      { ...configurationBody, name: '差分图像能力已编辑', revision: 1 },
    )
    check(
      'configuration-update-cas',
      updated,
      updated.status === 200 && fields(updated.body).revision === 2,
    )
    const stale = await call(
      '/admin/models/configurations/' + configuration.id,
      'PATCH',
      { ...configurationBody, revision: 1 },
    )
    check('configuration-stale-revision-rejected', stale, stale.status === 409)
    const addressChange = await call(
      '/admin/models/connections/' + connection.id,
      'PATCH',
      {
        ...connectionBody,
        baseUrl: 'http://127.0.0.1:2/api',
        ...revision(connection),
      },
    )
    check(
      'referenced-connection-address-protected',
      addressChange,
      addressChange.status === 409,
    )
    const connectionEdited = await call(
      '/admin/models/connections/' + connection.id,
      'PATCH',
      {
        ...connectionBody,
        name: '差分能力连接已编辑',
        ...revision(connection),
      },
    )
    check(
      'connection-update-cas',
      connectionEdited,
      connectionEdited.status === 200 &&
        fields(connectionEdited.body).revision === 2,
    )
    const connectionStale = await call(
      '/admin/models/connections/' + connection.id,
      'PATCH',
      { ...connectionBody, ...revision(connection) },
    )
    check(
      'connection-stale-revision-rejected',
      connectionStale,
      connectionStale.status === 409,
    )
    const listed = await call('/admin/models/configurations')
    const currentDefaults = list(fields(listed.body).defaults)
    const oldDefault = currentDefaults.find(
      (item) => item.capability === 'image.generate',
    )
    check(
      'configurations-connections-defaults-list',
      listed,
      listed.status === 200 &&
        list(fields(listed.body).configurations).some(
          (item) => item.id === configuration.id && item.revision === 2,
        ) &&
        list(fields(listed.body).connections).some(
          (item) => item.id === connection.id,
        ),
    )
    const selected = await call(
      '/admin/models/defaults/image.generate',
      'PUT',
      {
        configurationId: configuration.id,
        revision: oldDefault?.revision ?? 0,
      },
    )
    const defaultItem = list(fields(selected.body).defaults).find(
      (item) => item.capability === 'image.generate',
    )
    check(
      'capability-default-select',
      selected,
      selected.status === 200 &&
        defaultItem?.configurationId === configuration.id,
    )
    const defaultStale = await call(
      '/admin/models/defaults/image.generate',
      'PUT',
      { configurationId: null, revision: oldDefault?.revision ?? 0 },
    )
    check(
      'capability-default-stale-revision-rejected',
      defaultStale,
      defaultStale.status === 409,
    )
    const defaultCleared = await call(
      '/admin/models/defaults/image.generate',
      'PUT',
      { configurationId: null, revision: defaultItem?.revision },
    )
    check(
      'capability-default-clear',
      defaultCleared,
      defaultCleared.status === 200 &&
        list(fields(defaultCleared.body).defaults).find(
          (item) => item.capability === 'image.generate',
        )?.configurationId === null,
    )
    const invalidRole = await call('/admin/models/configurations', 'POST', {
      ...configurationBody,
      roleIds: ['synthetic-missing-role'],
    })
    check(
      'configuration-unknown-role-rejected',
      invalidRole,
      invalidRole.status === 422,
    )
    const invalidParameter = await call(
      '/admin/models/configurations',
      'POST',
      { ...configurationBody, parameters: { size: 'invalid-size' } },
    )
    check(
      'configuration-invalid-parameter-rejected',
      invalidParameter,
      invalidParameter.status === 422,
    )
    const disabled = await call(
      '/admin/models/configurations/' + configuration.id,
      'PATCH',
      { ...configurationBody, enabled: false, revision: 2 },
    )
    check(
      'configuration-disabled',
      disabled,
      disabled.status === 200 && fields(disabled.body).enabled === false,
    )
    // 两侧没有配置/连接 DELETE 契约；记录真实 404，不能伪造删除功能。
    const unsupportedDelete = await call(
      '/admin/models/configurations/' + configuration.id,
      'DELETE',
    )
    check(
      'configuration-delete-not-registered',
      unsupportedDelete,
      unsupportedDelete.status === 404,
    )
  } catch (error) {
    results.push({
      id: 'management:configuration-flow',
      side,
      observations: {
        error: error instanceof Error ? error.message : String(error),
      },
      passed: false,
    })
  }
  return results
}
