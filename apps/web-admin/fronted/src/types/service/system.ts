/** 服务配置的公开字段；密钥只提交替换值，从不从读取接口回显。 */
export interface OAuthSettings {
  enabled?: boolean
  provider?: string
  label?: string
  clientId?: string
  clientSecret?: string
  clientSecretConfigured?: boolean
  clearClientSecret?: boolean
  authorizeUrl?: string
  tokenUrl?: string
  userInfoUrl?: string
  scopes?: string
  subjectClaim?: string
  emailClaim?: string
  nameClaim?: string
  usernameClaim?: string
}
export interface ServiceSettings {
  registrationOpen: boolean
  oauthRegistrationOpen: boolean
  revision: number
  /** 未配置提供方时读取接口返回 null，不能据此创建或启用配置。 */
  oauth: OAuthSettings | null
  email: {
    enabled?: boolean
    fromAddress?: string
    apiKey?: string
    apiKeyConfigured?: boolean
    clearApiKey?: boolean
  }
}
/** 编辑器拥有独立的非空草稿，是否写入该分区由用户实际提交的弹窗决定。 */
export interface ServiceSettingsDraft extends Omit<ServiceSettings, 'oauth'> {
  oauth: OAuthSettings
}
export interface Announcement {
  enabled: boolean
  markdown: string
  publishedAt: string | null
  revision: number
}
export interface ServiceInformation {
  endpoint: string
  version: string
  database: string
  databasePath: string
  coordination: string
  instanceId: string
  startedAt: string
  uptimeSeconds: number
}
export interface AuditEntry {
  id: string
  actorId: string | null
  actorUsername: string | null
  action: string
  targetId: string
  detail: Record<string, unknown>
  createdAt: string
}
export interface DashboardSettings {
  intensity: { basis: string; lightMax: number; mediumMax: number }
  histogramBins: { messages: number[]; sessions: number[] }
}
export interface HistogramBucket {
  key: string
  label: string
  count: number
  min: number
  max: number | null
}
export interface Breakdown {
  key: string
  label: string
  value: number
  percent: number
}
export interface DashboardOverview {
  summary: Record<string, number>
  series: Array<{ date: string } & Record<string, string | number>>
  messageHistogram: HistogramBucket[]
  sessionHistogram: HistogramBucket[]
  userSegments: Array<{ segment: string; count: number }>
  deviceBreakdown: Breakdown[]
  agentBreakdown: Breakdown[]
  sessionAgentBreakdown: Breakdown[]
  settings: DashboardSettings
}
