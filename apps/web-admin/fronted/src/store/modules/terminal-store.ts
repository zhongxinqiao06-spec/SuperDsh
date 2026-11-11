import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

/** 终端面板只记住当前账号各设备所选标签，不持有连接或创建进程。 */
export const useTerminalStore = defineStore('terminal-tabs', () => {
  const generation = ref(-1)
  const selections = reactive(new Map<string, string>())
  function bind(next: number): void {
    if (generation.value === next) return
    selections.clear()
    generation.value = next
  }
  function select(connector: string, terminal: string): void {
    selections.set(connector, terminal)
  }
  function forget(connector: string, terminal: string): void {
    if (selections.get(connector) === terminal) selections.delete(connector)
  }
  function restore(connector: string, available: string[]): string {
    const previous = selections.get(connector)
    return previous && available.includes(previous)
      ? previous
      : (available[0] ?? '')
  }
  return { generation, bind, select, forget, restore }
})
