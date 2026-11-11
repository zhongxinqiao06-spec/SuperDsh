import { onMounted, onScopeDispose, ref, watch, type Ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ElMessageBox } from 'element-plus'
import { terminalApi, type ManagedTerminal } from '@/api/terminal/terminal-api'
import { apiUrl } from '@/utils/api-config'
import { sessionController } from '@/store/session-controller'
import { useTerminalStore } from '@/store/modules/terminal-store'
import { errorMessage } from '@/utils/errors'
import { objectValue } from '@/utils/workbench/timeline'

/** xterm 只持有展示连接；关闭页面清理监听器，明确关闭终端才终止进程。 */
export function useTerminal(
  connector: Ref<string>,
  host: Ref<HTMLElement | null>,
  root: Ref<string | undefined> = ref(),
) {
  const tabs = useTerminalStore()
  tabs.bind(sessionController.generation)
  const terminals = ref<ManagedTerminal[]>([]),
    selected = ref(''),
    error = ref(''),
    connected = ref(false),
    busy = ref(false)
  let terminal: Terminal | null = null,
    fit: FitAddon | null = null,
    socket: WebSocket | null = null
  let resize: ResizeObserver | null = null,
    timer: ReturnType<typeof setTimeout> | null = null,
    generation = 0,
    closed = false
  async function run(action: () => Promise<void>): Promise<void> {
    error.value = ''
    busy.value = true
    try {
      await action()
    } catch (cause) {
      if (!closed) error.value = errorMessage(cause)
    } finally {
      busy.value = false
    }
  }
  function disconnect(): void {
    generation++
    connected.value = false
    if (timer) clearTimeout(timer)
    timer = null
    if (socket) {
      socket.onclose = null
      socket.close()
      socket = null
    }
  }
  async function reload(): Promise<void> {
    const device = connector.value,
      identity = sessionController.generation
    const result = await terminalApi.list(device)
    if (
      device === connector.value &&
      identity === sessionController.generation &&
      !closed
    )
      terminals.value = result.terminals
  }
  async function restore(): Promise<void> {
    const device = connector.value,
      identity = sessionController.generation
    await reload()
    if (
      device !== connector.value ||
      identity !== sessionController.generation ||
      closed
    )
      return
    const id = tabs.restore(
      device,
      terminals.value.map((item) => item.id),
    )
    if (id) await attach(id)
  }
  async function attach(id: string): Promise<void> {
    disconnect()
    selected.value = id
    tabs.select(connector.value, id)
    const current = generation,
      device = connector.value,
      identity = sessionController.generation
    await run(async () => {
      const snapshot = await terminalApi.snapshot(device, id)
      if (
        current !== generation ||
        identity !== sessionController.generation ||
        closed
      )
        return
      terminal?.reset()
      terminal?.write(snapshot.data)
      const url = new URL(
        apiUrl(
          `/connectors/${encodeURIComponent(device)}/terminals/${encodeURIComponent(id)}/stream`,
          {
            token: sessionController.current?.accessToken,
            afterSeq: snapshot.sequence,
          },
        ),
        location.origin,
      )
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const stream = new WebSocket(url)
      socket = stream
      stream.onopen = () => {
        if (current !== generation) {
          stream.close()
          return
        }
        connected.value = true
        fit?.fit()
        terminal?.focus()
      }
      stream.onmessage = (message: MessageEvent<string>) => {
        if (current !== generation) return
        try {
          const value = objectValue(JSON.parse(message.data))
          if (value.reset === true) terminal?.reset()
          if (typeof value.data === 'string')
            terminal?.write(
              Uint8Array.from(atob(value.data), (character) =>
                character.charCodeAt(0),
              ),
            )
        } catch {
          stream.close()
        }
      }
      stream.onclose = () => {
        connected.value = false
        if (!closed && current === generation)
          timer = setTimeout(() => {
            void attach(id)
          }, 1500)
      }
      stream.onerror = () => stream.close()
    })
  }
  async function create(): Promise<void> {
    const device = connector.value,
      current = generation,
      identity = sessionController.generation
    await run(async () => {
      const value = await terminalApi.create(device, root.value)
      if (
        device !== connector.value ||
        current !== generation ||
        identity !== sessionController.generation ||
        closed
      )
        return
      await reload()
      await attach(value.terminal.id)
    })
  }
  async function closeTerminal(id: string): Promise<void> {
    const device = connector.value,
      current = generation,
      identity = sessionController.generation
    await run(async () => {
      await ElMessageBox.confirm(
        '关闭将结束这个终端中的进程，是否继续？',
        '关闭终端',
        { type: 'warning' },
      )
      if (
        device !== connector.value ||
        current !== generation ||
        identity !== sessionController.generation ||
        closed
      )
        return
      await terminalApi.close(device, id)
      if (
        device !== connector.value ||
        identity !== sessionController.generation ||
        closed
      )
        return
      tabs.forget(device, id)
      if (selected.value === id) {
        disconnect()
        selected.value = ''
        terminal?.reset()
      }
      await reload()
    })
  }
  async function rename(id: string): Promise<void> {
    const device = connector.value,
      identity = sessionController.generation
    await run(async () => {
      const value = await ElMessageBox.prompt('终端名称', '重命名终端', {
        inputValue: terminals.value.find((item) => item.id === id)?.name,
      })
      if (
        device !== connector.value ||
        identity !== sessionController.generation ||
        closed
      )
        return
      await terminalApi.rename(device, id, value.value)
      await reload()
    })
  }
  async function persistence(id: string, value: boolean): Promise<void> {
    const device = connector.value,
      identity = sessionController.generation
    await run(async () => {
      await terminalApi.persistence(device, id, value)
      if (
        device !== connector.value ||
        identity !== sessionController.generation ||
        closed
      )
        return
      await reload()
    })
  }
  onMounted(() => {
    if (!host.value) return
    terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, monospace',
      fontSize: 13,
      scrollback: 10000,
      allowProposedApi: false,
    })
    fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.value)
    fit.fit()
    terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: 'input',
            data: btoa(
              Array.from(new TextEncoder().encode(data), (byte) =>
                String.fromCharCode(byte),
              ).join(''),
            ),
          }),
        )
    })
    terminal.onResize(({ cols, rows }) => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    })
    resize = new ResizeObserver(() => {
      if (host.value?.clientWidth) fit?.fit()
    })
    resize.observe(host.value)
    void run(restore)
  })
  watch(connector, () => {
    disconnect()
    selected.value = ''
    terminal?.reset()
    terminals.value = []
    void run(restore)
  })
  const unsubscribe = sessionController.subscribe(() => {
    if (tabs.generation === sessionController.generation) return
    tabs.bind(sessionController.generation)
    disconnect()
    terminals.value = []
    selected.value = ''
    terminal?.reset()
  })
  onScopeDispose(() => {
    closed = true
    disconnect()
    resize?.disconnect()
    terminal?.dispose()
    unsubscribe()
  })
  return {
    terminals,
    selected,
    error,
    connected,
    busy,
    attach,
    create,
    closeTerminal,
    rename,
    persistence,
    reload: () => run(reload),
  }
}
