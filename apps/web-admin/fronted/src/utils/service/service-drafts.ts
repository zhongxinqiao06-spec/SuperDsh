import type {
  ServiceSettings,
  ServiceSettingsDraft,
} from '@/types/service/system'

/** 未配置 OAuth 时使用旧编辑器的禁用草稿；复制后的默认值不写回读取结果。 */
export function serviceSettingsDraft(
  value: ServiceSettings,
): ServiceSettingsDraft {
  const source = structuredClone(value)
  return {
    ...source,
    oauth: {
      enabled: false,
      provider: 'oidc',
      label: 'OAuth',
      authorizeUrl: '',
      tokenUrl: '',
      userInfoUrl: '',
      clientId: '',
      scopes: 'openid profile email',
      usernameClaim: 'preferred_username',
      subjectClaim: 'sub',
      emailClaim: 'email',
      nameClaim: 'name',
      ...source.oauth,
      clientSecret: '',
      clearClientSecret: false,
    },
  }
}
