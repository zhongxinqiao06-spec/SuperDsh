/** 只翻译原始默认名称，自定义名称保持用户配置。 */
export const navigationGroups: Readonly<
  Record<string, readonly [string, string]>
> = {
  'office-workspace': ['办公工作台', 'Office workspace'],
  'studio-workspace': ['创作工作台', 'Creative workspace'],
  capabilities: ['能力管理', 'Capabilities'],
  'product-management': ['产品管理', 'Product management'],
  platform: ['平台管理', 'Platform management'],
  access: ['用户与权限', 'Users and access'],
  'agent-management': ['智能体管理', 'Agent management'],
  'model-management': ['模型管理', 'Model management'],
  system: ['系统管理', 'System management'],
  account: ['个人中心', 'Account'],
}

/** 平台子页沿用旧链接；侧栏只保留一个二级入口，页内切换相关设置。 */
export const consoleTabGroups: ReadonlyArray<
  ReadonlyArray<readonly [string, string, string]>
> = [
  [
    ['access.users', '账号', 'Accounts'],
    ['access.roles', '角色与权限', 'Roles and permissions'],
  ],
  [
    ['models', '聊天配置', 'Chat models'],
    ['models.multimodal', '多模态配置', 'Multimodal models'],
  ],
  [
    ['system.storage', '文件存储', 'File storage'],
    ['system.service', '服务设置', 'Service settings'],
  ],
  [
    ['account.security', '账号安全', 'Account security'],
    ['account.mobile', '手机登录记录', 'Mobile sign-ins'],
  ],
]
