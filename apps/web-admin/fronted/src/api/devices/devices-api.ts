import { request } from '@/utils/request'
import type {
  Device,
  DeviceDraft,
  DeviceInventory,
  DeviceRuntime,
  RuntimeDraft,
  RuntimeType,
} from '@/types/devices/devices'
const devicePath = (id: string) => `/connectors/${encodeURIComponent(id)}`
const runtimePath = (id: string, runtime: string) =>
  `${devicePath(id)}/runtimes/${encodeURIComponent(runtime)}`

/** 运维与本人设备使用不同入口，运维权限不能代替本人访问授权。 */
export const devicesApi = {
  inventory: (
    page: number,
    pageSize: number,
    search: string,
    signal?: AbortSignal,
  ) =>
    request<DeviceInventory>('/admin/devices', {
      query: { page, pageSize, search },
      signal,
    }),
  block: (id: string, reason: string) =>
    request(`/admin/devices/${encodeURIComponent(id)}/block`, {
      method: 'POST',
      body: { reason },
    }),
  resume: (id: string) =>
    request(`/admin/devices/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    }),
  list: (signal?: AbortSignal) =>
    request<{ connectors: Device[] }>('/connectors', { signal }),
  create: (body: DeviceDraft) =>
    request<{ connector: Device; connectorToken: string }>('/connectors', {
      method: 'POST',
      body,
    }),
  rename: (id: string, name: string) =>
    request(`${devicePath(id)}`, { method: 'PATCH', body: { name } }),
  revoke: (id: string) =>
    request<{ connectorToken: string; tokenPrefix: string }>(
      `${devicePath(id)}/revoke`,
      { method: 'POST' },
    ),
  remove: (id: string) => request<void>(devicePath(id), { method: 'DELETE' }),
  pair: (body: DeviceDraft & { code: string }) =>
    request<{ connector: Device; status: string }>('/pairing/claim', {
      method: 'POST',
      body,
    }),
  runtimes: (id: string, signal?: AbortSignal) =>
    request<{ runtimes: DeviceRuntime[] }>(`${devicePath(id)}/runtimes`, {
      signal,
    }),
  types: (id: string, signal?: AbortSignal) =>
    request<{ runtimeTypes: RuntimeType[] }>(
      `${devicePath(id)}/runtime-types`,
      { signal },
    ),
  discover: (id: string) =>
    request(`${devicePath(id)}/runtime-types/discover`, {
      method: 'POST',
      timeoutMs: 60_000,
    }),
  createRuntime: (id: string, body: RuntimeDraft) =>
    request<DeviceRuntime>(`${devicePath(id)}/runtimes`, {
      method: 'POST',
      body,
      timeoutMs: 60_000,
    }),
  config: (
    id: string,
    runtime: DeviceRuntime,
    config: Record<string, unknown>,
  ) =>
    request<DeviceRuntime>(`${runtimePath(id, runtime.runtimeId)}/config`, {
      method: 'PUT',
      body: { config, revision: runtime.revision },
      timeoutMs: 60_000,
    }),
  clearConfig: (id: string, runtime: DeviceRuntime) =>
    request<DeviceRuntime>(`${runtimePath(id, runtime.runtimeId)}/config`, {
      method: 'DELETE',
      timeoutMs: 60_000,
    }),
  active: (id: string, runtime: DeviceRuntime) =>
    request<DeviceRuntime>(`${runtimePath(id, runtime.runtimeId)}/active`, {
      method: 'PUT',
      body: { active: !runtime.active, revision: runtime.revision },
      timeoutMs: 60_000,
    }),
  renameRuntime: (id: string, runtime: DeviceRuntime, name: string) =>
    request<DeviceRuntime>(runtimePath(id, runtime.runtimeId), {
      method: 'PATCH',
      body: { name, revision: runtime.revision },
    }),
}
