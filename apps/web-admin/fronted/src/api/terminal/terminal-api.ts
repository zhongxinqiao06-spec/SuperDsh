import { request } from '@/utils/request'

/** 终端身份与进程生命周期由服务端管理，视图关闭不会发送删除。 */
export interface ManagedTerminal {
  id: string
  name: string
  status: string
  cols: number
  rows: number
  persistence: boolean
  sequence: number
}
export const terminalApi = {
  list: (connector: string) =>
    request<{ terminals: ManagedTerminal[] }>(
      `/connectors/${encodeURIComponent(connector)}/terminals`,
    ),
  create: (connector: string, root?: string) =>
    request<{ terminal: ManagedTerminal }>(
      `/connectors/${encodeURIComponent(connector)}/terminals`,
      { method: 'POST', body: root ? { root } : {} },
    ),
  close: (connector: string, terminal: string) =>
    request(
      `/connectors/${encodeURIComponent(connector)}/terminals/${encodeURIComponent(terminal)}`,
      { method: 'DELETE' },
    ),
  rename: (connector: string, terminal: string, name: string) =>
    request(
      `/connectors/${encodeURIComponent(connector)}/terminals/${encodeURIComponent(terminal)}`,
      { method: 'PATCH', body: { name } },
    ),
  persistence: (connector: string, terminal: string, persistence: boolean) =>
    request(
      `/connectors/${encodeURIComponent(connector)}/terminals/${encodeURIComponent(terminal)}/persistence`,
      { method: 'PATCH', body: { persistence } },
    ),
  resize: (connector: string, terminal: string, cols: number, rows: number) =>
    request(
      `/connectors/${encodeURIComponent(connector)}/terminals/${encodeURIComponent(terminal)}/resize`,
      { method: 'POST', body: { cols, rows } },
    ),
  snapshot: (connector: string, terminal: string) =>
    request<{ data: string; sequence: number; terminal: ManagedTerminal }>(
      `/connectors/${encodeURIComponent(connector)}/terminals/${encodeURIComponent(terminal)}/snapshot`,
    ),
}
