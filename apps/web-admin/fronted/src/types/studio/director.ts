/** 编排入口只准备导演任务，用户明确发送后才进入已有 DSH 会话。 */
export type DirectorAction = 'draft' | 'decompose'

export interface DirectorRequest {
  action: DirectorAction
  brief: string
  script: string
  mode: 'original' | 'adapt'
}
