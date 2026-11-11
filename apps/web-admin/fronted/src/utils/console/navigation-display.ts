/** 只翻译原始默认名称，自定义名称保持用户配置。 */
export const navigationGroups: Readonly<
  Record<string, readonly [string, string]>
> = {
  access: ['用户与权限', 'Users and access'],
  'agent-management': ['智能体管理', 'Agent management'],
  'model-management': ['模型管理', 'Model management'],
  system: ['系统管理', 'System management'],
  account: ['个人中心', 'Account'],
}
