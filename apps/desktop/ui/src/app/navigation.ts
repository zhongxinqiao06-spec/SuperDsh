/** Product-owned navigation; Harness layout is an adapter, never the router owner. */
export type ProductPanelId = string | null
interface NavigationTarget {
  hasPanel(id: string): boolean
  selectPanel(id: ProductPanelId): void
}
export class ProductNavigation {
  private panel: ProductPanelId = null
  private target: NavigationTarget | undefined
  private readonly listeners = new Set<() => void>()
  private navigation = new AbortController()

  getSnapshot = (): ProductPanelId => this.panel
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  connect(target: NavigationTarget): () => void {
    if (this.target)
      throw new Error('Product navigation already has a layout adapter')
    this.target = target
    if (this.panel !== null && !target.hasPanel(this.panel)) this.publish(null)
    target.selectPanel(this.panel)
    return () => {
      if (this.target === target) this.target = undefined
    }
  }
  navigate(panel: ProductPanelId): void {
    const target = this.target
    if (!target) throw new Error('The product navigation is not ready')
    if (panel !== null && !target.hasPanel(panel))
      throw new Error(`Unknown product panel: ${panel}`)
    this.navigation.abort()
    target.selectPanel(panel)
    this.publish(panel)
  }
  reconcile(panel: ProductPanelId): void {
    this.publish(panel)
  }
  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }
  cancel(): void {
    this.navigation.abort()
  }
  private publish(panel: ProductPanelId): void {
    if (this.panel === panel) return
    this.panel = panel
    for (const listener of this.listeners) listener()
  }
}
/** Shared with dynamic built-in clients through the static platform module table. */
export const productNavigation = new ProductNavigation()
